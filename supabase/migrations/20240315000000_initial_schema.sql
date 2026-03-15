-- Hocan Holdings: initial schema for orders, payments, riders, notifications
-- Supports send-package flow, Paystack webhooks, rider app, admin dashboard

-- =============================================================================
-- RIDERS (must exist before orders for FK)
-- =============================================================================
CREATE TABLE public.riders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_riders_user_id ON public.riders(user_id);
CREATE INDEX idx_riders_is_active ON public.riders(is_active);

-- =============================================================================
-- ORDER NUMBER SEQUENCE
-- =============================================================================
CREATE SEQUENCE public.order_number_seq START 1;

-- =============================================================================
-- ORDERS
-- =============================================================================
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text UNIQUE,
  sender_name text NOT NULL,
  sender_phone text NOT NULL,
  sender_email text NOT NULL,
  pickup_address text NOT NULL,
  recipient_name text NOT NULL,
  recipient_phone text NOT NULL,
  delivery_address text NOT NULL,
  package_description text,
  package_weight_kg numeric,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','transit','delivered','cancelled')),
  assigned_rider_id uuid REFERENCES public.riders(id) ON DELETE SET NULL,
  amount_cents integer,
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_status ON public.orders(status);
CREATE INDEX idx_orders_created_at ON public.orders(created_at);
CREATE INDEX idx_orders_order_number ON public.orders(order_number);
CREATE INDEX idx_orders_assigned_rider_id ON public.orders(assigned_rider_id);
CREATE INDEX idx_orders_payment_status ON public.orders(payment_status);

-- Generate order_number (e.g. HCN-001) on insert when null
CREATE OR REPLACE FUNCTION public.set_order_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.order_number IS NULL OR NEW.order_number = '' THEN
    NEW.order_number := 'HCN-' || lpad(nextval('public.order_number_seq')::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_order_number
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_order_number();

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- PAYMENTS (written by Paystack webhook)
-- =============================================================================
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  paystack_reference text NOT NULL,
  paystack_event_id text,
  amount_cents integer,
  status text NOT NULL CHECK (status IN ('success','failed','abandoned')),
  paid_at timestamptz,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_payments_paystack_reference ON public.payments(paystack_reference);
CREATE UNIQUE INDEX idx_payments_paystack_event_id ON public.payments(paystack_event_id) WHERE paystack_event_id IS NOT NULL;
CREATE INDEX idx_payments_order_id ON public.payments(order_id);

-- =============================================================================
-- ADMINS (for RLS: who can act as admin)
-- =============================================================================
CREATE TABLE public.admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_admins_user_id ON public.admins(user_id);

-- =============================================================================
-- NOTIFICATIONS
-- =============================================================================
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','rider','customer')),
  title text NOT NULL,
  body text,
  type text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX idx_notifications_role ON public.notifications(role);
CREATE INDEX idx_notifications_read_at ON public.notifications(read_at);
CREATE INDEX idx_notifications_created_at ON public.notifications(created_at);

-- =============================================================================
-- VIEWS FOR ADMIN DASHBOARD GRAPHS
-- =============================================================================

-- Orders per weekday for current week (bar chart)
CREATE OR REPLACE VIEW public.orders_weekly_counts AS
SELECT
  date_trunc('week', created_at AT TIME ZONE 'UTC') AS week_start,
  extract(dow FROM created_at AT TIME ZONE 'UTC')::int AS day_of_week,
  count(*) AS order_count
FROM public.orders
WHERE created_at >= date_trunc('week', now() AT TIME ZONE 'UTC')
GROUP BY 1, 2
ORDER BY 1, 2;

-- Status distribution (donut chart)
CREATE OR REPLACE VIEW public.orders_status_distribution AS
SELECT
  status,
  count(*) AS count
FROM public.orders
GROUP BY status
ORDER BY status;

-- =============================================================================
-- NOTIFICATION TRIGGERS (on order status / assignment change)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.notify_order_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.riders%ROWTYPE;
  o_num text;
BEGIN
  o_num := COALESCE(NEW.order_number, OLD.order_number);

  -- Rider assigned: notify rider
  IF NEW.assigned_rider_id IS NOT NULL AND (OLD.assigned_rider_id IS DISTINCT FROM NEW.assigned_rider_id) THEN
    SELECT * INTO r FROM public.riders WHERE id = NEW.assigned_rider_id;
    IF r.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (order_id, user_id, role, title, body, type)
      VALUES (NEW.id, r.user_id, 'rider', 'Order assigned', 'Order ' || o_num || ' has been assigned to you.', 'order_assigned');
    END IF;
  END IF;

  -- Status changed to in transit: notify all admins
  IF NEW.status = 'transit' AND (OLD.status IS DISTINCT FROM 'transit') THEN
    INSERT INTO public.notifications (order_id, user_id, role, title, body, type)
    SELECT NEW.id, a.user_id, 'admin', 'Order in transit', 'Order ' || o_num || ' is now in transit.', 'status_change'
    FROM public.admins a;
  END IF;

  -- Status changed to delivered: notify all admins
  IF NEW.status = 'delivered' AND (OLD.status IS DISTINCT FROM 'delivered') THEN
    INSERT INTO public.notifications (order_id, user_id, role, title, body, type)
    SELECT NEW.id, a.user_id, 'admin', 'Order delivered', 'Order ' || o_num || ' has been delivered.', 'status_change'
    FROM public.admins a;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_order_status_change
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.assigned_rider_id IS DISTINCT FROM NEW.assigned_rider_id
  )
  EXECUTE FUNCTION public.notify_order_status_change();

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================

