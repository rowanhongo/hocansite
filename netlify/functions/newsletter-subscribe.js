function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function headers() {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

function rest(pathAndQuery) {
  return `${env("SUPABASE_URL")}/rest/v1/${pathAndQuery}`;
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const firstName = String(body.firstName || "").trim() || null;
    const lastName = String(body.lastName || "").trim() || null;
    const email = String(body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return json(400, { ok: false, error: "A valid email address is required." });
    }

    const h = headers();
    const existsRes = await fetch(rest(`newsletter_subscribers?select=id&email=eq.${encodeURIComponent(email)}&limit=1`), { headers: h });
    if (!existsRes.ok) throw new Error("Unable to check existing subscription.");
    const exists = await existsRes.json();
    if (Array.isArray(exists) && exists.length) {
      return json(200, { ok: true, alreadySubscribed: true, message: "You are already subscribed." });
    }

    const insertRes = await fetch(rest("newsletter_subscribers"), {
      method: "POST",
      headers: { ...h, Prefer: "return=representation" },
      body: JSON.stringify([{ first_name: firstName, last_name: lastName, email }])
    });
    if (!insertRes.ok) {
      const err = await insertRes.text();
      return json(400, { ok: false, error: `Could not subscribe: ${err}` });
    }

    return json(200, { ok: true, message: "Subscription successful." });
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Server error" });
  }
};
