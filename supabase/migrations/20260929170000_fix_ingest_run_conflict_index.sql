-- Fix: every Apify ingest threw after writing its data.
--
-- job_ingest_runs_apify_run_key was created as a PARTIAL unique index
-- (`where apify_run_id is not null`). Postgres cannot use a partial index to
-- infer an ON CONFLICT target, so the upsert at the end of lib/ingest.js —
-- which is how a webhook retry updates its run row rather than adding a second
-- "last sync" — failed with:
--
--   42P10: there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- The jobs and companies were already committed by that point, so the symptom
-- was confusing: the tables filled up correctly while the caller got an error
-- and the run history stayed empty, making a successful ingest look like a
-- failed one.
--
-- A plain unique index infers correctly. Nothing is lost by dropping the
-- predicate: NULLs are distinct in a Postgres unique index, so manual ingests
-- that carry no Apify run id can still insert as many rows as they like.
--
-- The original migration is updated to match, so a fresh database gets this
-- shape directly and never needs this file.

drop index if exists public.job_ingest_runs_apify_run_key;

create unique index if not exists job_ingest_runs_apify_run_key
  on public.job_ingest_runs (apify_run_id);
