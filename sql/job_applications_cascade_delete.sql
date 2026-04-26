-- Optional but recommended:
-- This makes job application cleanup happen at DB level too, even if jobs are
-- deleted outside the admin UI.
--
-- NOTE:
-- 1) Replace public.job_posts with your actual jobs table name if needed
--    (e.g. public.jobs).
-- 2) This assumes job_applications.job_id stores the jobs.id value as text.

create or replace function public.delete_job_applications_on_job_delete()
returns trigger
language plpgsql
as $$
begin
  delete from public.job_applications
  where job_id = old.id::text
     or (old.slug is not null and job_slug = old.slug);
  return old;
end;
$$;

drop trigger if exists trg_delete_job_applications_on_job_delete on public.job_posts;

create trigger trg_delete_job_applications_on_job_delete
after delete on public.job_posts
for each row
execute function public.delete_job_applications_on_job_delete();
