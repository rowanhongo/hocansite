-- Newsletter storage. These tables were created by hand in the Supabase
-- dashboard and had no migration, so the schema existed only on the live
-- database. Everything here is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so it
-- is safe to run against the existing project: it will not drop, truncate, or
-- overwrite any subscriber rows.

create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  first_name text,
  last_name text,
  created_at timestamptz not null default now(),
  -- Unsubscribes are a timestamp, never a delete, so a mistaken opt-out can be
  -- reversed by setting this back to null.
  unsubscribed_at timestamptz
);

-- Backfill for a hand-made table that may predate some of these columns.
alter table public.newsletter_subscribers add column if not exists first_name text;
alter table public.newsletter_subscribers add column if not exists last_name text;
alter table public.newsletter_subscribers add column if not exists created_at timestamptz not null default now();
alter table public.newsletter_subscribers add column if not exists unsubscribed_at timestamptz;

-- One row per address: newsletter-subscribe.js checks for an existing email and
-- reactivates it rather than inserting a duplicate.
create unique index if not exists newsletter_subscribers_email_key
  on public.newsletter_subscribers (lower(email));

-- The admin list and send both filter on unsubscribed_at and order by created_at.
create index if not exists newsletter_subscribers_active_idx
  on public.newsletter_subscribers (created_at desc)
  where unsubscribed_at is null;

create table if not exists public.newsletter_send_logs (
  id uuid primary key default gen_random_uuid(),
  subject text,
  sent_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- Daily usage is summed over today's rows.
create index if not exists newsletter_send_logs_created_at_idx
  on public.newsletter_send_logs (created_at desc);

-- NOTE: an earlier version of this migration enabled row level security on both
-- tables without creating any policies. That emptied the admin panel, because
-- RLS with no policies denies every read that does not come through a key which
-- bypasses it. Enabling RLS here is therefore deliberately omitted: it is a
-- worthwhile hardening step, but it has to ship together with policies and a
-- verified admin read path, not on its own.
--
-- If RLS was already turned on by that earlier version, undo it with:
--   alter table public.newsletter_subscribers disable row level security;
--   alter table public.newsletter_send_logs disable row level security;
