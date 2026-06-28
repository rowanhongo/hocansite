exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  if (!token || !chatId) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, skipped: true })
    };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (_e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || "Unknown";
  const role = data.job_title || "Open Role";
  const email = data.email || "—";
  const phone = data.phone || "—";
  const city = data.city || "";
  const country = data.country || "";
  const location = [city, country].filter(Boolean).join(", ") || "—";
  const education = data.education_level || "—";

  let totalCount = "—";
  let roleCount = "—";
  try {
    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
    if (supabaseUrl && supabaseKey) {
      const headers = {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "count=exact"
      };

      const totalRes = await fetch(`${supabaseUrl}/rest/v1/job_applications?select=id&limit=0`, { headers });
      const totalHeader = totalRes.headers.get("content-range");
      if (totalHeader) {
        const match = totalHeader.match(/\/(\d+)/);
        if (match) totalCount = match[1];
      }

      if (role && role !== "Open Role") {
        const roleRes = await fetch(
          `${supabaseUrl}/rest/v1/job_applications?select=id&job_title=eq.${encodeURIComponent(role)}&limit=0`,
          { headers }
        );
        const roleHeader = roleRes.headers.get("content-range");
        if (roleHeader) {
          const match = roleHeader.match(/\/(\d+)/);
          if (match) roleCount = match[1];
        }
      }
    }
  } catch (_e) {}

  const lines = [
    `📋 *New Job Application*`,
    ``,
    `*Role:* ${escMd(role)}`,
    `*Name:* ${escMd(name)}`,
    `*Email:* ${escMd(email)}`,
    `*Phone:* ${escMd(phone)}`,
    `*Location:* ${escMd(location)}`,
    `*Education:* ${escMd(education)}`,
    ``
  ];

  if (totalCount !== "—" || roleCount !== "—") {
    lines.push(`📊 *Total applications:* ${escMd(totalCount)}`);
    if (roleCount !== "—") {
      lines.push(`📌 *For this role:* ${escMd(roleCount)}`);
    }
    lines.push(``);
  }

  lines.push(`View in admin: hocanholdings\\.co\\.ke/admin\\.html`);

  const message = lines.join("\n");

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "MarkdownV2"
      })
    });
    const body = await res.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: body.ok })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

function escMd(text) {
  return String(text || "").replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
