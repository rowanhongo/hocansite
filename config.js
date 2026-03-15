// Filled at build time from Netlify env vars (SUPABASE_URL, SUPABASE_ANON_KEY).
// Run: npm run build  (or set these in Netlify → Site settings → Environment variables).
// SUPABASE_SERVICE_ROLE_KEY must never be used in frontend code; use it only in Supabase Edge Function secrets.
window.SUPABASE_URL = window.SUPABASE_URL || "";
window.SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";
