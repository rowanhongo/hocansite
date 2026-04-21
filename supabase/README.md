# Supabase Backend (Hocan Holdings)

This folder contains the database migrations and Edge Functions for the Hocan Holdings backend: send-package flow, Paystack webhooks, notifications, rider app, and admin dashboard.

## Setup

### 1. Link or create a Supabase project

```bash
npx supabase link --project-ref YOUR_REF
# or
npx supabase init
```

### 2. Run migrations

```bash
npx supabase db push
# or for local: npx supabase db reset
```

If the migration fails at `ALTER PUBLICATION supabase_realtime ADD TABLE ...`, enable Realtime for `public.orders` and `public.notifications` manually in the Supabase Dashboard: **Database → Replication** and add those tables to the publication.

### 3. Paystack webhook secret

Set the Paystack secret key so the Edge Function can verify webhook signatures:

```bash
npx supabase secrets set PAYSTACK_SECRET_KEY=sk_live_xxxx
# or for test: PAYSTACK_SECRET_KEY=sk_test_xxxx
```

### 4. Deploy the Edge Function

```bash
npx supabase functions deploy paystack-webhook
```

Then in the [Paystack Dashboard](https://dashboard.paystack.com/#/settings/developer), set your webhook URL to:

```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/paystack-webhook
```

### 5. Admin and rider users

- **Admins**: After a user exists in Supabase Auth, add them to `public.admins`:  
  `INSERT INTO public.admins (user_id) SELECT id FROM auth.users WHERE email = 'their@email.com';`
- **Riders**: Create a row in `public.riders` and set `user_id` to their `auth.users.id` so they can log in to the rider app and see assigned orders.

#### Create admin ntonkwac@gmail.com

1. In **Supabase Dashboard → Authentication → Users → Add user**, create a user:
   - **Email:** `ntonkwac@gmail.com`
   - **Password:** set the password you want for this admin (you can change it later in Auth → Users).
2. In **SQL Editor**, run:

```sql
INSERT INTO public.admins (user_id)
SELECT id FROM auth.users WHERE email = 'ntonkwac@gmail.com'
ON CONFLICT (user_id) DO NOTHING;
```

Then log in at your admin dashboard with that email and password.

## What’s included

- **Migrations**  
  - Tables: `orders`, `payments`, `riders`, `admins`, `notifications`  
  - Order number trigger (e.g. `HCN-001`), `updated_at` trigger  
  - Notification trigger on order status/assignment change  
  - Views: `orders_weekly_counts`, `orders_status_distribution`  
  - RLS for anon (insert orders), admin (full), rider (read unassigned/assigned, update assigned only)  
  - Realtime: `orders` and `notifications` added to the realtime publication  

- **Edge Function: `paystack-webhook`**  
  - Verifies `x-paystack-signature` (HMAC SHA512)  
  - Handles `charge.success`: idempotency by `paystack_event_id` / `paystack_reference`, inserts into `payments`, sets `orders.payment_status = 'paid'`, creates admin notifications  
  - Payment status is updated only via this webhook (no polling from the website)

## Realtime

`orders` and `notifications` are enabled for Realtime so that:

- The website can subscribe to an order (e.g. on the payment success page) and update the UI when the webhook sets `payment_status = 'paid'`.
- The admin dashboard can subscribe to `orders` and refresh lists/stats when orders or payment status change.
- The rider app can subscribe to `orders` and see live updates for pending / in transit / completed.

If you add new tables and want them in Realtime, add them in Dashboard → Database → Replication or via a migration:  
`ALTER PUBLICATION supabase_realtime ADD TABLE public.your_table;`
