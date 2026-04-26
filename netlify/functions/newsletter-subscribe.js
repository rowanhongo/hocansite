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

function tableMissing(text) {
  const msg = String(text || "").toLowerCase();
  return msg.includes("could not find the table") || msg.includes("relation") || msg.includes("does not exist");
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
    const existsRes = await fetch(rest(`newsletter_subscribers?select=id,unsubscribed_at&email=eq.${encodeURIComponent(email)}&limit=1`), { headers: h });
    if (!existsRes.ok) {
      const err = await existsRes.text();
      if (tableMissing(err)) {
        return json(400, { ok: false, error: "Newsletter is not ready yet. Ask admin to run the latest migration." });
      }
      throw new Error("Unable to check existing subscription.");
    }
    const exists = await existsRes.json();
    if (Array.isArray(exists) && exists.length) {
      const row = exists[0];
      if (row.unsubscribed_at) {
        const reactivateRes = await fetch(rest(`newsletter_subscribers?id=eq.${encodeURIComponent(row.id)}`), {
          method: "PATCH",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({ first_name: firstName, last_name: lastName, unsubscribed_at: null })
        });
        if (!reactivateRes.ok) {
          const err = await reactivateRes.text();
          return json(400, { ok: false, error: `Could not reactivate subscription: ${err}` });
        }
        return json(200, { ok: true, message: "You are subscribed again." });
      }
      return json(200, { ok: true, alreadySubscribed: true, message: "You are already subscribed." });
    }

    const insertRes = await fetch(rest("newsletter_subscribers"), {
      method: "POST",
      headers: { ...h, Prefer: "return=representation" },
      body: JSON.stringify([{ first_name: firstName, last_name: lastName, email }])
    });
    if (!insertRes.ok) {
      const err = await insertRes.text();
      if (tableMissing(err)) {
        return json(400, { ok: false, error: "Newsletter is not ready yet. Ask admin to run the latest migration." });
      }
      return json(400, { ok: false, error: `Could not subscribe: ${err}` });
    }

    return json(200, { ok: true, message: "Subscription successful." });
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Server error" });
  }
};
