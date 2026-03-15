/**
 * Generates config.js from environment variables (e.g. Netlify).
 * Run during build: node scripts/generate-config.js
 * Uses: SUPABASE_URL, SUPABASE_ANON_KEY (never use SUPABASE_SERVICE_ROLE_KEY in frontend).
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const url = (process.env.SUPABASE_URL || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const anonKey = (process.env.SUPABASE_ANON_KEY || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const content = `// Generated from env (e.g. Netlify: SUPABASE_URL, SUPABASE_ANON_KEY). Do not commit real keys if editing by hand.
// SUPABASE_SERVICE_ROLE_KEY must only be used server-side (e.g. Supabase Edge Function secrets), never in frontend.
window.SUPABASE_URL = "${url}";
window.SUPABASE_ANON_KEY = "${anonKey}";
`;

fs.writeFileSync(path.join(root, "config.js"), content, "utf8");
console.log("config.js written (SUPABASE_URL:", url ? "set" : "empty", ", ANON_KEY:", anonKey ? "set" : "empty", ")");
