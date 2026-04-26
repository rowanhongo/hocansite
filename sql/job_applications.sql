-- Run this in Supabase SQL editor
create table if not exists public.job_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  job_id text,
  job_slug text,
  job_title text not null,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text not null,
  city text not null,
  country text not null,
  previous_experience text[] not null default '{}',
  education_level text not null check (education_level in ('High School', 'Undergraduate', 'Master''s', 'PhD')),
  education_details text,
  linkedin_url text,
  resume_url text not null,
  cover_letter_url text not null
);

create index if not exists idx_job_applications_created_at
  on public.job_applications (created_at desc);

create index if not exists idx_job_applications_job_title
  on public.job_applications (job_title);

alter table public.job_applications enable row level security;

-- NOTE: Your current admin portal uses anon browser access, so it needs SELECT.
-- If you move admin to a secure server-side flow later, tighten this policy.
drop policy if exists "public can insert job applications" on public.job_applications;
create policy "public can insert job applications"
  on public.job_applications
  for insert
  to anon
  with check (true);

drop policy if exists "public can read job applications" on public.job_applications;
create policy "public can read job applications"
  on public.job_applications
  for select
  to anon
  using (true);
