-- Newsletter subscribers and daily send logs

CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text,
  last_name text,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ensure one subscription per email (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_email_lower
  ON public.newsletter_subscribers (lower(email));

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_created_at
  ON public.newsletter_subscribers (created_at DESC);

CREATE TABLE IF NOT EXISTS public.newsletter_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text,
  sent_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_send_logs_created_at
  ON public.newsletter_send_logs (created_at DESC);

ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_send_logs ENABLE ROW LEVEL SECURITY;

-- Service role via Netlify Functions bypasses RLS; no broad public policies added.
