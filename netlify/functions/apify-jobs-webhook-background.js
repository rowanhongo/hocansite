// Apify calls this when the Nairobi jobs scraper finishes a run.
//
// Set it up once in the Apify console (Actor → Integrations → Webhooks):
//   Event:   ACTOR.RUN.SUCCEEDED
//   URL:     https://hocanholdings.co.ke/.netlify/functions/apify-jobs-webhook-background?secret=<APIFY_WEBHOOK_SECRET>
//   Payload: leave as the default template
//
// A shared secret rather than a signature because Apify's default webhook does
// not sign the body. The secret is compared in constant time and the endpoint
// does nothing at all without it, so the URL is the credential — treat it as one.
//
// The `-background` filename suffix is what makes this a background function:
// Netlify answers Apify with an immediate 202 and keeps the handler running for
// up to 15 minutes. The full pipeline (dataset fetch, link checks, several
// Gemini calls) comfortably exceeds the 10-second synchronous limit.
//
// The suffix is used rather than `export const config = { background: true }`
// because that form belongs to Netlify's modern ESM handler signature, and this
// project's functions are all legacy CommonJS `exports.handler`. The suffix is
// documented as fully supported and works with both.

const ingest = require("./lib/ingest");
const db = require("./lib/supabase-rest");

function secretMatches(supplied) {
  const expected = process.env.APIFY_WEBHOOK_SECRET || "";
  if (!expected) return false;
  const a = String(supplied || "");
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

/* Pull the dataset id out of whatever shape the webhook arrives in.

   Apify's default payload template nests the run under `resource`, but a custom
   template or an ad-hoc call may send the ids flat. Both are accepted so a
   console misconfiguration does not look like a broken integration. */
function extractRun(body) {
  const resource = body?.resource || body?.run || {};
  return {
    runId: body?.runId || resource?.id || body?.eventData?.actorRunId || null,
    datasetId: body?.datasetId || resource?.defaultDatasetId || body?.defaultDatasetId || null,
    startedAt: resource?.startedAt || body?.startedAt || null,
    finishedAt: resource?.finishedAt || body?.finishedAt || null,
    status: resource?.status || body?.status || null,
    stats: resource?.stats || {}
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const supplied =
    event.queryStringParameters?.secret ||
    event.headers?.["x-apify-webhook-secret"] ||
    event.headers?.["x-webhook-secret"] ||
    "";

  if (!secretMatches(supplied)) {
    // Deliberately vague: an attacker probing the URL learns nothing about
    // whether the secret exists or merely mismatched.
    return json(401, { ok: false, error: "Unauthorised" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_e) {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const run = extractRun(body);

  if (!run.datasetId) {
    return json(400, { ok: false, error: "No dataset id in the webhook payload." });
  }

  // A failed or aborted run has nothing worth ingesting, but it is worth
  // recording so a run of silence in the admin is explained.
  if (run.status && run.status !== "SUCCEEDED") {
    await db
      .insert("job_ingest_runs", [
        {
          apify_run_id: run.runId,
          apify_dataset_id: run.datasetId,
          scraped_at: run.finishedAt || new Date().toISOString(),
          status: "skipped",
          error: `Apify run status was ${run.status}; nothing ingested.`
        }
      ])
      .catch(() => null);
    return json(200, { ok: true, skipped: true, status: run.status });
  }

  try {
    // Relative dates ("3 days ago") are resolved against when the scrape
    // finished, not against now — the webhook can arrive minutes later, and on a
    // retry, hours later.
    const result = await ingest.ingestDataset({
      datasetId: run.datasetId,
      runId: run.runId,
      scrapedAt: run.finishedAt || run.startedAt || new Date().toISOString(),
      publish: true,
      reportedTotals: {
        totalJobs: run.stats?.totalJobs,
        totalCompanies: run.stats?.totalCompanies
      }
    });

    return json(200, {
      ok: true,
      itemsReceived: result.itemsReceived,
      inserted: result.inserted,
      updated: result.updated,
      companiesTouched: result.companies.touched,
      linksChecked: result.links.checked,
      linksDead: result.links.dead,
      listId: result.list?.id || null,
      listCount: result.list?.item_count || 0,
      aiReviewed: result.reviewed,
      aiPending: result.aiPending,
      aiQuotaHit: result.aiQuotaHit,
      unmapped: result.unmapped
    });
  } catch (error) {
    // Record the failure so the admin shows a real error instead of a stale
    // "last synced" timestamp that implies everything is fine.
    await db
      .insert("job_ingest_runs", [
        {
          apify_run_id: run.runId,
          apify_dataset_id: run.datasetId,
          scraped_at: run.finishedAt || new Date().toISOString(),
          status: "error",
          error: String(error.message || error).slice(0, 500)
        }
      ])
      .catch(() => null);

    return json(500, { ok: false, error: error.message || "Ingest failed" });
  }
};
