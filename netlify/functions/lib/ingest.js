// The ingest pipeline, shared by the Apify webhook and the admin's manual sync
// so both paths behave identically.
//
// Order of operations, and why:
//   1. normalise + dedupe the raw items      (cheap, pure, no network)
//   2. upsert jobs, merging sources          (must happen before anything counts)
//   3. check apply links                     (only the ones that are new or stale)
//   4. rebuild company aggregates + urgency  (deterministic, over deduped rows)
//   5. Gemini: flag, review, summarise       (last, so a quota stop loses nothing)
//   6. publish the weekly job-seeker list    (needs 3 and 5 to have run)
//
// A Gemini quota stop at step 5 leaves steps 1-4 fully committed and marks the
// remaining companies ai_status='quota', which the admin offers to resume. The
// list at step 6 still publishes, just without AI summaries.

const db = require("./supabase-rest");
const rules = require("./job-rules");
const urgency = require("./urgency");
const gemini = require("./gemini");
const links = require("./link-check");

const APIFY_BASE = "https://api.apify.com/v2";

// Fields we map from the actor's output. Anything outside this set is reported
// as unmapped so a schema change on Apify's side is visible instead of silent.
const KNOWN_FIELDS = new Set([
  "title", "company", "location", "via", "postedAt", "salaryText",
  "employmentType", "applySource", "applyUrl",
  // Commonly present and deliberately ignored.
  "id", "position", "thumbnail", "companyLogo", "scrapedAt", "searchQuery",
  "description", "descriptionHtml", "jobHighlights", "shareLink", "url", "link",
  // Seen in a real run of inovaflow/google-jobs-scraper. Listed so the admin's
  // "fields we do not store" notice stays meaningful: it should name genuinely
  // new fields, not the same known ones every week. Several are worth mapping
  // later (salaryMin/Max, ageDays, isRemote, atsUrl); none is needed for
  // de-duplication, ranking or the job-seeker list as they stand.
  "isRemote", "postedText", "ageDays", "salaryMin", "salaryMax", "salaryCurrency",
  "salaryPeriod", "benefits", "qualificationChip", "applyOptions",
  "directApplyAvailable", "atsUrl", "highlights", "googleUrl", "thumbnailUrl",
  "searchLocation", "searchVariant"
]);

function getApifyToken() {
  return (
    process.env.APIFY_API_Key ||
    process.env.APIFY_API_KEY ||
    process.env.APIFY_TOKEN ||
    ""
  ).trim();
}

async function loadSettings() {
  const rows = await db.select("bd_settings?select=*&limit=1");
  if (Array.isArray(rows) && rows.length) return rows[0];
  // The migration seeds one row; this is the belt-and-braces path.
  const created = await db.insert("bd_settings", [{}]);
  return (Array.isArray(created) && created[0]) || {};
}

// ── Apify ───────────────────────────────────────────────────────────────────

/* Fetch the items of a dataset.

   `clean=true` drops Apify's internal/empty records. Paged because a weekly
   Nairobi scrape can exceed the default page size and a truncated fetch would
   look like a quiet week. */
async function fetchDatasetItems(datasetId, token) {
  const items = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const url = `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=${limit}&offset=${offset}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Apify dataset fetch failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || !page.length) break;
    items.push(...page);
    if (page.length < limit) break;
    // Hard stop: something is wrong if a weekly Nairobi scrape exceeds this.
    if (items.length >= 20000) break;
  }
  return items;
}

async function fetchRunMeta(runId, token) {
  const res = await fetch(`${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  return payload?.data || null;
}

/* Find the most recent successful run of the actor, for the manual sync path.

   Uses the store's last-succeeded-run shortcut so we do not page a run history. */
async function fetchLastSuccessfulRun(actorId, token) {
  const id = encodeURIComponent(actorId).replace("%2F", "~");
  const res = await fetch(`${APIFY_BASE}/acts/${id}/runs/last?status=SUCCEEDED&token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Could not find a successful Apify run (${res.status}): ${text.slice(0, 200)}`);
  }
  const payload = await res.json().catch(() => null);
  return payload?.data || null;
}

// ── Step 1: normalise and dedupe ────────────────────────────────────────────

/* Turn raw Apify items into one record per real-world job.

   Two items collapse into one job when they share a canonical URL OR a fallback
   key. Every sighting is preserved in `sources`, so "the same job seen via
   several sources counts once but records every source" holds literally. */
