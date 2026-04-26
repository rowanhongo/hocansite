-- Needed for admin-side cleanup/deletes from browser (anon key).
-- Run this if you see: "Could not auto-clean old applications..."

alter table public.job_applications enable row level security;

drop policy if exists "public can delete job applications" on public.job_applications;
create policy "public can delete job applications"
  on public.job_applications
  for delete
  to anon
  using (true);
