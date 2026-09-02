// Write path for the link hub (links.hocanholdings.co.ke).
//
// bio_links has RLS enabled with a read-only public policy, so the anon key
// that ships in the browser cannot write. Every mutation lands here, is checked
// against ADMIN_PASSWORD, and is performed with the service role key. Without
// this indirection anyone who read the anon key out of our JS could rewrite the
// links in our Instagram bio.

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

function supabaseHeaders(extra) {
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

// Compares without an early exit on the first differing character, so a caller
// cannot learn the password one character at a time from response timing.
function passwordMatches(supplied) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  const a = String(supplied || "");
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Only ever let a caller set columns we intend to be editable — never
// click_count, id, or created_at, which are server-owned.
function cleanLinkPayload(body) {
  const title = String(body.title || "").trim();
  const url = String(body.url || "").trim();
  const errors = [];

  if (!title) errors.push("Title is required.");
  if (!url) errors.push("Link URL is required.");

  // Reject anything that is not plain http(s). A script- or data-scheme URL
  // here would become a stored XSS vector on the page we put in our bio.
  if (url) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch (_e) {
      errors.push("That link does not look like a valid web address.");
    }
    if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("Links must start with http:// or https://");
    }
  }

  const layout = body.layout === "featured" ? "featured" : "standard";

  return {
    errors,
    row: {
      title,
      url,
      subtitle: String(body.subtitle || "").trim() || null,
      image_url: String(body.imageUrl || "").trim() || null,
      layout,
      category: String(body.category || "").trim() || null,
      active: body.active === false ? false : true,
      starts_at: body.startsAt || null,
      ends_at: body.endsAt || null,
      updated_at: new Date().toISOString()
    }
  };
}

async function readRest(res, fallbackMessage) {
  if (res.ok) {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  const detail = await res.text();
  throw new Error(`${fallbackMessage}${detail ? `: ${detail}` : ""}`);
}

async function listLinks() {
  const res = await fetch(
    restUrl("bio_links?select=*&order=display_order.asc,created_at.asc"),
    { headers: supabaseHeaders() }
  );
  const rows = await readRest(res, "Failed to load links");
  return json(200, { ok: true, links: rows || [] });
}

async function createLink(body) {
  const { errors, row } = cleanLinkPayload(body);
  if (errors.length) return json(400, { ok: false, error: errors.join(" ") });

  // New links go to the bottom of the list.
  const tailRes = await fetch(
    restUrl("bio_links?select=display_order&order=display_order.desc&limit=1"),
    { headers: supabaseHeaders() }
  );
  const tail = await readRest(tailRes, "Failed to determine link order");
  const nextOrder = tail && tail.length ? Number(tail[0].display_order || 0) + 1 : 0;

  const res = await fetch(restUrl("bio_links"), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify([{ ...row, display_order: nextOrder, created_at: new Date().toISOString() }])
  });
  const created = await readRest(res, "Failed to save the link");
  return json(200, { ok: true, link: created && created[0] });
}

async function updateLink(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Missing link id." });

  const { errors, row } = cleanLinkPayload(body);
  if (errors.length) return json(400, { ok: false, error: errors.join(" ") });

  const res = await fetch(restUrl(`bio_links?id=eq.${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(row)
  });
  const updated = await readRest(res, "Failed to update the link");
  return json(200, { ok: true, link: updated && updated[0] });
}

// A "delete" in the UI archives the row so it can be restored. Only the
// explicit purge action removes it for good.
async function archiveLink(body, purge) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Missing link id." });

  if (purge) {
    const res = await fetch(restUrl(`bio_links?id=eq.${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: supabaseHeaders()
    });
    await readRest(res, "Failed to delete the link");
    return json(200, { ok: true });
  }

  const res = await fetch(restUrl(`bio_links?id=eq.${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({
      archived_at: body.restore ? null : new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });
  const updated = await readRest(res, "Failed to archive the link");
  return json(200, { ok: true, link: updated && updated[0] });
}

async function toggleActive(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Missing link id." });

  const res = await fetch(restUrl(`bio_links?id=eq.${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({ active: body.active === true, updated_at: new Date().toISOString() })
  });
  const updated = await readRest(res, "Failed to update the link");
  return json(200, { ok: true, link: updated && updated[0] });
}

// Drag-to-reorder sends the full ordered id list. Writing every row keeps the
// stored order dense and matches exactly what the admin just saw on screen.
async function reorderLinks(body) {
  const ids = Array.isArray(body.ids) ? body.ids.map((v) => String(v)) : [];
  if (!ids.length) return json(400, { ok: false, error: "No order supplied." });

  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 1) {
    const res = await fetch(restUrl(`bio_links?id=eq.${encodeURIComponent(ids[i])}`), {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ display_order: i, updated_at: now })
    });
    await readRest(res, "Failed to save the new order");
  }
  return json(200, { ok: true });
}

async function getProfile() {
  const res = await fetch(restUrl("bio_profile?select=*&limit=1"), { headers: supabaseHeaders() });
  const rows = await readRest(res, "Failed to load the profile");
  return json(200, { ok: true, profile: (rows && rows[0]) || null });
}

async function saveProfile(body) {
  const row = {
    display_name: String(body.displayName || "").trim() || "Hocan Holdings",
    tagline: String(body.tagline || "").trim() || null,
    avatar_url: String(body.avatarUrl || "").trim() || null,
    instagram_url: String(body.instagramUrl || "").trim() || null,
    linkedin_url: String(body.linkedinUrl || "").trim() || null,
    whatsapp_url: String(body.whatsappUrl || "").trim() || null,
    website_url: String(body.websiteUrl || "").trim() || null,
    updated_at: new Date().toISOString()
  };

  const existingRes = await fetch(restUrl("bio_profile?select=id&limit=1"), { headers: supabaseHeaders() });
  const existing = await readRest(existingRes, "Failed to load the profile");

  if (existing && existing.length) {
    const res = await fetch(restUrl(`bio_profile?id=eq.${encodeURIComponent(existing[0].id)}`), {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify(row)
    });
    const updated = await readRest(res, "Failed to save the profile");
    return json(200, { ok: true, profile: updated && updated[0] });
  }

  const res = await fetch(restUrl("bio_profile"), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify([row])
  });
  const created = await readRest(res, "Failed to save the profile");
  return json(200, { ok: true, profile: created && created[0] });
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_e) {
    return json(400, { ok: false, error: "Invalid request body" });
  }

  if (!passwordMatches(body.password)) {
    return json(401, { ok: false, error: "Not authorised. Please sign in again." });
  }

  try {
    switch (body.action) {
      case "list": return await listLinks();
      case "create": return await createLink(body);
      case "update": return await updateLink(body);
      case "archive": return await archiveLink(body, false);
      case "purge": return await archiveLink(body, true);
      case "toggle": return await toggleActive(body);
      case "reorder": return await reorderLinks(body);
      case "getProfile": return await getProfile();
      case "saveProfile": return await saveProfile(body);
      default: return json(400, { ok: false, error: `Unknown action: ${body.action}` });
    }
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Something went wrong." });
  }
};
