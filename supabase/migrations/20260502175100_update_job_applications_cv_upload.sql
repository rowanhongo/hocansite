-- Update job_applications table to use single CV file upload instead of multiple URL fields
-- Drop old URL-based fields and add new Cloudinary-based CV fields

-- Drop old columns (if they exist)
ALTER TABLE public.job_applications 
DROP COLUMN IF EXISTS linkedin_url,
DROP COLUMN IF EXISTS resume_url,
DROP COLUMN IF EXISTS cover_letter_url;

-- Add new columns for CV file upload
ALTER TABLE public.job_applications
ADD COLUMN cv_url TEXT,
ADD COLUMN cv_filename TEXT;
