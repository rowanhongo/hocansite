const crypto = require("crypto");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function headers() {
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

function rest(pathAndQuery) {
  return `${required("SUPABASE_URL")}/rest/v1/${pathAndQuery}`;
}

function b64urlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function sign(email, ts) {
  const secret = required("NEWSLETTER_UNSUBSCRIBE_SECRET");
  return crypto.createHmac("sha256", secret).update(`${email}|${ts}`).digest("hex");
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const token = String(body.token || "").trim();
    if (!token) return json(400, { ok: false, error: "Missing token" });

    const decoded = JSON.parse(b64urlDecode(token));
    const email = String(decoded.email || "").toLowerCase();
    const ts = String(decoded.ts || "");
    const sig = String(decoded.sig || "");

    if (!email || !email.includes("@") || !ts || !sig) {
      return json(400, { ok: false, error: "Invalid token" });
    }

    const expected = sign(email, ts);
    if (expected !== sig) {
      return json(400, { ok: false, error: "Invalid token signature" });
    }

    const now = new Date().toISOString();
    const res = await fetch(rest(`newsletter_subscribers?email=eq.${encodeURIComponent(email)}`), {
      method: "PATCH",
      headers: { ...headers(), Prefer: "return=minimal" },
      body: JSON.stringify({ unsubscribed_at: now })
    });

    if (!res.ok) {
      const err = await res.text();
      return json(400, { ok: false, error: `Unsubscribe failed: ${err}` });
    }

    return json(200, { ok: true });
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Server error" });
  }
};

