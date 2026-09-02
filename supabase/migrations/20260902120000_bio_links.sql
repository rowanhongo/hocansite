-- Link hub ("link in bio") backing tables for links.hocanholdings.co.ke.
--
-- Unlike the newsletter tables, RLS is enabled here *with* policies from the
-- start. This data is world-readable by design and the anon key ships in the
-- browser, so without policies anyone holding that key could rewrite the links
-- in our Instagram bio. Reads are open to active rows only; every write is
-- denied to anon and goes through netlify/functions/bio-links-admin.js, which
-- checks the admin password and uses the service role key (which bypasses RLS).
--
-- Everything is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so it is safe to
-- re-run against the live database.

-- ── Profile header (single row) ──────────────────────────────────────────────
create table if not exists public.bio_profile (
  id uuid primary key default gen_random_uuid(),
  display_name text not null default 'Hocan Holdings',
  tagline text,
  avatar_url text,
  -- Social icon row. Empty string means "hide this icon".
  instagram_url text,
  linkedin_url text,
  whatsapp_url text,
  website_url text,
  updated_at timestamptz not null default now()
);

-- ── Links ────────────────────────────────────────────────────────────────────
create table if not exists public.bio_links (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subtitle text,
  url text not null,
  image_url text,
  -- 'standard' renders a 1:1 thumbnail inside a full-width button;
  -- 'featured' renders a 16:9 hero card. Matches Linktree's two layouts.
  layout text not null default 'standard',
  -- Optional section header the link is grouped under on the public page.
  category text,
  active boolean not null default true,
  display_order integer not null default 0,
  -- Optional scheduling window for time-boxed opportunities. Null = always on.
  starts_at timestamptz,
  ends_at timestamptz,
  click_count integer not null default 0,
  -- Archive is a timestamp, never a delete, so a mistaken removal is reversible
  -- (same convention as newsletter_subscribers.unsubscribed_at).
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bio_links add column if not exists subtitle text;
alter table public.bio_links add column if not exists image_url text;
alter table public.bio_links add column if not exists layout text not null default 'standard';
alter table public.bio_links add column if not exists category text;
alter table public.bio_links add column if not exists starts_at timestamptz;
alter table public.bio_links add column if not exists ends_at timestamptz;
alter table public.bio_links add column if not exists click_count integer not null default 0;
alter table public.bio_links add column if not exists archived_at timestamptz;

alter table public.bio_links drop constraint if exists bio_links_layout_check;
alter table public.bio_links add constraint bio_links_layout_check
  check (layout in ('standard', 'featured'));

-- The public page orders by display_order over live, non-archived rows.
create index if not exists bio_links_live_order_idx
  on public.bio_links (display_order asc, created_at asc)
  where active = true and archived_at is null;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.bio_links enable row level security;
alter table public.bio_profile enable row level security;

-- Anon may read live links only. Scheduling is enforced here rather than in the
-- client so an unpublished link is never sent over the wire at all.
drop policy if exists bio_links_public_read on public.bio_links;
create policy bio_links_public_read on public.bio_links
  for select to anon, authenticated
  using (
    active = true
    and archived_at is null
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
  );

drop policy if exists bio_profile_public_read on public.bio_profile;
create policy bio_profile_public_read on public.bio_profile
  for select to anon, authenticated using (true);

-- No insert/update/delete policies exist by design: writes are service-role only.

-- ── Click tracking ───────────────────────────────────────────────────────────
-- SECURITY DEFINER so an anon visitor can bump the counter without holding any
-- write policy on the table. It only ever increments one row's counter, so it
-- cannot be used to modify link content.
create or replace function public.increment_bio_link_click(link_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.bio_links
     set click_count = click_count + 1
   where id = link_id and active = true and archived_at is null;
$$;

revoke all on function public.increment_bio_link_click(uuid) from public;
grant execute on function public.increment_bio_link_click(uuid) to anon, authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────────────
-- Adding a link in the dashboard must appear on an already-open page with no
-- refresh, which needs both tables in the realtime publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bio_links'
    ) then
      alter publication supabase_realtime add table public.bio_links;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bio_profile'
    ) then
      alter publication supabase_realtime add table public.bio_profile;
    end if;
  end if;
end $$;

-- Seed the single profile row with the handles currently on the site.
insert into public.bio_profile (display_name, tagline, instagram_url, linkedin_url, whatsapp_url, website_url)
select 'Hocan Holdings',
       'Connecting talent and opportunity across Africa.',
       'https://www.instagram.com/hocanholdingsafrica',
       'https://www.linkedin.com/in/hocan-holdings-072320404',
       'https://wa.me/254791235830',
       'https://hocanholdings.co.ke'
where not exists (select 1 from public.bio_profile);