function normalizeItems(items, scrapedAt, runId, settings) {
  const byCanonical = new Map();
  const byFallback = new Map();
  const unmapped = new Set();
  let skipped = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") { skipped += 1; continue; }

    for (const key of Object.keys(item)) {
      if (!KNOWN_FIELDS.has(key)) unmapped.add(key);
    }

    const title = String(item.title || "").trim();
    const company = String(item.company || "").trim();
    const applyUrl = String(item.applyUrl || item.url || item.link || item.shareLink || "").trim();

    // A job with no title, no company or no link cannot be deduped, ranked or
    // applied to, so it is not a job as far as this system is concerned.
    if (!title || !company || !applyUrl) { skipped += 1; continue; }

    const canonical = rules.canonicalizeUrl(applyUrl);
    if (!canonical) { skipped += 1; continue; }

    const location = String(item.location || "").trim();
    const fallback = rules.fallbackKey(company, title, location);
    const { postedAt, exact } = rules.resolvePostedAt(item.postedAt, scrapedAt);

    const sighting = {
      via: String(item.via || "").trim() || null,
      applySource: String(item.applySource || "").trim() || null,
      applyUrl,
      runId: runId || null,
      seenAt: (scrapedAt instanceof Date ? scrapedAt : new Date(scrapedAt)).toISOString()
    };

    // Dedupe: canonical URL wins; otherwise the fallback key catches the same
    // job seen at a different URL within this same batch.
    const existing = byCanonical.get(canonical) || byFallback.get(fallback);

    if (existing) {
      existing.sources.push(sighting);
      // Keep the most informative version of each optional field, and the
      // earliest known posted date (the first sighting is closest to the truth).
      if (!existing.location && location) existing.location = location;
      if (!existing.employment_type && item.employmentType) existing.employment_type = String(item.employmentType).trim();
      if (!existing.salary_text && item.salaryText) existing.salary_text = String(item.salaryText).trim();
      if (postedAt && (!existing.posted_at || postedAt < new Date(existing.posted_at))) {
        existing.posted_at = postedAt.toISOString();
        existing.posted_raw = String(item.postedAt || "").trim() || existing.posted_raw;
        existing.posted_is_exact = exact;
      }
      // Index this sighting's canonical URL at the same record, so a third
      // sighting via either key finds it.
      if (!byCanonical.has(canonical)) byCanonical.set(canonical, existing);
      continue;
    }

    const record = {
      canonical_url: canonical,
      raw_url: applyUrl,
      fallback_key: fallback,
      title,
      company,
      location: location || null,
      employment_type: String(item.employmentType || "").trim() || null,
      salary_text: String(item.salaryText || "").trim() || null,
      posted_at: postedAt ? postedAt.toISOString() : null,
      posted_raw: String(item.postedAt || "").trim() || null,
      posted_is_exact: exact,
      sources: [sighting],
      run_ids: runId ? [runId] : [],
      excluded_reason: rules.exclusionReason(
        { company, location, via: item.via, applySource: item.applySource },
        settings
      )
    };

    byCanonical.set(canonical, record);
    if (!byFallback.has(fallback)) byFallback.set(fallback, record);
  }

  // Deduplicate the values: one record can be indexed under several canonicals.
  const records = [...new Set(byCanonical.values())];
  return { records, unmapped: [...unmapped], skipped };
}

// ── Step 2: upsert, merging sources ─────────────────────────────────────────

/* Write the normalised records, merging into rows that already exist.

   A plain upsert would overwrite `sources`, `run_ids` and `first_seen`, losing
   exactly the history the urgency score depends on. So existing rows are read
   first and merged in memory. Done in chunks to stay inside URL-length and
   payload limits. */
