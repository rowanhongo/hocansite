const DAILY_LIMIT = 300;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function supabaseHeaders() {
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

function supabase(pathAndQuery) {
  return `${required("SUPABASE_URL")}/rest/v1/${pathAndQuery}`;
}

function tableMissing(text) {
  const msg = String(text || "").toLowerCase();
  return msg.includes("could not find the table") || msg.includes("relation") || msg.includes("does not exist");
}

async function getDailyUsed() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const res = await fetch(
    supabase(`newsletter_send_logs?select=sent_count&created_at=gte.${encodeURIComponent(start.toISOString())}`),
    { headers: supabaseHeaders() }
  );
  if (!res.ok) {
    const err = await res.text();
    if (tableMissing(err)) return 0;
    throw new Error("Could not load daily newsletter usage.");
  }
  const rows = await res.json();
  return rows.reduce((sum, row) => sum + Number(row.sent_count || 0), 0);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildLogoUrl() {
  const explicit = env("NEWSLETTER_LOGO_URL", "").trim();
  if (explicit) return explicit;
  const base = env("URL", env("DEPLOY_PRIME_URL", "")).replace(/\/$/, "");
  if (base) return `${base}/Hocan%20Logo.png`;
  return "Hocan%20Logo.png";
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const subject = String(body.subject || "").trim();
    const message = String(body.message || "").trim();

    if (!subject || !message) {
      return json(400, { ok: false, error: "Subject and message are required." });
    }

    const used = await getDailyUsed();
    const remaining = Math.max(0, DAILY_LIMIT - used);

    if (remaining <= 0) {
      return json(400, {
        ok: false,
        error: "Daily limit reached (300 emails). sending wont work for past 300 users.",
        used,
        dailyLimit: DAILY_LIMIT
      });
    }

    const listRes = await fetch(
      supabase(`newsletter_subscribers?select=email,first_name,last_name&order=created_at.desc&limit=${remaining}`),
      { headers: supabaseHeaders() }
    );
    if (!listRes.ok) {
      const err = await listRes.text();
      if (tableMissing(err)) {
        return json(400, { ok: false, error: "Newsletter tables are missing. Run the latest Supabase migration first." });
      }
      throw new Error("Could not load newsletter subscribers.");
    }
    const subscribers = await listRes.json();

    if (!Array.isArray(subscribers) || !subscribers.length) {
      return json(200, { ok: true, message: "No subscribers found.", sentCount: 0, used, dailyLimit: DAILY_LIMIT });
    }

    const senderEmail = env("BREVO_SENDER_EMAIL", "info@hocanholdings.co.ke");
    const senderName = env("BREVO_SENDER_NAME", "Hocan Holdings");
    const logoUrl = buildLogoUrl();

    const messageHtml = message.includes("<")
      ? message
      : escapeHtml(message).replaceAll("\n", "<br>");

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.65;">
        <div style="padding:18px 0 12px;border-bottom:1px solid #e5e7eb;margin-bottom:18px;">
          <img src="${logoUrl}" alt="Hocan Holdings" style="height:54px;display:block;">
        </div>
        <div style="white-space:normal;">${messageHtml}</div>
        <div style="margin-top:18px;color:#6b7280;font-size:12px;border-top:1px solid #f1f5f9;padding-top:12px;">
          You received this email because you subscribed to Hocan Holdings updates.
        </div>
      </div>
    `;

    const brevoPayload = {
      sender: { email: senderEmail, name: senderName },
      to: [{ email: senderEmail, name: senderName }],
      bcc: subscribers.map((s) => ({
        email: s.email,
        name: `${s.first_name || ""} ${s.last_name || ""}`.trim() || s.email
      })),
      subject,
      htmlContent: html,
      textContent: message
    };

    const sendRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": required("BREVO_API_KEY")
      },
      body: JSON.stringify(brevoPayload)
    });

    if (!sendRes.ok) {
      const errBody = await sendRes.text();
      return json(400, { ok: false, error: `Brevo send failed: ${errBody}` });
    }

    const sentCount = subscribers.length;
    const logRes = await fetch(supabase("newsletter_send_logs"), {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify([{ subject, sent_count: sentCount }])
    });
    if (!logRes.ok) {
      const err = await logRes.text();
      if (!tableMissing(err)) {
        throw new Error("Newsletter was sent but failed to log daily usage.");
      }
    }

    const newUsed = used + sentCount;
    return json(200, {
      ok: true,
      message: `Newsletter sent to ${sentCount} subscriber(s).`,
      sentCount,
      used: newUsed,
      dailyLimit: DAILY_LIMIT,
      warning: newUsed >= 250 ? "Approaching daily limit (250+)." : null
    });
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Server error" });
  }
};
