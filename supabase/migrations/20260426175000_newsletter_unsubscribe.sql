-- Add unsubscribe support

ALTER TABLE public.newsletter_subscribers
ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_unsubscribed_at
  ON public.newsletter_subscribers (unsubscribed_at);