ALTER TABLE public.riders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Helper: current user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid());
$$;

-- Helper: current user's rider id (null if not a rider)
CREATE OR REPLACE FUNCTION public.current_rider_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.riders WHERE user_id = auth.uid() AND is_active = true LIMIT 1;
$$;

-- RIDERS: admins full access; riders can read own row
CREATE POLICY "Admins full access riders" ON public.riders
  FOR ALL USING (public.is_admin());

CREATE POLICY "Riders read own" ON public.riders
  FOR SELECT USING (user_id = auth.uid());

-- ORDERS: anon insert (send-package form); admin full; rider read (unassigned or assigned to me), update (only when assigned to me)
CREATE POLICY "Anonymous can insert orders" ON public.orders
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Admins full access orders" ON public.orders
  FOR ALL USING (public.is_admin());

CREATE POLICY "Riders read assigned or unassigned" ON public.orders
  FOR SELECT USING (
    public.current_rider_id() IS NOT NULL
    AND (assigned_rider_id IS NULL OR assigned_rider_id = public.current_rider_id())
  );

CREATE POLICY "Riders update only assigned" ON public.orders
  FOR UPDATE USING (assigned_rider_id = public.current_rider_id())
  WITH CHECK (assigned_rider_id = public.current_rider_id());

-- Allow public/anon to read single order by id for success page (optional: restrict by short-lived token in app)
-- For success page we need either anon read for own order (no auth) or pass order_id in URL and allow read by id
-- Plan says "single fetch for that order by order_id/reference" - so we allow anon to read orders (or we use a signed URL). Simpler: allow anon SELECT by id only is complex in RLS. Easiest: allow authenticated + anon read for orders (read-only for anon). Actually plan says user returns to success URL and does a single fetch - so the frontend will need to fetch. If anon, we need policy. Allow anon SELECT on orders so success page can fetch by id from URL query param. That exposes all orders to anon read. Better: allow anon SELECT where id = requested id and created_at > now() - interval '1 hour' (time-limited). Or use order_number + short token. Simplest for MVP: allow anon SELECT on orders (admin and rider policies still apply for their roles; anon is unauthenticated). So we need: anon can INSERT (done), anon can SELECT? If we allow anon SELECT all, that's a data leak. So: no anon SELECT. Then success page must use backend to fetch - e.g. Edge Function that takes order_id and returns order status (no auth). Or we allow SELECT where order_number = $1 with a secret in session - complex. Easiest: allow anon SELECT only for orders created in last 24h (so customer can check status on success page). We can do: CREATE POLICY "Anon read recent orders" FOR SELECT USING (created_at > now() - interval '24 hours'). That still exposes all recent orders. Better: single-order lookup via Edge Function or allow SELECT where id = request.id (we can't pass request in RLS). So in RLS we cannot do "allow read only this one row" without a column like customer_session_id. So for now: no anon read. Frontend success page will need to either use an Edge Function that accepts order_id and returns status, or we add a column like customer_access_token (random, set on insert) and allow anon SELECT where customer_access_token = $1 (passed in URL). I'll skip anon read for now; the plan's "single fetch" can be implemented via a small Edge Function or we add customer_access_token later. So orders: anon INSERT; admin all; rider read/update as above.

-- PAYMENTS: admin read; write only via service role (webhook)
CREATE POLICY "Admins read payments" ON public.payments
  FOR SELECT USING (public.is_admin());

-- ADMINS: only read own (to check if admin)
CREATE POLICY "Users read admins for self" ON public.admins
  FOR SELECT USING (auth.uid() = user_id);

-- NOTIFICATIONS: admin read all; rider read own
CREATE POLICY "Admins full access notifications" ON public.notifications
  FOR ALL USING (public.is_admin());

CREATE POLICY "Riders read own notifications" ON public.notifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Riders update own notifications read_at" ON public.notifications
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role (Edge Function) bypasses RLS; no policy needed for webhook.

-- =============================================================================
-- REALTIME
-- =============================================================================
-- Enable Realtime for orders and notifications. If this fails (e.g. publication
-- not yet present), enable in Dashboard: Database → Replication → add these tables.
ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