async function upsertJobs(records, runId, scrapedAt) {
  if (!records.length) return { inserted: 0, updated: 0, rows: [] };

  const seenAt = (scrapedAt instanceof Date ? scrapedAt : new Date(scrapedAt)).toISOString();
  const chunkSize = 100;
  const rows = [];
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);

    // Read existing rows by canonical URL and by fallback key. The fallback
    // lookup is what recognises a repost at a new URL as the same job.
    const canonicals = chunk.map((r) => r.canonical_url);
    const fallbacks = [...new Set(chunk.map((r) => r.fallback_key))];

    const inList = (values) => `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;

    const [existingByUrl, existingByFallback] = await Promise.all([
      db.select(`scraped_jobs?select=*&canonical_url=in.${encodeURIComponent(inList(canonicals))}`),
      db.select(`scraped_jobs?select=*&fallback_key=in.${encodeURIComponent(inList(fallbacks))}`)
    ]);

    const urlMap = new Map((existingByUrl || []).map((r) => [r.canonical_url, r]));
    const fallbackMap = new Map();
    for (const row of existingByFallback || []) {
      // Keep the earliest-seen row per fallback key as the canonical survivor.
      const prev = fallbackMap.get(row.fallback_key);
      if (!prev || new Date(row.first_seen) < new Date(prev.first_seen)) {
        fallbackMap.set(row.fallback_key, row);
      }
    }

    const toUpsert = [];
    for (const record of chunk) {
      const existing = urlMap.get(record.canonical_url) || fallbackMap.get(record.fallback_key);

      if (!existing) {
        toUpsert.push({
          ...record,
          first_seen: seenAt,
          last_seen: seenAt,
          updated_at: new Date().toISOString()
        });
        inserted += 1;
        continue;
      }

      // Merge sightings, de-duplicated by applyUrl + runId so re-ingesting the
      // same dataset twice cannot inflate the source list.
      const existingSources = Array.isArray(existing.sources) ? existing.sources : [];
      const seenKeys = new Set(existingSources.map((s) => `${s.applyUrl}|${s.runId}`));
      const mergedSources = [...existingSources];
      for (const s of record.sources) {
        const key = `${s.applyUrl}|${s.runId}`;
        if (!seenKeys.has(key)) { mergedSources.push(s); seenKeys.add(key); }
      }

      const mergedRunIds = [...new Set([...(existing.run_ids || []), ...(record.run_ids || [])])];

      // Matched on fallback key at a NEW url: this is a repost. Keep the
      // original row and its featured history — the whole point is that a
      // repost must not be featured a second time — but record the new url as a
      // source so the repost signal can see it.
      const isRepost = !urlMap.has(record.canonical_url);

      toUpsert.push({
        // Keep the row's identity and its canonical_url: changing the latter
        // would break the unique index match and orphan the featured history.
        canonical_url: existing.canonical_url,
        /* Recomputed, never carried over. The fallback key is derived from the
           company/title/location rules, so pinning it to whatever those rules
           produced on the day the row was first seen means a later improvement
           to them can never reach existing rows. That is what kept "Careers at
           Marriott" and "Marriott" as two separate jobs after companyKey learned
           to strip job-board prefixes: both new keys agreed, but the stored ones
           still did not. */
        fallback_key: record.fallback_key,
        title: existing.title || record.title,
        company: existing.company || record.company,
        location: existing.location || record.location,
        employment_type: existing.employment_type || record.employment_type,
        salary_text: existing.salary_text || record.salary_text,
        // Keep the earliest known posted date: a repost's "2 days ago" must not
        // make an old vacancy look new.
        posted_at: existing.posted_at || record.posted_at,
        posted_raw: existing.posted_raw || record.posted_raw,
        posted_is_exact: existing.posted_is_exact || record.posted_is_exact,
        sources: mergedSources,
        run_ids: mergedRunIds,
        first_seen: existing.first_seen,
        last_seen: seenAt,
        // Re-evaluated each run so an edited blocklist takes effect.
        excluded_reason: record.excluded_reason,
        // Preserve everything the pipeline or the user owns.
        link_status: isRepost ? "unknown" : existing.link_status,
        link_checked_at: isRepost ? null : existing.link_checked_at,
        link_status_code: isRepost ? null : existing.link_status_code,
        featured_in_list_id: existing.featured_in_list_id,
        featured_at: existing.featured_at,
        summary: existing.summary,
        ai_flagged: existing.ai_flagged,
        ai_flag_reason: existing.ai_flag_reason,
        updated_at: new Date().toISOString()
      });
      updated += 1;
    }

    const written = await db.upsert("scraped_jobs", toUpsert, "canonical_url");
    if (Array.isArray(written)) rows.push(...written);
  }

  return { inserted, updated, rows };
}

// ── Step 3: link checking ───────────────────────────────────────────────────

/* Verify apply links for the jobs that could plausibly enter a list.

   Scoped deliberately: eligible, recent, not-yet-featured jobs whose check is
   missing or stale. Checking the whole table every run would be thousands of
   requests for rows nobody will ever see. */
async function checkJobLinks(settings, limit = 400) {
  const maxAge = Number(settings.max_job_age_days || 20);
  const recheckDays = Number(settings.link_recheck_days || 7);
  const cutoff = new Date(Date.now() - maxAge * rules.MS_PER_DAY).toISOString();
  const staleBefore = new Date(Date.now() - recheckDays * rules.MS_PER_DAY).toISOString();

  /* Two independent OR groups: "recent or undated" AND "never checked or stale".

     They have to be nested inside a single `and=(...)`, because PostgREST keeps
     only one `or=` parameter per level — passing two silently drops one of them,
     which here would have meant re-checking every link on every run or checking
     none of the undated ones. */
  const recentOrUndated = `or(posted_at.gte.${cutoff},posted_at.is.null)`;
  const uncheckedOrStale = `or(link_checked_at.is.null,link_checked_at.lt.${staleBefore})`;

  const candidates = await db.select(
    "scraped_jobs?select=id,canonical_url,raw_url,link_checked_at" +
      "&excluded_reason=is.null" +
      "&featured_in_list_id=is.null" +
      `&and=(${recentOrUndated},${uncheckedOrStale})` +
      "&order=posted_at.desc.nullslast,first_seen.desc" +
      `&limit=${limit}`
  );

  if (!Array.isArray(candidates) || !candidates.length) {
    return { checked: 0, dead: 0 };
  }

  const results = await links.checkMany(
    candidates.map((c) => ({ id: c.id, url: c.raw_url || c.canonical_url })),
    links.DEFAULT_CONCURRENCY
  );

  let dead = 0;
  const now = new Date().toISOString();
  // Patch one at a time: PostgREST has no multi-row update-by-id, and an upsert
  // here would need every column of every row.
  const chunk = 12;
  for (let i = 0; i < results.length; i += chunk) {
    await Promise.all(
      results.slice(i, i + chunk).map((r) => {
        if (r.status === "dead") dead += 1;
        return db.update(`scraped_jobs?id=eq.${encodeURIComponent(r.id)}`, {
          link_status: r.status,
          link_checked_at: now,
          link_status_code: r.code ?? null
        }).catch(() => null);
      })
    );
  }

  return { checked: results.length, dead };
}

// ── Step 4: company aggregates and urgency ──────────────────────────────────

/* Rebuild company_leads from scraped_jobs.

   Derived columns are recomputed wholesale; workflow columns (status, notes,
   last_reviewed_at) are read first and written back untouched, which is what
   guarantees a contacted company never resurfaces as new.

   Only companies touched by this run are recomputed — recomputing every company
   every week would grow linearly with the table for no benefit. */
/* Recompute stored fallback keys that the current rules would produce
   differently.

   upsertJobs looks existing rows up *by* fallback_key, so a row written under
   older rules is invisible to the very lookup that would have refreshed it — the
   key it is stored under is not the key we now search for. That left "Careers at
   Marriott" and "Marriott" as two eligible copies of one vacancy even after
   companyKey learned to strip job-board prefixes, because neither row was ever
   found to be updated.

   So the keys are refreshed directly, by id, before anything reads them. Cheap
   and idempotent: it pages the table, recomputes, and writes back only the rows
   that actually changed, so a steady state costs one read per page and no
   writes at all. */
async function backfillFallbackKeys() {
  const pageSize = 500;
  let updated = 0;

  for (let offset = 0; ; offset += pageSize) {
    const rows = await db.select(
      `scraped_jobs?select=id,company,title,location,fallback_key&order=first_seen.asc&limit=${pageSize}&offset=${offset}`
    );
    if (!Array.isArray(rows) || !rows.length) break;

    const stale = rows
      .map((row) => ({ row, key: rules.fallbackKey(row.company, row.title, row.location) }))
      .filter(({ row, key }) => key && key !== row.fallback_key);

    for (let i = 0; i < stale.length; i += 10) {
      await Promise.all(
        stale.slice(i, i + 10).map(({ row, key }) =>
          db
            .update(`scraped_jobs?id=eq.${encodeURIComponent(row.id)}`, { fallback_key: key })
            .then(() => { updated += 1; })
            .catch(() => null)
        )
      );
    }

    if (rows.length < pageSize) break;
  }

  return { updated };
}

async function rebuildCompanies(companyKeys, settings) {
  const keys = [...new Set((companyKeys || []).filter(Boolean))];
  if (!keys.length) return { touched: 0, pendingIds: [] };

  const weights = settings.urgency_weights || urgency.DEFAULT_WEIGHTS;
  const now = new Date();
  const pendingIds = [];
  let touched = 0;

  // company_key is not a column on scraped_jobs (the same employer's name
  // varies between sightings), so grouping has to happen in memory with the
  // same key function the leads table uses. Paged once here rather than per
  // chunk: the previous shape refetched the whole table for every 40 keys.
  const keySet = new Set(keys);
  const grouped = new Map();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await db.select(
      "scraped_jobs?select=id,title,company,location,posted_at,canonical_url,run_ids,sources,excluded_reason" +
        `&order=first_seen.asc&limit=${pageSize}&offset=${offset}`
    );
    if (!Array.isArray(page) || !page.length) break;
    for (const job of page) {
      const key = rules.companyKey(job.company);
      if (!keySet.has(key)) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(job);
    }
    if (page.length < pageSize) break;
  }

  const groupedKeys = [...grouped.keys()];
  const chunkSize = 40;
  for (let i = 0; i < groupedKeys.length; i += chunkSize) {
    const chunk = groupedKeys.slice(i, i + chunkSize);

    const inList = (values) => `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;
    const existingRows = await db.select(
      `company_leads?select=*&company_key=in.${encodeURIComponent(inList(chunk))}`
    );
    const existingMap = new Map((existingRows || []).map((r) => [r.company_key, r]));

    const payload = [];
    for (const key of chunk) {
      const companyJobs = grouped.get(key) || [];
      if (!companyJobs.length) continue;
      const existing = existingMap.get(key);
      const aggregate = urgency.aggregateCompany(companyJobs, now);
      const { score, breakdown } = urgency.scoreCompany(aggregate, weights);

      // The company is excluded if every one of its jobs was excluded, and we
      // report the most common reason.
      const reasons = companyJobs.map((j) => j.excluded_reason).filter(Boolean);
      const allExcluded = reasons.length === companyJobs.length && companyJobs.length > 0;
      const excludedReason = allExcluded ? reasons[0] : null;

      // Re-review when the job set changed since the last AI pass. Comparing
      // counts is enough: any new or removed posting moves one of them.
      const jobsChanged =
        !existing ||
        existing.total_job_count !== aggregate.total_job_count ||
        existing.distinct_role_count !== aggregate.distinct_role_count ||
        existing.newest_posted_at !== aggregate.newest_posted_at;

      const aiStatus = excludedReason
        ? "done"
        : jobsChanged
        ? "pending"
        : existing?.ai_status || "pending";

      payload.push({
        company_key: key,
        company: companyJobs[0].company,
        location: aggregate.roles.length ? (companyJobs[0].location || null) : null,
        roles: aggregate.roles,
        distinct_role_count: aggregate.distinct_role_count,
        total_job_count: aggregate.total_job_count,
        max_role_count: aggregate.max_role_count,
        repost_count: aggregate.repost_count,
        has_hr_role: aggregate.has_hr_role,
        seniority_tier: aggregate.seniority_tier,
        newest_posted_at: aggregate.newest_posted_at,
        oldest_posted_at: aggregate.oldest_posted_at,
        run_appearance_count: aggregate.run_appearance_count,
        sources: aggregate.sources,
        urgency_score: score,
        urgency_breakdown: breakdown,
        urgency_computed_at: now.toISOString(),
        excluded_reason: excludedReason,

        // Preserved across recomputes — never derived.
        industry: existing?.industry || null,
        company_size: existing?.company_size || null,
        website: existing?.website || null,
        ai_fit_score: jobsChanged ? existing?.ai_fit_score ?? null : existing?.ai_fit_score ?? null,
        ai_reason: existing?.ai_reason || null,
        ai_pitch_angle: existing?.ai_pitch_angle || null,
        ai_reviewed_at: existing?.ai_reviewed_at || null,
        ai_status: aiStatus,
        ai_error: existing?.ai_error || null,
        status: existing?.status || "new",
        notes: existing?.notes || null,
        last_reviewed_at: existing?.last_reviewed_at || null,
        status_changed_at: existing?.status_changed_at || null,
        created_at: existing?.created_at || now.toISOString(),
        updated_at: now.toISOString()
      });
    }

    const written = await db.upsert("company_leads", payload, "company_key");
    touched += payload.length;
    for (const row of written || []) {
      if (row.ai_status === "pending" && !row.excluded_reason) pendingIds.push(row.id);
    }
  }

  return { touched, pendingIds };
}

