# Hocan Holdings Website

Static site with send-package form and admin dashboard, backed by Supabase.

## Netlify environment variables

Set these in **Netlify → Site settings → Environment variables** (or in `netlify.toml` / UI):

| Variable | Use | Where |
|----------|-----|--------|
| `SUPABASE_URL` | Project URL, e.g. `https://your-project-id.supabase.co` | Injected into frontend at build |
| `SUPABASE_ANON_KEY` | Public anon key (safe for browser) | Injected into frontend at build |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret service key (bypasses RLS) | **Never** in frontend. Supabase Edge Function secrets (Paystack webhook) and Netlify Functions (`bio-links-admin`). |
| `ADMIN_PASSWORD` | Password for the admin dashboard, also re-checked server-side by `bio-links-admin` | Netlify env vars |

**Build command:** `npm run build`  
**Publish directory:** `.` (or your static output folder)

The build runs `scripts/generate-config.js`, which writes `config.js` from `SUPABASE_URL` and `SUPABASE_ANON_KEY`. **After adding or changing these env vars in Netlify, you must trigger a new deploy** (e.g. push a commit or "Trigger deploy" in Netlify) so the build runs and the live site gets the correct config. Otherwise the Send Package form will not save orders and the admin dashboard will stay empty.

## Local development

1. Create a `.env` file (do not commit) with:
   ```
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_ANON_KEY=your_anon_key
   ```
2. Run `npm run build` so `config.js` is generated, then open `index.html` (or use a local server).
3. Or set `window.SUPABASE_URL` and `window.SUPABASE_ANON_KEY` in `config.js` manually for local only.

## Link hub (links.hocanholdings.co.ke)

The "link in bio" page. `links.html` is the public page; the **Link Hub** panel in
`admin.html` manages it.

**Adding a link:** Admin → Link Hub → **+ Add Link** → paste the address, type the
button text, save. It appears on the live page immediately — anyone with the page
already open sees it without refreshing (Supabase Realtime, with a 30s poll and a
tab-focus refetch as fallback for in-app browsers that drop websockets).

**Why writes go through a function:** `bio_links` has RLS enabled with a
read-only public policy. The anon key ships in the browser, so it must not be
able to write to the page in our bio. `netlify/functions/bio-links-admin.js`
re-checks `ADMIN_PASSWORD` server-side and writes with the service role key.
It also rejects any URL that is not `http(s)`, which would otherwise be a stored
XSS vector.

**One-time setup for the subdomain:**

1. Netlify → Domain management → **Add domain alias** → `links.hocanholdings.co.ke`
2. At the DNS host, add a `CNAME` for `links` pointing at the Netlify site
   (`<site-name>.netlify.app`).
3. Wait for DNS to propagate, then let Netlify provision the TLS certificate.

The host-scoped rewrite in `netlify.toml` then serves `links.html` at that
subdomain's root. `/links` on the main domain serves the same page.

## Database migrations (automatic)

Netlify deploys the site but never touches the database. Migrations are applied
by GitHub Actions instead: [.github/workflows/supabase-migrations.yml](.github/workflows/supabase-migrations.yml)
runs `supabase db push` on every push to `main` that changes `supabase/migrations/`.

**One-time setup — add the `SUPABASE_DB_URL` repository secret:**

1. Supabase Dashboard → your project → **Connect** → **Connection string** → **URI**,
   and pick the **Session pooler** string (the direct connection is IPv6-only and
   GitHub Actions runners cannot reach it).
2. Replace `[YOUR-PASSWORD]` in that string with your database password
   (Settings → Database → Reset database password if you do not have it).
3. GitHub → repo **Settings → Secrets and variables → Actions → New repository
   secret** → name `SUPABASE_DB_URL`, paste the string.

You can also trigger a run manually from the **Actions** tab without pushing
(the workflow has `workflow_dispatch` enabled).

**Writing migrations:** name them `<UTC timestamp>_<description>.sql`, and make
every statement safe to re-run (`IF NOT EXISTS`, `CREATE OR REPLACE`, a
`DROP ... IF EXISTS` before a `CREATE POLICY`). `db push` only applies files the
database has not recorded yet, but idempotency means a partial failure can be
retried without hand-repairing the schema.

## Supabase backend

See [supabase/README.md](supabase/README.md) for migrations, Paystack webhook, and admin/rider setup.
