# Hocan Holdings Website

Static site with send-package form and admin dashboard, backed by Supabase.

## Netlify environment variables

Set these in **Netlify → Site settings → Environment variables** (or in `netlify.toml` / UI):

| Variable | Use | Where |
|----------|-----|--------|
| `SUPABASE_URL` | Project URL, e.g. `https://your-project-id.supabase.co` | Injected into frontend at build |
| `SUPABASE_ANON_KEY` | Public anon key (safe for browser) | Injected into frontend at build |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret service key (bypasses RLS) | **Never** in frontend. Use only in Supabase Edge Function secrets (Paystack webhook). |

**Build command:** `npm run build`  
**Publish directory:** `.` (or your static output folder)

The build runs `scripts/generate-config.js`, which writes `config.js` from `SUPABASE_URL` and `SUPABASE_ANON_KEY`, so the send-package page and admin dashboard get the correct Supabase client config without hardcoding keys.

## Local development

1. Create a `.env` file (do not commit) with:
   ```
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_ANON_KEY=your_anon_key
   ```
2. Run `npm run build` so `config.js` is generated, then open `index.html` (or use a local server).
3. Or set `window.SUPABASE_URL` and `window.SUPABASE_ANON_KEY` in `config.js` manually for local only.

## Supabase backend

See [supabase/README.md](supabase/README.md) for migrations, Paystack webhook, and admin/rider setup.