/* Recompute urgency for every company without re-reading their jobs' AI state.

   Used when the weights change: the aggregates are already stored, so the score
   is a pure function of them and nothing needs re-scraping or re-reviewing. */
async function rescoreAllCompanies(settings) {
  const weights = settings.urgency_weights || urgency.DEFAULT_WEIGHTS;
  const now = new Date().toISOString();
  let updated = 0;
  const pageSize = 200;

  for (let offset = 0; ; offset += pageSize) {
    const rows = await db.select(
      "company_leads?select=id,distinct_role_count,total_job_count,max_role_count,repost_count," +
        "has_hr_role,seniority_tier,newest_posted_at,run_appearance_count" +
        `&order=created_at.asc&limit=${pageSize}&offset=${offset}`
    );
    if (!Array.isArray(rows) || !rows.length) break;

    await Promise.all(
      rows.map((row) => {
        const daysSinceNewest = row.newest_posted_at
          ? Math.max(0, (Date.now() - new Date(row.newest_posted_at).getTime()) / rules.MS_PER_DAY)
          : null;
        const { score, breakdown } = urgency.scoreCompany({ ...row, days_since_newest: daysSinceNewest }, weights);
        updated += 1;
        return db.update(`company_leads?id=eq.${encodeURIComponent(row.id)}`, {
          urgency_score: score,
          urgency_breakdown: breakdown,
          urgency_computed_at: now
        }).catch(() => null);
      })
    );

    if (rows.length < pageSize) break;
  }

  return { updated };
}

