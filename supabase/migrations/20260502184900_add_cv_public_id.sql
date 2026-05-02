-- Add cv_public_id column to job_applications for Supabase Storage file deletion
ALTER TABLE public.job_applications
ADD COLUMN cv_public_id TEXT;
