const DAILY_LIMIT = 300;        // Brevo free tier
const RESEND_DAILY_LIMIT = 100; // Resend free tier

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

function capitalizeFirst(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function buildLogoUrl() {
  const explicit = env("NEWSLETTER_LOGO_URL", "").trim();
  if (explicit) return explicit;
  let base = env("URL", env("DEPLOY_PRIME_URL", "")).replace(/\/$/, "");
  // Ensure absolute https URL (some email clients drop relative/invalid URLs)
  if (base && !base.startsWith("http")) base = `https://${base}`;
  // Full wordmark logo — emails need the readable brand, not the bare icon.
  if (base) return `${base}/assets/logo.png`;
  return "assets/logo.png";
}

function baseUrl() {
  let base = env("URL", env("DEPLOY_PRIME_URL", "")).replace(/\/$/, "");
  if (base && !base.startsWith("http")) base = `https://${base}`;
  return base;
}

function b64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Resend returns {name, message} on failure. Its two most common rejections are
// an unverified sending domain and a bad key, so name those explicitly.
async function describeResendError(res) {
  let detail = "";
  let name = "";
  try {
    const parsed = JSON.parse(await res.text());
    detail = parsed.message || "";
    name = parsed.name || "";
  } catch {
    detail = "";
  }

  // Domain errors also arrive as 403, so test the message before the key check
  // or an unverified domain reports itself as a bad API key.
  if (/domain/i.test(detail)) {
    return `Resend has not verified the sending domain. Add the domain for the newsletter sender address under Domains in Resend and complete the DNS records. Resend said: ${detail}`;
  }
  if (res.status === 401 || res.status === 403) {
    return "Resend rejected the API key. Check RESEND_API_KEY in Netlify env vars — it should start with 're_' and needs Sending access.";
  }
  if (res.status === 429) {
    return "Resend rate limit hit (free tier allows 100 emails/day). Wait and try again, or upgrade the plan.";
  }
  return `Resend error ${res.status}${name ? ` (${name})` : ""}: ${detail || "no details returned."}`;
}

// Brevo returns {code, message} on failure. Surfacing that raw JSON in the admin
// toast is what made send failures read as an unexplained "API error", so map the
// codes we can act on to instructions and keep Brevo's own text as the fallback.
async function describeBrevoError(res) {
  let detail = "";
  let code = "";
  try {
    const parsed = JSON.parse(await res.text());
    detail = parsed.message || "";
    code = parsed.code || "";
  } catch {
    detail = "";
  }

  if (res.status === 401) {
    return "Brevo rejected the API key. Check BREVO_API_KEY in Netlify env vars — a key that was regenerated in Brevo must be updated here too.";
  }
  if (code === "unauthorized" || code === "permission_denied") {
    return `Brevo denied the request: ${detail || "the API key lacks permission to send transactional email."}`;
  }
  if (res.status === 400 && /sender/i.test(detail)) {
    return `Brevo rejected the sender address. Verify BREVO_SENDER_EMAIL in Brevo (Senders & IP) before sending. Brevo said: ${detail}`;
  }
  if (res.status === 402 || /credit/i.test(detail)) {
    return `Brevo account is out of sending credits: ${detail || "add credits or wait for the plan to reset."}`;
  }
  if (res.status === 429) {
    return "Brevo rate limit hit. Wait a minute and send again.";
  }
  return `Brevo error ${res.status}${code ? ` (${code})` : ""}: ${detail || "no details returned."}`;
}

function unsubscribeToken(email) {
  const secret = required("NEWSLETTER_UNSUBSCRIBE_SECRET");
  const ts = String(Date.now());
  const sig = require("crypto").createHmac("sha256", secret).update(`${email}|${ts}`).digest("hex");
  return b64urlEncode(JSON.stringify({ email, ts, sig }));
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

    // Set EMAIL_PROVIDER=resend to switch; anything else keeps Brevo, so the
    // fallback is a single env var change rather than a redeploy of this code.
    const provider = env("EMAIL_PROVIDER", "brevo").trim().toLowerCase();
    const dailyLimit = provider === "resend" ? RESEND_DAILY_LIMIT : DAILY_LIMIT;

    // Check config before touching the database, so a missing key reports the
    // actual cause instead of surfacing as a generic 500 mid-send.
    const missing = [
      provider === "resend" ? "RESEND_API_KEY" : "BREVO_API_KEY",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEWSLETTER_UNSUBSCRIBE_SECRET"
    ].filter((name) => !process.env[name]);
    if (missing.length) {
      return json(500, {
        ok: false,
        error: `Newsletter is not configured. Missing Netlify environment variable(s): ${missing.join(", ")}.`
      });
    }

    const used = await getDailyUsed();
    const remaining = Math.max(0, dailyLimit - used);

    if (remaining <= 0) {
      return json(400, {
        ok: false,
        error: `Daily limit reached (${dailyLimit} emails on ${provider}). Remaining subscribers will need to wait until tomorrow.`,
        used,
        dailyLimit
      });
    }

    const listRes = await fetch(
      supabase(`newsletter_subscribers?select=email,first_name,last_name,unsubscribed_at&unsubscribed_at=is.null&order=created_at.desc&limit=${remaining}`),
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
      return json(200, { ok: true, message: "No subscribers found.", sentCount: 0, used, dailyLimit });
    }

    // NEWSLETTER_SENDER_* is the provider-neutral name; the BREVO_* names are
    // still honoured so existing Netlify config keeps working after the switch.
    const senderEmail = env("NEWSLETTER_SENDER_EMAIL", env("BREVO_SENDER_EMAIL", "info@hocanholdings.co.ke"));
    const senderName = env("NEWSLETTER_SENDER_NAME", env("BREVO_SENDER_NAME", "Hocan Holdings"));
    const logoUrl = buildLogoUrl();

    const messageHtml = message.includes("<")
      ? message
      : escapeHtml(message).replaceAll("\n", "<br>");

    const site = baseUrl();
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.65;">
        <div style="padding:18px 0 12px;border-bottom:1px solid #e5e7eb;margin-bottom:18px;">
          <img src="${logoUrl}" alt="Hocan Holdings" style="height:54px;display:block;">
        </div>
        <div style="white-space:normal;">__GREETING__${messageHtml}</div>
        <div style="margin-top:18px;color:#6b7280;font-size:12px;border-top:1px solid #f1f5f9;padding-top:12px;">
          You received this email because you subscribed to Hocan Holdings updates.
          ${site ? `<br><a href="${site}/unsubscribe.html?token=__TOKEN__" style="color:#475569;">Unsubscribe</a>` : ""}
        </div>
      </div>
    `;

    const apiKey = provider === "resend" ? required("RESEND_API_KEY") : required("BREVO_API_KEY");

    // Send individually (better deliverability than BCC blasting)
    const sendOne = async (recipient) => {
      const unsubUrl = site ? `${site}/unsubscribe.html?token=${unsubscribeToken(recipient.email)}` : "";
      const firstName = capitalizeFirst(recipient.first_name);
      const greeting = firstName ? `Hi ${escapeHtml(firstName)},<br><br>` : "Hi there,<br><br>";
      const renderedHtml = html
        .replace("__TOKEN__", encodeURIComponent(unsubscribeToken(recipient.email)))
        .replace("__GREETING__", greeting);
      const renderedText = `${firstName ? `Hi ${firstName},` : "Hi there,"}\n\n${message}`;
      const recipientName = `${recipient.first_name || ""} ${recipient.last_name || ""}`.trim();
      const unsubHeaders = unsubUrl
        ? {
            "List-Unsubscribe": `<${unsubUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
          }
        : undefined;

      if (provider === "resend") {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            from: `${senderName} <${senderEmail}>`,
            to: [recipient.email],
            subject,
            html: renderedHtml,
            text: renderedText,
            headers: unsubHeaders
          })
        });
        if (!res.ok) throw new Error(await describeResendError(res));
        return;
      }

      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": apiKey },
        body: JSON.stringify({
          sender: { email: senderEmail, name: senderName },
          to: [{ email: recipient.email, name: recipientName || recipient.email }],
          subject,
          htmlContent: renderedHtml,
          textContent: renderedText,
          headers: unsubHeaders
        })
      });
      if (!res.ok) {
        throw new Error(await describeBrevoError(res));
      }
    };

    // Simple concurrency limit
    const concurrency = 3;
    let idx = 0;
    let sentCount = 0;
    // One bad recipient used to reject Promise.all and abort the run, losing the
    // count of everything already sent and re-sending it on the next attempt.
    // Collect failures instead so a single address cannot sink the batch.
    const failures = [];
    const workers = new Array(concurrency).fill(0).map(async () => {
      while (idx < subscribers.length) {
        const current = subscribers[idx++];
        try {
          await sendOne(current);
          sentCount += 1;
        } catch (err) {
          failures.push({ email: current.email, reason: err.message });
        }
      }
    });

    await Promise.all(workers);

    // Every recipient failing means a configuration problem, not bad addresses —
    // report it as an error so it is not mistaken for a successful send.
    if (!sentCount && failures.length) {
      return json(502, {
        ok: false,
        error: `Newsletter could not be sent. ${failures[0].reason}`,
        failedCount: failures.length
      });
    }

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
    const limitWarning = newUsed >= dailyLimit * 0.83 ? `Approaching daily limit (${newUsed}/${dailyLimit}).` : null;
    const failureWarning = failures.length
      ? `${failures.length} recipient(s) failed. First: ${failures[0].email} — ${failures[0].reason}`
      : null;
    return json(200, {
      ok: true,
      message: `Newsletter sent to ${sentCount} subscriber(s).`,
      sentCount,
      failedCount: failures.length,
      used: newUsed,
      dailyLimit,
      warning: failureWarning || limitWarning
    });
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Server error" });
  }
};