// ── Step 5: Gemini passes ───────────────────────────────────────────────────

/* Flag borderline exclusions the keyword rules missed.

   Advisory: sets ai_flagged for admin review, never excludes. Scoped to
   recent, eligible, unfeatured jobs — the only ones a list could draw from. */
async function runBorderlineFlagging(settings, state) {
  if (!gemini.isConfigured()) return { flagged: 0, quota: false, skipped: "no-key" };

  const maxAge = Number(settings.max_job_age_days || 20);
  const cutoff = new Date(Date.now() - maxAge * rules.MS_PER_DAY).toISOString();

  // `via` is not a column — each sighting's board name lives inside the
  // `sources` jsonb array, because one job can be seen through several boards.
  // Selecting it directly failed the whole ingest with 42703.
  const jobs = await db.select(
    "scraped_jobs?select=id,title,company,location,sources,employment_type" +
      "&excluded_reason=is.null&featured_in_list_id=is.null&ai_flagged=is.false" +
      `&or=(posted_at.gte.${cutoff},posted_at.is.null)` +
      "&order=first_seen.desc&limit=200"
  );
  if (!Array.isArray(jobs) || !jobs.length) return { flagged: 0, quota: false };

  let flagged = 0;
  let quota = false;
  // Four short fields per job, so a large batch costs little and saves calls,
  // which are the scarce resource on the free tier.
  const batchSize = 120;

  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize).map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      // Distinct board names across every sighting of this job.
      via: [...new Set((Array.isArray(j.sources) ? j.sources : [])
        .map((s) => s.via || s.applySource)
        .filter(Boolean))].join(", ") || null
    }));

    const result = await gemini.flagBorderlineJobs(batch, state);
    if (result.quota) { quota = true; break; }

    for (const flag of result.flags) {
      await db.update(`scraped_jobs?id=eq.${encodeURIComponent(flag.job_id)}`, {
        ai_flagged: true,
        ai_flag_reason: `${flag.reason_code}: ${flag.note}`.slice(0, 300)
      }).catch(() => null);
      flagged += 1;
    }
  }

  return { flagged, quota };
}

/* Score companies for fit. Resumable: only ai_status in (pending, quota). */
async function runCompanyReview(settings, state, limit = 120) {
  if (!gemini.isConfigured()) return { reviewed: 0, pending: 0, quota: false, skipped: "no-key" };

  const companies = await db.select(
    "company_leads?select=id,company,location,roles,total_job_count,distinct_role_count,max_role_count," +
      "repost_count,has_hr_role,seniority_tier,sources,industry,company_size" +
      "&excluded_reason=is.null&ai_status=in.(pending,quota)" +
      `&order=urgency_score.desc&limit=${limit}`
  );
  if (!Array.isArray(companies) || !companies.length) return { reviewed: 0, pending: 0, quota: false };

  const servicesDescription = settings.services_description || "";
  let reviewed = 0;
  let quota = false;
  let quotaMessage = "Gemini quota reached. Resume the review to finish.";
  /* Deliberately large. A real free-tier project turned out to allow only 20
     requests per DAY for this model, so the binding constraint is the number of
     calls, not the size of each one. Each company contributes just its name,
     location and a list of role titles with counts, so sixty of them is still a
     modest prompt — and it is one request instead of three. */
  const batchSize = 60;
  const reviewedIds = new Set();

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    const payload = batch.map((c) => ({
      id: c.id,
      company: c.company,
      location: c.location || "unknown",
      // Titles and counts only. No descriptions, no contact data.
      roles: (c.roles || []).map((r) => ({ title: r.title, count: r.count })),
      total_openings: c.total_job_count,
      distinct_roles: c.distinct_role_count,
      largest_single_role_count: c.max_role_count,
      reposted_roles: c.repost_count,
      hiring_hr_roles: c.has_hr_role,
      job_boards: c.sources || []
    }));

    const result = await gemini.reviewCompanies(payload, servicesDescription, state);
    // Keep Gemini's own words. Overwriting them with a generic "quota reached"
    // hid a real cause once and cost a long debugging detour.
    if (result.quota) { quota = true; quotaMessage = result.error || quotaMessage; break; }

    const now = new Date().toISOString();
    for (const review of result.reviews) {
      const patch = {
        ai_fit_score: review.fit_score,
        ai_reason: review.reason,
        ai_pitch_angle: review.reject ? null : review.pitch_angle,
        ai_reviewed_at: now,
        ai_status: "done",
        ai_error: null
      };
      // "unknown" is a real answer here, so only overwrite with a real value.
      if (review.industry && review.industry !== "unknown") patch.industry = review.industry;
      if (review.company_size && review.company_size !== "unknown") patch.company_size = review.company_size;
      // The AI may reject what the keyword rules let through. Recorded as an
      // exclusion so it stops appearing as a live lead, with the reason visible.
      if (review.reject && review.reject_reason !== "none") patch.excluded_reason = review.reject_reason;

      await db.update(`company_leads?id=eq.${encodeURIComponent(review.company_id)}`, patch).catch(() => null);
      reviewedIds.add(String(review.company_id));
      reviewed += 1;
    }

    // A company in the batch the model silently dropped must not sit in
    // 'pending' forever, or it would be re-sent on every run.
    for (const c of batch) {
      if (!reviewedIds.has(String(c.id))) {
        await db.update(`company_leads?id=eq.${encodeURIComponent(c.id)}`, {
          ai_status: "done",
          ai_error: "No review returned for this company.",
          ai_reviewed_at: new Date().toISOString()
        }).catch(() => null);
      }
    }
  }

  // Anything not reached is marked resumable, so the admin can finish the job
  // rather than leaving companies permanently unscored.
  let pending = 0;
  if (quota) {
    const remaining = companies.filter((c) => !reviewedIds.has(String(c.id)));
    pending = remaining.length;
    for (const c of remaining) {
      await db.update(`company_leads?id=eq.${encodeURIComponent(c.id)}`, {
        ai_status: "quota",
        ai_error: String(quotaMessage).slice(0, 400)
      }).catch(() => null);
    }
  }

  return { reviewed, pending, quota, quotaMessage };
}

