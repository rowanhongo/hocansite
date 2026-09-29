-- Business-development tables: scraped Nairobi job postings, the weekly
-- job-seeker lists cut from them, and the hiring-company leads derived from
-- them.
--
-- RLS is enabled with NO policies on every table here, which denies the anon
-- key outright. None of this is public: it is raw scraped market data plus our
-- own sales pipeline. Every read and write goes through
-- netlify/functions/leads-admin.js and apify-jobs-webhook.js using the service
-- role key, which bypasses RLS. That is the same indirection bio_links uses for
-- writes, tightened to cover reads as well.
--
-- Everything is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so it is safe to
-- re-run against the live database.

-- ── Scraped jobs ─────────────────────────────────────────────────────────────
-- One row per real-world job, not per scraped item. The same posting seen via
-- several sources collapses into one row whose `sources` array records each
-- sighting, so a job cannot be counted twice in an urgency score or shown twice
-- in a list.
create table if not exists public.scraped_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Dedupe key 1: the apply URL with tracking parameters stripped and the host
  -- lowercased. Unique, so a repeat sighting updates rather than inserts.
  canonical_url text not null,
  -- The URL as scraped, kept for debugging what the canonicaliser did.
  raw_url text,

  -- Dedupe key 2 (fallback): lower(company)|lower(title)|lower(location) with
  -- whitespace collapsed. Not unique — a company genuinely can run two
  -- identical-titled adverts — but it is what matches a repost that appeared at
  -- a brand new URL, which is the case canonical_url cannot catch.
  fallback_key text not null,

  title text not null,
  company text not null,
  location text,
  -- Apify `employmentType`, e.g. "Full-time".
  employment_type text,
  -- Apify `salaryText`, free text, often null.
  salary_text text,

  -- Absolute date resolved from the scraper's relative "3 days ago" against the
  -- run's scrape time. Null when the posting carried no date at all.
  posted_at timestamptz,
  -- The relative string exactly as scraped, so a bad conversion is auditable.
  posted_raw text,
  -- False when posted_at was derived from a relative string (accurate to the
  -- day at best) rather than given as an absolute date.
  posted_is_exact boolean not null default false,

  -- Every sighting of this job: [{via, applySource, applyUrl, runId, seenAt}].
  -- Appended to on each run, never overwritten, so "appearances across runs or
  -- sources" in the urgency score has real data behind it.
  sources jsonb not null default '[]'::jsonb,
  -- Distinct Apify run ids this job appeared in. Length drives the
  -- cross-run persistence signal.
  run_ids text[] not null default '{}',

  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),

  -- Apply-link liveness. 'unknown' before the first check, 'live' or 'dead'
  -- after. Re-checked when checked_at is older than the staleness window.
  link_status text not null default 'unknown',
  link_checked_at timestamptz,
  link_status_code integer,

  -- Deterministic exclusion, set at ingest by the rules in
  -- netlify/functions/lib/job-rules.js. Null means the job is eligible.
  -- Values: 'agency', 'confidential', 'non_kenya', 'competitor', 'too_old'.
  excluded_reason text,
  -- Gemini's second-pass verdict on borderline cases. Advisory only: it never
  -- silently drops a job, it flags it for review in the admin.
  ai_flagged boolean not null default false,
  ai_flag_reason text,

  -- Set when this job has gone out in a published job-seeker list. A featured
  -- job is never featured again, and neither is a repost matching its
  -- fallback_key.
  featured_in_list_id uuid,
  featured_at timestamptz,

  -- One-line neutral summary for the PDF. Never the full job description, and
  -- never anything about the recruiter.
  summary text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists scraped_jobs_canonical_url_key
  on public.scraped_jobs (canonical_url);
create index if not exists scraped_jobs_fallback_key_idx
  on public.scraped_jobs (fallback_key);
-- The one ordering every list uses: posted date desc, first_seen as tiebreak.
create index if not exists scraped_jobs_posted_idx
  on public.scraped_jobs (posted_at desc nulls last, first_seen desc);
