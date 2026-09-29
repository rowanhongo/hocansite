// Thin Supabase REST wrapper for the business-development functions.
//
// Uses the service role key, which bypasses RLS — the leads tables have RLS on
// with no policies, so this is the only way in. Never import this into anything
// that ships to the browser.

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function headers(extra) {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(extra || {})
  };
}

function restUrl(pathAndQuery) {
  return `${getEnv("SUPABASE_URL")}/rest/v1/${pathAndQuery}`;
}

/* Recognises the "you have not run the migration" case, so the admin can say so
   plainly instead of showing a raw Postgres error.

   Deliberately narrow. A previous version also matched a bare "does not exist",
   which is a substring of plenty of unrelated Postgres errors — a failed
   ON CONFLICT inference among them. That sent the operator off to re-run a
   migration that was already applied while the real fault went unreported.
   PostgREST's own codes are the reliable signal: PGRST205 (table not in the
   schema cache) and 42P01 (undefined_table). */
function tableMissing(text) {
  const msg = String(text || "").toLowerCase();
  if (msg.includes("pgrst205") || msg.includes("42p01")) return true;
  return (
    msg.includes("could not find the table") ||
    msg.includes("could not find the schema") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

class RestError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RestError";
    this.status = status;
    this.body = body;
    this.missingTable = tableMissing(body);
  }
}

async function request(pathAndQuery, options = {}) {
  const res = await fetch(restUrl(pathAndQuery), {
    method: options.method || "GET",
    headers: headers(options.headers),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RestError(
      `Supabase ${options.method || "GET"} ${pathAndQuery.split("?")[0]} failed (${res.status})`,
      res.status,
      text
    );
  }

  if (options.returnHeaders) {
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { data, headers: res.headers };
  }

  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

const select = (pathAndQuery) => request(pathAndQuery);

/* Count rows without transferring them.

   Prefer: count=exact with a head request; the total comes back in
   content-range as "0-24/137". */
async function count(pathAndQuery) {
  const { headers: h } = await request(pathAndQuery, {
    method: "GET",
    headers: { Prefer: "count=exact", Range: "0-0" },
    returnHeaders: true
  });
  const range = h.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

const insert = (table, rows, prefer = "return=representation") =>
  request(table, { method: "POST", body: rows, headers: { Prefer: prefer } });

/* Insert-or-update in one round trip.

   `onConflict` names the unique column; `ignoreDuplicates=false` makes it a
   real upsert rather than a skip. This is what keeps a re-scraped job updating
   last_seen instead of erroring on the unique index. */
const upsert = (table, rows, onConflict, prefer = "return=representation") =>
  request(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    body: rows,
    headers: { Prefer: `resolution=merge-duplicates,${prefer}` }
  });

const update = (pathAndQuery, patch, prefer = "return=minimal") =>
  request(pathAndQuery, { method: "PATCH", body: patch, headers: { Prefer: prefer } });

const remove = (pathAndQuery) =>
  request(pathAndQuery, { method: "DELETE", headers: { Prefer: "return=minimal" } });

module.exports = { request, select, count, insert, upsert, update, remove, RestError, tableMissing, getEnv };