// ── Step 6: publish the weekly job-seeker list ──────────────────────────────

// Monday of the ISO week containing `date`, as YYYY-MM-DD.
function isoWeekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Sunday = 7, so the week starts Monday
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

/* Select the jobs eligible for a job-seeker list.

   Exclusions, in the order the brief gives them: agencies and hidden employers
   (already in excluded_reason), jobs older than the age limit, dead apply links,
   and anything already featured. The repost case is handled twice over: the
   fallback-key query catches a repost of a featured job, and Gemini catches a
   reworded one. */
async function selectListCandidates(settings, state) {
  const maxAge = Number(settings.max_job_age_days || 20);
  const cutoff = new Date(Date.now() - maxAge * rules.MS_PER_DAY).toISOString();

  // Ordering is the one rule every list obeys: posted date desc, first_seen as
  // the tiebreak.
  let candidates = await db.select(
    "scraped_jobs?select=id,title,company,location,posted_at,posted_is_exact,first_seen,sources," +
      "canonical_url,raw_url,summary,employment_type,fallback_key,link_status,ai_flagged" +
      "&excluded_reason=is.null" +
      "&featured_in_list_id=is.null" +
      "&link_status=eq.live" +
      `&posted_at=gte.${cutoff}` +
      "&order=posted_at.desc.nullslast,first_seen.desc" +
      "&limit=300"
  );

  if (!Array.isArray(candidates) || !candidates.length) {
    return { items: [], stats: { candidates: 0, dropped_featured: 0, dropped_ai_repost: 0, flagged: 0 }, quota: false };
  }

  /* Collapse duplicates *within* this batch first.

     Two rows can share a fallback key and still both be unfeatured — the same
     vacancy listed by "Marriott" and by "Careers at Marriott" at different URLs,
     for instance. The featured-history check below only compares against past
     lists, so without this the same job went out twice in one PDF. Candidates
     arrive already sorted newest-first, so the first sighting of a key is the
     one worth keeping. */
  const seenKeys = new Set();
  let collapsedDuplicates = 0;
  candidates = candidates.filter((c) => {
    if (seenKeys.has(c.fallback_key)) { collapsedDuplicates += 1; return false; }
    seenKeys.add(c.fallback_key);
    return true;
  });

  // Deterministic repost check: has any job with this fallback key already been
  // featured? This is the "reposted at a new URL" case.
  const fallbackKeys = [...new Set(candidates.map((c) => c.fallback_key))];
  const inList = (values) => `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;
  const alreadyFeatured = await db.select(
    `scraped_jobs?select=id,title,company,location,fallback_key,featured_at` +
      `&featured_in_list_id=not.is.null&fallback_key=in.${encodeURIComponent(inList(fallbackKeys))}`
  );
  const featuredKeys = new Set((alreadyFeatured || []).map((r) => r.fallback_key));

  let droppedFeatured = 0;
  let eligible = candidates.filter((c) => {
    if (featuredKeys.has(c.fallback_key)) { droppedFeatured += 1; return false; }
    return true;
  });

  // A flagged job is held back from the list but not deleted: the admin reviews
  // it. Silently shipping a suspected agency post is worse than a shorter list.
  const flagged = eligible.filter((c) => c.ai_flagged).length;
  eligible = eligible.filter((c) => !c.ai_flagged);

  // Fuzzy repost check: same company, reworded title. Only the companies that
  // appear in both sets are worth sending, which keeps the prompt small.
  let droppedAiRepost = 0;
  let quota = false;
  if (eligible.length && gemini.isConfigured()) {
    const eligibleCompanies = new Set(eligible.map((c) => rules.companyKey(c.company)));
    const featuredForCompanies = await db.select(
      "scraped_jobs?select=id,title,company,location,featured_at" +
        "&featured_in_list_id=not.is.null&order=featured_at.desc&limit=400"
    );
    const relevantFeatured = (featuredForCompanies || []).filter((f) =>
      eligibleCompanies.has(rules.companyKey(f.company))
    );

    if (relevantFeatured.length) {
      const suppress = new Set();
      const batchSize = 100;
      for (let i = 0; i < eligible.length; i += batchSize) {
        const batch = eligible.slice(i, i + batchSize);
        const result = await gemini.matchReposts(
          batch.map((c) => ({ id: c.id, title: c.title, company: c.company, location: c.location })),
          relevantFeatured.slice(0, 60).map((f) => ({ id: f.id, title: f.title, company: f.company, location: f.location })),
          state
        );
        if (result.quota) { quota = true; break; }
        // Only high confidence suppresses: a medium-confidence false positive
        // would permanently hide a genuinely new vacancy.
        for (const m of result.matches) {
          if (m.confidence === "high") suppress.add(String(m.candidate_id));
        }
      }
      droppedAiRepost = suppress.size;
      eligible = eligible.filter((c) => !suppress.has(String(c.id)));
    }
  }

  return {
    items: eligible,
    stats: {
      candidates: candidates.length + collapsedDuplicates,
      collapsed_duplicates: collapsedDuplicates,
      dropped_featured: droppedFeatured,
      dropped_ai_repost: droppedAiRepost,
      flagged
    },
    quota
  };
}

/* Freeze the selected jobs into a list row and mark them featured.

   The snapshot is self-contained so an old PDF regenerates identically even
   after the jobs table has moved on. Marking featured is the irreversible part,
   so it happens only after the snapshot is safely written. */
async function publishList(candidates, stats, settings, title) {
  const now = new Date();
  const items = candidates.map((c) => {
    const sources = Array.isArray(c.sources) ? c.sources : [];
    const via = [...new Set(sources.map((s) => s.via || s.applySource).filter(Boolean))];
    return {
      id: c.id,
      title: c.title,
      company: c.company,
      location: c.location || "",
      posted_at: c.posted_at,
      posted_is_exact: Boolean(c.posted_is_exact),
      // Every source that saw this job, so the row is honest about provenance.
      source: via.join(", ") || "—",
      apply_url: c.raw_url || c.canonical_url,
      employment_type: c.employment_type || "",
      summary: c.summary || ""
    };
  });

  const created = await db.insert("job_seeker_lists", [
    {
      week_of: isoWeekStart(now),
      title: title || "Latest Job Openings",
      items,
      item_count: items.length,
      excluded_count: (stats.dropped_featured || 0) + (stats.dropped_ai_repost || 0) + (stats.flagged || 0),
      dead_link_count: stats.dead_links || 0,
      published_at: now.toISOString()
    }
  ]);

  const list = Array.isArray(created) ? created[0] : created;
  if (!list?.id) throw new Error("Could not create the job-seeker list.");

  // Mark featured only now. A crash before this point costs a list row, which
  // is recoverable; a crash after marking would burn the jobs with no list.
  const chunk = 25;
  for (let i = 0; i < candidates.length; i += chunk) {
    await Promise.all(
      candidates.slice(i, i + chunk).map((c) =>
        db.update(`scraped_jobs?id=eq.${encodeURIComponent(c.id)}`, {
          featured_in_list_id: list.id,
          featured_at: now.toISOString()
        }).catch(() => null)
      )
    );
  }

  // Keep 4 lists: the current week plus three back. Older snapshots are pruned,
  // but the jobs stay marked featured so they can never be re-featured.
  await pruneOldLists();

  return list;
}

async function pruneOldLists(keep = 4) {
  const lists = await db.select("job_seeker_lists?select=id&order=published_at.desc&limit=50");
  if (!Array.isArray(lists) || lists.length <= keep) return 0;
  const doomed = lists.slice(keep);
  for (const list of doomed) {
    await db.remove(`job_seeker_lists?id=eq.${encodeURIComponent(list.id)}`).catch(() => null);
  }
  return doomed.length;
}

/* Write one-line summaries for the jobs about to be published. */
async function summarizeForList(candidates, state) {
  if (!gemini.isConfigured() || !candidates.length) return { summarized: 0, quota: false };

  const needed = candidates.filter((c) => !c.summary).slice(0, 120);
  if (!needed.length) return { summarized: 0, quota: false };

  let summarized = 0;
  let quota = false;
  const batchSize = 100;

  for (let i = 0; i < needed.length; i += batchSize) {
    const batch = needed.slice(i, i + batchSize);
    const result = await gemini.summarizeJobs(
      batch.map((c) => ({
        id: c.id,
        title: c.title,
        company: c.company,
        location: c.location,
        employment_type: c.employment_type
      })),
      state
    );
    if (result.quota) { quota = true; break; }

    for (const s of result.summaries) {
      if (!s.summary) continue;
      await db.update(`scraped_jobs?id=eq.${encodeURIComponent(s.job_id)}`, { summary: s.summary }).catch(() => null);
      // Reflect it on the in-memory candidate so the snapshot carries it.
      const target = candidates.find((c) => String(c.id) === String(s.job_id));
      if (target) target.summary = s.summary;
      summarized += 1;
    }
  }

  return { summarized, quota };
}

// ── The whole pipeline ──────────────────────────────────────────────────────

/* Run every step for one Apify dataset.

   `publish` controls step 6. The weekly webhook publishes automatically; a
   manual re-sync can be run with publish=false to refresh data without cutting
   a new list. */
async function ingestDataset({ datasetId, runId, scrapedAt, publish = true, reportedTotals = {} }) {
  const token = getApifyToken();
  if (!token) throw new Error("Apify API token is not configured (APIFY_API_Key).");

  const settings = await loadSettings();
  const state = gemini.newState();
  const startedAt = new Date();
  const scrapeTime = scrapedAt ? new Date(scrapedAt) : startedAt;

  const items = await fetchDatasetItems(datasetId, token);

  /* Before anything looks a job up by its fallback key, make sure the stored
     keys are the ones the current rules produce. Otherwise a row written under
     older rules stays invisible to the lookup that would fix it. */
  const backfill = await backfillFallbackKeys().catch(() => ({ updated: 0 }));

  const { records, unmapped, skipped } = normalizeItems(items, scrapeTime, runId, settings);
  const { inserted, updated, rows } = await upsertJobs(records, runId, scrapeTime);

  const linkResult = await checkJobLinks(settings);

  const companyKeys = records.map((r) => rules.companyKey(r.company));
  const companyResult = await rebuildCompanies(companyKeys, settings);

  /* Everything from here on is AI enrichment, and none of it may fail the
     ingest. The jobs, companies and urgency ranks are already committed and are
     useful on their own; Gemini being down, rate-limited or pointed at a retired
     model is a reason to ship a list without fit scores, not a reason to throw
     away a completed scrape. A 503 from Google was doing exactly that. */
  const aiErrors = [];
  const tryAi = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      aiErrors.push(`${label}: ${String(error.message || error).slice(0, 160)}`);
      return fallback;
    }
  };

  /* Order matters, because the daily allowance is small and the passes are not
     equally valuable. The list goes out to job seekers, so it is built first and
     its reposts checked first; company fit scores come next; the optional
     one-line summaries and the borderline-agency flagging come last, since a
     list is perfectly usable without either. Whatever the quota runs out on,
     it runs out on the least important thing. */
  let list = null;
  let listStats = { candidates: 0, dropped_featured: 0, dropped_ai_repost: 0, flagged: 0 };
  let summaryResult = { summarized: 0, quota: false };

  if (publish) {
    /* The AI repost check lives inside this, but the deterministic fallback-key
       match does too — and that one catches the ordinary repost. So a failure
       here must still yield a list. selectListCandidates already swallows its
       own Gemini errors, and this second net covers anything else: without it a
       thrown error skipped publishList entirely and the week produced nothing. */
    const selection = await tryAi(
      "list selection",
      () => selectListCandidates(settings, state),
      { items: [], stats: listStats, quota: false }
    );
    listStats = { ...selection.stats, dead_links: linkResult.dead };
    if (selection.items.length) {
      summaryResult = await tryAi("summaries", () => summarizeForList(selection.items, state), { summarized: 0, quota: false });
      // Publishes whether or not the summaries landed: a row without a one-line
      // description is still a job someone can apply for.
      list = await publishList(selection.items, listStats, settings, null);
    }
  }

  const reviewResult = await tryAi("review", () => runCompanyReview(settings, state), { reviewed: 0, pending: 0, quota: false });
  const flagResult = await tryAi("flagging", () => runBorderlineFlagging(settings, state), { flagged: 0, quota: false });

  const aiQuotaHit = Boolean(flagResult.quota || reviewResult.quota || summaryResult.quota);

  const runRow = {
    apify_run_id: runId || null,
    apify_dataset_id: datasetId,
    scraped_at: scrapeTime.toISOString(),
    items_received: items.length,
    jobs_inserted: inserted,
    jobs_updated: updated,
    companies_touched: companyResult.touched,
    reported_total_jobs: Number.isFinite(Number(reportedTotals.totalJobs)) ? Number(reportedTotals.totalJobs) : items.length,
    reported_total_companies: Number.isFinite(Number(reportedTotals.totalCompanies))
      ? Number(reportedTotals.totalCompanies)
      : new Set(records.map((r) => rules.companyKey(r.company))).size,
    links_checked: linkResult.checked,
    links_dead: linkResult.dead,
    ai_reviewed: reviewResult.reviewed,
    ai_pending: reviewResult.pending,
    list_id: list?.id || null,
    // A run that ingested cleanly but could not reach Gemini is 'ai_failed', not
    // 'ok' and not 'error': the data is trustworthy, the enrichment is missing,
    // and the admin should say so rather than show a silently score-less table.
    status: aiQuotaHit ? "ai_quota" : aiErrors.length ? "ai_failed" : "ok",
    error: aiQuotaHit
      ? "Gemini free-tier quota reached; AI review is incomplete and can be resumed."
      : aiErrors.length
      ? `Jobs and rankings ingested normally, but AI enrichment failed — ${aiErrors.join("; ")}`
      : null,
    unmapped_fields: unmapped
  };

  /* Record the run.

     Upsert on run id so a webhook retry updates the record rather than adding a
     duplicate "last sync" row.

     This is history, not data: by the time we get here the jobs, companies and
     list are already committed. So a failure to write it must never fail the
     ingest — it did once, when the unique index this infers was still partial
     (Postgres cannot infer ON CONFLICT from a partial index), and the result was
     a completed ingest reported to the operator as a hard error. Falling back to
     a plain insert keeps the history usable even if the index is wrong, and a
     total failure is swallowed with the run left unrecorded. */
  let savedRun = null;
  try {
    savedRun = runId
      ? await db.upsert("job_ingest_runs", [runRow], "apify_run_id")
      : await db.insert("job_ingest_runs", [runRow]);
  } catch (error) {
    try {
      savedRun = await db.insert("job_ingest_runs", [runRow]);
    } catch (_e) {
      savedRun = null;
    }
  }

  return {
    run: Array.isArray(savedRun) ? savedRun[0] : savedRun,
    itemsReceived: items.length,
    skipped,
    inserted,
    updated,
    keysBackfilled: backfill.updated,
    unmapped,
    links: linkResult,
    companies: companyResult,
    flagged: flagResult.flagged,
    reviewed: reviewResult.reviewed,
    aiPending: reviewResult.pending,
    aiQuotaHit,
    // Non-empty when the ingest succeeded but AI enrichment did not, so the
    // caller can report a degraded run instead of an apparently perfect one.
    aiErrors,
    list,
    listStats,
    summarized: summaryResult.summarized,
    geminiCalls: state.calls
  };
}

module.exports = {
  loadSettings,
  backfillFallbackKeys,
  fetchDatasetItems,
  fetchRunMeta,
  fetchLastSuccessfulRun,
  getApifyToken,
  normalizeItems,
  upsertJobs,
  checkJobLinks,
  rebuildCompanies,
  rescoreAllCompanies,
  runBorderlineFlagging,
  runCompanyReview,
  selectListCandidates,
  publishList,
  summarizeForList,
  pruneOldLists,
  isoWeekStart,
  ingestDataset
};
