const DAILY_LIMIT = 300;

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function getSupabaseHeaders() {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

function getSupabaseRestUrl(pathAndQuery) {
  const base = getEnv("SUPABASE_URL");
  return `${base}/rest/v1/${pathAndQuery}`;
}

function tableMissing(text) {
  const msg = String(text || "").toLowerCase();
  return msg.includes("could not find the table") || msg.includes("relation") || msg.includes("does not exist");
}

async function getDailyUsed() {
  const headers = getSupabaseHeaders();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const res = await fetch(
    getSupabaseRestUrl(`newsletter_send_logs?select=sent_count&created_at=gte.${encodeURIComponent(start.toISOString())}`),
    { headers }
  );
  if (!res.ok) {
    const err = await res.text();
    if (tableMissing(err)) return 0;
    throw new Error("Failed to fetch daily usage");
  }
  const rows = await res.json();
  return rows.reduce((sum, row) => sum + Number(row.sent_count || 0), 0);
}

async function addSubscriber(body) {
  const headers = getSupabaseHeaders();
  const email = String(body.email || "").trim().toLowerCase();
  const firstName = String(body.firstName || "").trim() || null;
  const lastName = String(body.lastName || "").trim() || null;

  if (!email || !email.includes("@")) {
    return json(400, { ok: false, error: "A valid email is required." });
  }

  const existsRes = await fetch(
    getSupabaseRestUrl(`newsletter_subscribers?select=id&email=eq.${encodeURIComponent(email)}&limit=1`),
    { headers }
  );
  if (!existsRes.ok) {
    const err = await existsRes.text();
    if (tableMissing(err)) {
      return json(400, { ok: false, error: "Newsletter tables are missing. Run the latest Supabase migration first." });
    }
    throw new Error("Could not validate subscriber");
  }
  const existsRows = await existsRes.json();
  if (Array.isArray(existsRows) && existsRows.length) {
    return json(200, { ok: true, alreadySubscribed: true, message: "Email already subscribed." });
  }

  const insertRes = await fetch(getSupabaseRestUrl("newsletter_subscribers"), {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "return=representation"
    },
    body: JSON.stringify([{ email, first_name: firstName, last_name: lastName }])
  });

  if (!insertRes.ok) {
    const errBody = await insertRes.text();
    if (tableMissing(errBody)) {
      return json(400, { ok: false, error: "Newsletter tables are missing. Run the latest Supabase migration first." });
    }
    return json(400, { ok: false, error: `Subscribe failed: ${errBody}` });
  }

  return json(200, { ok: true, message: "Subscriber added successfully." });
}

async function getDashboardData() {
  const headers = getSupabaseHeaders();

  const [listRes, countRes, dailyUsed] = await Promise.all([
    fetch(getSupabaseRestUrl("newsletter_subscribers?select=id,first_name,last_name,email,created_at&order=created_at.desc&limit=250"), { headers }),
    fetch(getSupabaseRestUrl("newsletter_subscribers?select=id"), {
      headers: { ...headers, Prefer: "count=exact" }
    }),
    getDailyUsed()
  ]);

  if (!listRes.ok || !countRes.ok) {
    const listErr = await listRes.text();
    const countErr = await countRes.text();
    if (tableMissing(listErr) || tableMissing(countErr)) {
      return json(200, {
        ok: true,
        total: 0,
        dailyUsed,
        dailyLimit: DAILY_LIMIT,
        subscribers: [],
        setupRequired: true,
        message: "Newsletter tables not found. Run the latest migration."
      });
    }
    throw new Error("Failed to load newsletter subscribers.");
  }

  const subscribers = await listRes.json();
  const total = Number(countRes.headers.get("content-range")?.split("/")?.[1] || subscribers.length || 0);

  return json(200, {
    ok: true,
    total,
    dailyUsed,
    dailyLimit: DAILY_LIMIT,
    subscribers
  });
}

async function deleteSubscriber(body) {
  const headers = getSupabaseHeaders();
  const id = String(body.id || "").trim();
  const email = String(body.email || "").trim().toLowerCase();

  if (!id && !email) {
    return json(400, { ok: false, error: "Subscriber id or email is required." });
  }

  const filter = id ? `id=eq.${encodeURIComponent(id)}` : `email=eq.${encodeURIComponent(email)}`;
  const delRes = await fetch(getSupabaseRestUrl(`newsletter_subscribers?${filter}`), {
    method: "DELETE",
    headers,
    body: JSON.stringify({})
  });

  if (!delRes.ok) {
    const errBody = await delRes.text();
    if (tableMissing(errBody)) {
      return json(400, { ok: false, error: "Newsletter tables are missing. Run the latest Supabase migration first." });
    }
    return json(400, { ok: false, error: `Delete failed: ${errBody}` });
  }

  return json(200, { ok: true, message: "Subscriber deleted." });
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      return await addSubscriber(body);
    }
    if (event.httpMethod === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      return await deleteSubscriber(body);
    }

    return await getDashboardData();
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Unknown server error" });
  }
};
