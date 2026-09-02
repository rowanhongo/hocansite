-- Add cv_public_id column to job_applications for Supabase Storage file deletion
--
-- IF NOT EXISTS was added when migrations became automated: this column was
-- originally applied by hand, so it already exists on the live database and a
-- bare ADD COLUMN would fail the run.
ALTER TABLE public.job_applications
ADD COLUMN IF NOT EXISTS cv_public_id TEXT;