create index if not exists scraped_jobs_company_idx
  on public.scraped_jobs (lower(company));
create index if not exists scraped_jobs_featured_idx
  on public.scraped_jobs (featured_in_list_id);

-- ── Weekly job-seeker lists ──────────────────────────────────────────────────
-- A published list is a frozen snapshot. The jobs table keeps changing as the
-- scraper runs, so an old PDF must be rebuildable from the snapshot alone and
-- never re-derived from live rows.
create table if not exists public.job_seeker_lists (
  id uuid primary key default gen_random_uuid(),
  -- Monday of the ISO week this list covers, for the "Week of …" PDF header.
  week_of date not null,
  title text not null default 'Latest Job Openings',
  -- Frozen copy of the rows as published: title, company, location, posted_at,
  -- source, apply_url, summary. Self-contained on purpose.
  items jsonb not null default '[]'::jsonb,
  item_count integer not null default 0,
  -- Jobs that were dropped and why, so a thin list is explicable.
  excluded_count integer not null default 0,
  dead_link_count integer not null default 0,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists job_seeker_lists_week_idx
  on public.job_seeker_lists (week_of desc, published_at desc);

-- ── Company leads ────────────────────────────────────────────────────────────
-- One row per hiring company, aggregated from scraped_jobs by a script. The
-- aggregate columns are derived and get recomputed on every ingest; the
-- workflow columns below them are ours and are never overwritten by a recompute.
create table if not exists public.company_leads (
  id uuid primary key default gen_random_uuid(),

  company text not null,
  -- lower(company) with whitespace/punctuation collapsed. Unique: this is what
  -- keeps "Acme Ltd" and "acme  ltd." from becoming two leads.
  company_key text not null,

  location text,
  industry text,
  company_size text,
  website text,

  -- [{title, count, newest_posted_at}] over deduped jobs only.
  roles jsonb not null default '[]'::jsonb,
  distinct_role_count integer not null default 0,
  total_job_count integer not null default 0,
  -- Highest count for any single title — the bulk-hiring signal.
  max_role_count integer not null default 0,
  repost_count integer not null default 0,
  has_hr_role boolean not null default false,
  seniority_tier integer not null default 0,
  newest_posted_at timestamptz,
  oldest_posted_at timestamptz,
  run_appearance_count integer not null default 1,
  sources text[] not null default '{}',

  -- Deterministic urgency, computed in JS by lib/urgency.js. 0-100.
  urgency_score numeric not null default 0,
  -- Per-signal breakdown so the number is explainable in the UI and a weight
  -- change is visibly traceable.
  urgency_breakdown jsonb not null default '{}'::jsonb,
  urgency_computed_at timestamptz,

  -- Gemini's review. Advisory, layered on top of the deterministic score.
  ai_fit_score integer,
  ai_reason text,
  ai_pitch_angle text,
  ai_reviewed_at timestamptz,
  -- 'pending' when a review is owed (new or changed jobs), 'done' when current,
  -- 'quota' when the free tier ran out mid-run and a resume is owed.
  ai_status text not null default 'pending',
  ai_error text,

  -- Workflow. Never touched by a recompute: a contacted company must not
  -- resurface as new.
  status text not null default 'new',
  notes text,
  last_reviewed_at timestamptz,
  status_changed_at timestamptz,

  -- Deterministic exclusion, same vocabulary as scraped_jobs.excluded_reason.
  excluded_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists company_leads_company_key_key
  on public.company_leads (company_key);
create index if not exists company_leads_urgency_idx
  on public.company_leads (urgency_score desc, newest_posted_at desc nulls last);
create index if not exists company_leads_status_idx
  on public.company_leads (status);

-- status is a small closed set; a typo'd value would silently vanish from every
-- filtered view, so the database rejects it instead.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'company_leads_status_check'
  ) then
    alter table public.company_leads
      add constraint company_leads_status_check
      check (status in ('new', 'contacted', 'replied', 'won', 'rejected'));
  end if;
end $$;

-- ── Ingest runs ──────────────────────────────────────────────────────────────
-- One row per Apify run we ingested. Gives the admin a truthful "last sync"
-- and makes a silent webhook failure visible instead of looking like a quiet week.
create table if not exists public.job_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  apify_run_id text,
  apify_dataset_id text,
  -- When the scrape happened. Relative dates ("3 days ago") are resolved
  -- against this, not against ingest time, which can be hours later.
  scraped_at timestamptz not null default now(),
  items_received integer not null default 0,
  jobs_inserted integer not null default 0,
  jobs_updated integer not null default 0,
  companies_touched integer not null default 0,
  -- The scraper's own totals, when the run reports them.
  reported_total_jobs integer,
  reported_total_companies integer,
  links_checked integer not null default 0,
  links_dead integer not null default 0,
  ai_reviewed integer not null default 0,
  ai_pending integer not null default 0,
  list_id uuid,
  status text not null default 'ok',
  error text,
  -- Apify fields we received but did not map, so a schema change on the actor's
  -- side surfaces in the admin rather than being dropped in silence.
  unmapped_fields text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists job_ingest_runs_created_idx
  on public.job_ingest_runs (created_at desc);

-- Unique on apify_run_id so a webhook retry updates its run row instead of
-- adding a second "last sync".
--
-- NOT a partial index (`where apify_run_id is not null`), even though that would
-- describe the intent more tightly: Postgres cannot use a partial index to infer
-- an ON CONFLICT target, so the upsert in lib/ingest.js failed with 42P10 and
-- every ingest threw after the data had already been written. A plain unique
-- index infers correctly, and NULLs are distinct in Postgres anyway, so manual
-- ingests with no run id can still insert freely.
create unique index if not exists job_ingest_runs_apify_run_key
  on public.job_ingest_runs (apify_run_id);

-- ── Settings (single row) ────────────────────────────────────────────────────
-- Urgency weights live in the database, not in code, because the whole point is
-- that they are tunable from the admin without a deploy.
create table if not exists public.bd_settings (
  id uuid primary key default gen_random_uuid(),
  urgency_weights jsonb not null default '{
    "distinct_roles": 25,
    "bulk_hiring": 15,
    "recency": 20,
    "reposts": 10,
    "hr_roles": 10,
    "seniority": 10,
    "persistence": 10
  }'::jsonb,
  -- Max age in days for a job to be eligible for a job-seeker list.
  max_job_age_days integer not null default 20,
  -- How long an apply-link check stays trusted before it is re-checked.
  link_recheck_days integer not null default 7,
  -- Editable so a wrongly-excluded company can be fixed without a deploy.
  agency_blocklist text[] not null default '{}',
  competitor_blocklist text[] not null default '{}',
  -- Fed to Gemini as the definition of what we sell. Editable so the pitch can
  -- be tuned without a code change.
  services_description text not null default
    'Hocan Holdings (Nairobi, Kenya, founded 2015) sells: HR consulting and workforce solutions (talent acquisition and recruitment, corporate training and professional development, labour outsourcing and managed workforce, HR360 full HR management, startup HR advisory); logistics (same-day and next-day delivery across Kenya and East Africa, real-time tracking, enterprise SLA-backed delivery, bulk shipments, scheduled pickups, multi-location workflows); and consultancy (HR, legal, food and beverage, tax management). Industries served: corporate, healthcare, hospitality, services, startups, government and NGOs.',
  updated_at timestamptz not null default now()
);

insert into public.bd_settings (id)
select gen_random_uuid()
where not exists (select 1 from public.bd_settings);

-- ── Lock everything down ─────────────────────────────────────────────────────
-- Enabled with no policies at all: the anon key gets nothing, not even reads.
alter table public.scraped_jobs enable row level security;
alter table public.job_seeker_lists enable row level security;
alter table public.company_leads enable row level security;
alter table public.job_ingest_runs enable row level security;
alter table public.bd_settings enable row level security;
