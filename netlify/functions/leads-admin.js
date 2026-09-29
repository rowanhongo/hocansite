// Read and write path for the Leads and Jobs Feed admin panels.
//
// The leads tables have RLS enabled with NO policies, which denies the anon key
// even for reads — unlike bio_links, none of this is public. So every read as
// well as every write comes through here, checked against ADMIN_PASSWORD and
// performed with the service role key.
//
// Pagination is capped at 30 rows everywhere, per the brief.

const db = require("./lib/supabase-rest");
const ingest = require("./lib/ingest");
const urgency = require("./lib/urgency");
const gemini = require("./lib/gemini");
const links = require("./lib/link-check");
const rules = require("./lib/job-rules");

const MAX_PER_PAGE = 30;
const ACTOR_ID = process.env.APIFY_ACTOR_ID || "inovaflow/google-jobs-scraper";
const VALID_STATUSES = ["new", "contacted", "replied", "won", "rejected"];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

// Constant-time compare, matching bio-links-admin.js: a caller must not be able
// to learn the password one character at a time from response timing.
function passwordMatches(supplied) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  const a = String(supplied || "");
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function paging(body) {
  const page = Math.max(1, Number(body.page || 1));
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(body.perPage || MAX_PER_PAGE)));
  return { page, perPage, offset: (page - 1) * perPage };
}

// PostgREST `in.(...)` needs each value quoted and its quotes escaped.
function inList(values) {
  return `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;
}

// Free-text search has to be escaped or a `%` or `,` in the query breaks the
// filter — or worse, matches far more than intended.
function likeValue(term) {
  return String(term || "").replace(/[%_,()*]/g, " ").trim();
}

async function withCount(pathAndQuery) {
  const { data, headers } = await db.request(pathAndQuery, {
    headers: { Prefer: "count=exact" },
    returnHeaders: true
  });
  const range = headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return { rows: data || [], total: Number.isFinite(total) ? total : (data || []).length };
}

// ── Overview ────────────────────────────────────────────────────────────────

async function getOverview() {
  const settings = await ingest.loadSettings();

  const [runs, listRows] = await Promise.all([
    db.select("job_ingest_runs?select=*&order=created_at.desc&limit=5"),
    db.select("job_seeker_lists?select=id,week_of,title,item_count,published_at&order=published_at.desc&limit=4")
  ]);

  const maxAge = Number(settings.max_job_age_days || 20);
  const cutoff = new Date(Date.now() - maxAge * rules.MS_PER_DAY).toISOString();

  const [totalJobs, eligibleJobs, deadLinks, flaggedJobs, totalCompanies, newCompanies, contactedCompanies, aiPending] =
    await Promise.all([
      db.count("scraped_jobs?select=id"),
      db.count(`scraped_jobs?select=id&excluded_reason=is.null&featured_in_list_id=is.null&link_status=eq.live&posted_at=gte.${cutoff}`),
      db.count("scraped_jobs?select=id&link_status=eq.dead"),
      db.count("scraped_jobs?select=id&ai_flagged=is.true&featured_in_list_id=is.null"),
      db.count("company_leads?select=id&excluded_reason=is.null"),
      db.count("company_leads?select=id&excluded_reason=is.null&status=eq.new"),
      db.count("company_leads?select=id&status=in.(contacted,replied,won)"),
      db.count("company_leads?select=id&ai_status=in.(pending,quota)&excluded_reason=is.null")
    ]);

  return json(200, {
    ok: true,
    settings: {
      urgency_weights: settings.urgency_weights || urgency.DEFAULT_WEIGHTS,
      max_job_age_days: maxAge,
      link_recheck_days: Number(settings.link_recheck_days || 7),
      agency_blocklist: settings.agency_blocklist || [],
      competitor_blocklist: settings.competitor_blocklist || [],
      services_description: settings.services_description || ""
    },
    signalDocs: urgency.SIGNAL_DOCS,
    defaultWeights: urgency.DEFAULT_WEIGHTS,
    geminiConfigured: gemini.isConfigured(),
    apifyConfigured: Boolean(ingest.getApifyToken()),
    webhookConfigured: Boolean(process.env.APIFY_WEBHOOK_SECRET),
    actorId: ACTOR_ID,
    runs: runs || [],
    lists: listRows || [],
    stats: {
      totalJobs,
      eligibleJobs,
      deadLinks,
      flaggedJobs,
      totalCompanies,
      newCompanies,
      contactedCompanies,
      aiPending
    }
  });
}

// ── Jobs feed ───────────────────────────────────────────────────────────────

/* Paged job list.

   Ordering is fixed by the brief and not a user choice: posted date newest
   first, ties broken by first_seen. */
async function getJobs(body) {
  const { page, perPage, offset } = paging(body);
  const filters = [];

  const view = String(body.view || "eligible");
  const settings = await ingest.loadSettings();
  const maxAge = Number(settings.max_job_age_days || 20);
  const cutoff = new Date(Date.now() - maxAge * rules.MS_PER_DAY).toISOString();

  if (view === "eligible") {
    filters.push("excluded_reason=is.null", "featured_in_list_id=is.null", "link_status=eq.live", "ai_flagged=is.false", `posted_at=gte.${cutoff}`);
  } else if (view === "featured") {
    filters.push("featured_in_list_id=not.is.null");
  } else if (view === "excluded") {
    filters.push("excluded_reason=not.is.null");
  } else if (view === "dead") {
    filters.push("link_status=eq.dead");
  } else if (view === "flagged") {
    filters.push("ai_flagged=is.true");
  }
  // view === 'all' adds nothing.

  const search = likeValue(body.search);
  if (search) {
    filters.push(`or=(title.ilike.*${encodeURIComponent(search)}*,company.ilike.*${encodeURIComponent(search)}*)`);
  }

  const query =
    "scraped_jobs?select=id,title,company,location,employment_type,salary_text,posted_at,posted_is_exact," +
    "first_seen,last_seen,sources,canonical_url,raw_url,summary,link_status,link_checked_at,link_status_code," +
    "excluded_reason,ai_flagged,ai_flag_reason,featured_in_list_id,featured_at" +
    (filters.length ? `&${filters.join("&")}` : "") +
    "&order=posted_at.desc.nullslast,first_seen.desc" +
    `&limit=${perPage}&offset=${offset}`;

  const { rows, total } = await withCount(query);

  return json(200, {
    ok: true,
    page,
    perPage,
    total,
    jobs: (rows || []).map((r) => ({
      ...r,
      // Collapse the sightings into a readable source list for the table.
      source_list: [...new Set((Array.isArray(r.sources) ? r.sources : []).map((s) => s.via || s.applySource).filter(Boolean))]
    }))
  });
}

// ── Company leads ───────────────────────────────────────────────────────────

async function getCompanies(body) {
  const { page, perPage, offset } = paging(body);
  const filters = [];

  const status = String(body.status || "all");
  if (status !== "all" && VALID_STATUSES.includes(status)) {
    filters.push(`status=eq.${status}`);
  }

  // Excluded leads are hidden unless asked for: a rejected agency should not sit
  // in the working list.
  if (body.includeExcluded) {
    if (String(body.view || "") === "excluded") filters.push("excluded_reason=not.is.null");
  } else {
    filters.push("excluded_reason=is.null");
  }

  const search = likeValue(body.search);
  if (search) filters.push(`company=ilike.*${encodeURIComponent(search)}*`);

  const minFit = Number(body.minFit);
  if (Number.isFinite(minFit) && minFit > 0) filters.push(`ai_fit_score=gte.${minFit}`);

  // Urgency first by default — that is the point of the ranking — with a couple
  // of alternatives for working the pipeline.
  const sortMap = {
    urgency: "urgency_score.desc,newest_posted_at.desc.nullslast",
    fit: "ai_fit_score.desc.nullslast,urgency_score.desc",
    recent: "newest_posted_at.desc.nullslast,urgency_score.desc",
    company: "company.asc",
    openings: "total_job_count.desc,urgency_score.desc"
  };
  const order = sortMap[String(body.sort || "urgency")] || sortMap.urgency;

  const query =
    "company_leads?select=*" +
    (filters.length ? `&${filters.join("&")}` : "") +
    `&order=${order}` +
    `&limit=${perPage}&offset=${offset}`;

  const { rows, total } = await withCount(query);
  return json(200, { ok: true, page, perPage, total, companies: rows || [] });
}

/* The jobs behind one company, for the expand-a-row view.

   Shown so the urgency number can be checked against the postings that produced
   it — a score nobody can audit is a score nobody trusts. */
async function getCompanyJobs(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Company id is required." });

  const rows = await db.select(`company_leads?select=company,company_key&id=eq.${encodeURIComponent(id)}&limit=1`);
  const lead = Array.isArray(rows) ? rows[0] : null;
  if (!lead) return json(404, { ok: false, error: "Company not found." });

  // company_key is not stored on scraped_jobs, so match on the name and filter
  // in memory with the same key function that grouped them.
  const jobs = await db.select(
    `scraped_jobs?select=id,title,location,posted_at,posted_is_exact,first_seen,canonical_url,raw_url,` +
      `link_status,excluded_reason,featured_at,sources,company` +
      `&company=ilike.*${encodeURIComponent(likeValue(lead.company))}*` +
      "&order=posted_at.desc.nullslast,first_seen.desc&limit=100"
  );

  const matching = (jobs || []).filter((j) => rules.companyKey(j.company) === lead.company_key);

  return json(200, {
    ok: true,
    company: lead.company,
    jobs: matching.map((j) => ({
      ...j,
      source_list: [...new Set((Array.isArray(j.sources) ? j.sources : []).map((s) => s.via || s.applySource).filter(Boolean))]
    }))
  });
}

async function updateCompany(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Company id is required." });

  const patch = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!VALID_STATUSES.includes(status)) {
      return json(400, { ok: false, error: `Status must be one of: ${VALID_STATUSES.join(", ")}` });
    }
    patch.status = status;
    patch.status_changed_at = new Date().toISOString();
  }

  if (body.notes !== undefined) patch.notes = String(body.notes || "").slice(0, 5000) || null;
  if (body.website !== undefined) {
    const site = String(body.website || "").trim();
    // Only plain http(s): anything else rendered as a link in the admin would be
    // an XSS vector.
    if (site && !/^https?:\/\//i.test(site)) {
      return json(400, { ok: false, error: "Website must start with http:// or https://" });
    }
    patch.website = site || null;
  }
  if (body.industry !== undefined) patch.industry = String(body.industry || "").slice(0, 120) || null;
  if (body.company_size !== undefined) patch.company_size = String(body.company_size || "").slice(0, 60) || null;
  if (body.markReviewed) patch.last_reviewed_at = new Date().toISOString();

  const updated = await db.update(`company_leads?id=eq.${encodeURIComponent(id)}`, patch, "return=representation");
  return json(200, { ok: true, company: Array.isArray(updated) ? updated[0] : updated });
}

async function deleteCompany(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Company id is required." });
  // The confirmation itself lives in the UI; the server requires the caller to
  // have said so explicitly, so a stray request cannot delete a lead.
  if (body.confirm !== true) return json(400, { ok: false, error: "Deletion must be confirmed." });

  await db.remove(`company_leads?id=eq.${encodeURIComponent(id)}`);
  return json(200, { ok: true, message: "Lead deleted." });
}

async function deleteJob(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Job id is required." });
  if (body.confirm !== true) return json(400, { ok: false, error: "Deletion must be confirmed." });

  await db.remove(`scraped_jobs?id=eq.${encodeURIComponent(id)}`);
  return json(200, { ok: true, message: "Job deleted." });
}

/* Clear a job's AI flag.

   The flag is advisory, so the admin needs a way to say "this is a real
   employer" and put the job back in the running. */
async function clearJobFlag(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "Job id is required." });
  await db.update(`scraped_jobs?id=eq.${encodeURIComponent(id)}`, {
    ai_flagged: false,
    ai_flag_reason: null,
    updated_at: new Date().toISOString()
  });
  return json(200, { ok: true, message: "Flag cleared. The job is eligible again." });
}

// ── Lists ───────────────────────────────────────────────────────────────────

async function getLists(body) {
  const { page, perPage, offset } = paging(body);
  const { rows, total } = await withCount(
    "job_seeker_lists?select=id,week_of,title,item_count,excluded_count,dead_link_count,published_at" +
      `&order=published_at.desc&limit=${perPage}&offset=${offset}`
  );
  return json(200, { ok: true, page, perPage, total, lists: rows || [] });
}

/* One list's frozen items, for the PDF.

   Read straight from the snapshot, never re-derived: an old PDF must regenerate
   identically even after the jobs table has moved on. */
async function getList(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "List id is required." });
  const rows = await db.select(`job_seeker_lists?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  const list = Array.isArray(rows) ? rows[0] : null;
  if (!list) return json(404, { ok: false, error: "List not found." });
  return json(200, { ok: true, list });
}

/* Preview what the next list would contain, without publishing.

   Read-only: nothing is marked featured. Lets the operator see the week's
   selection (and why jobs were dropped) before the scheduled run commits it. */
async function previewList(body) {
  const settings = await ingest.loadSettings();
  const state = gemini.newState();
  // Skip the Gemini repost pass on a preview unless asked: it costs quota, and a
  // preview is usually about "is there anything there at all".
  const selection = body.withAi
    ? await ingest.selectListCandidates(settings, state)
    : await ingest.selectListCandidates(settings, { calls: gemini.MAX_CALLS_PER_INVOCATION, lastCallAt: 0 });

  // Same field names as a published list's frozen items, so the admin can hand
  // a preview straight to the PDF builder without a second mapping.
  const items = selection.items.map((c) => ({
    id: c.id,
    title: c.title,
    company: c.company,
    location: c.location || "",
    posted_at: c.posted_at,
    posted_is_exact: Boolean(c.posted_is_exact),
    employment_type: c.employment_type || "",
    apply_url: c.raw_url || c.canonical_url,
    summary: c.summary || "",
    source: [...new Set((Array.isArray(c.sources) ? c.sources : []).map((s) => s.via || s.applySource).filter(Boolean))].join(", ") || "—"
  }));

  return json(200, {
    ok: true,
    count: items.length,
    stats: selection.stats,
    quota: selection.quota,
    // The table shows a page; `items` carries the full set so a draft PDF is
    // the whole list rather than the first 30.
    items: items.slice(0, MAX_PER_PAGE),
    allItems: items
  });
}

/* Publish a list now, outside the weekly schedule.

   Irreversible — it marks jobs featured — so it is a deliberate action with its
   own confirmation in the UI. */
async function publishNow(body) {
  if (body.confirm !== true) {
    return json(400, { ok: false, error: "Publishing must be confirmed: featured jobs never appear in a later list." });
  }
  const settings = await ingest.loadSettings();
  const state = gemini.newState();
  const selection = await ingest.selectListCandidates(settings, state);
  if (!selection.items.length) {
    return json(200, { ok: true, published: false, message: "No eligible jobs to publish.", stats: selection.stats });
  }
  await ingest.summarizeForList(selection.items, state);
  const list = await ingest.publishList(selection.items, selection.stats, settings, body.title);
  return json(200, { ok: true, published: true, list, stats: selection.stats });
}

async function deleteList(body) {
  const id = String(body.id || "").trim();
  if (!id) return json(400, { ok: false, error: "List id is required." });
  if (body.confirm !== true) return json(400, { ok: false, error: "Deletion must be confirmed." });

  // The jobs stay marked featured on purpose: deleting the PDF history must not
  // make already-published jobs eligible again.
  await db.remove(`job_seeker_lists?id=eq.${encodeURIComponent(id)}`);
  return json(200, { ok: true, message: "List deleted. Its jobs stay marked as already featured." });
}

// ── Settings ────────────────────────────────────────────────────────────────

async function saveSettings(body) {
  const current = await ingest.loadSettings();
  const patch = { updated_at: new Date().toISOString() };

  if (body.urgency_weights) {
    const weights = {};
    for (const key of Object.keys(urgency.DEFAULT_WEIGHTS)) {
      const value = Number(body.urgency_weights[key]);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return json(400, { ok: false, error: `Weight "${key}" must be a number between 0 and 100.` });
      }
      weights[key] = value;
    }
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum <= 0) return json(400, { ok: false, error: "At least one weight must be above zero." });
    patch.urgency_weights = weights;
  }

  if (body.max_job_age_days !== undefined) {
    const days = Number(body.max_job_age_days);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return json(400, { ok: false, error: "Max job age must be between 1 and 90 days." });
    }
    patch.max_job_age_days = Math.round(days);
  }

  if (body.link_recheck_days !== undefined) {
    const days = Number(body.link_recheck_days);
    if (!Number.isFinite(days) || days < 1 || days > 60) {
      return json(400, { ok: false, error: "Link re-check window must be between 1 and 60 days." });
    }
    patch.link_recheck_days = Math.round(days);
  }

  const cleanList = (value) =>
    String(value || "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 300);

  if (body.agency_blocklist !== undefined) {
    patch.agency_blocklist = Array.isArray(body.agency_blocklist) ? body.agency_blocklist : cleanList(body.agency_blocklist);
  }
  if (body.competitor_blocklist !== undefined) {
    patch.competitor_blocklist = Array.isArray(body.competitor_blocklist)
      ? body.competitor_blocklist
      : cleanList(body.competitor_blocklist);
  }
  if (body.services_description !== undefined) {
    patch.services_description = String(body.services_description || "").slice(0, 4000);
  }

  await db.update(`bd_settings?id=eq.${encodeURIComponent(current.id)}`, patch);

  // A weight change is meaningless until the scores move, so rescore straight
  // away rather than leaving the table showing numbers from the old formula.
  let rescored = 0;
  if (patch.urgency_weights) {
    const updated = await ingest.loadSettings();
    const result = await ingest.rescoreAllCompanies(updated);
    rescored = result.updated;
  }

  return json(200, { ok: true, rescored, message: rescored ? `Saved. ${rescored} leads rescored.` : "Saved." });
}

/* Show what a set of weights would do before committing them.

   Pure arithmetic over the stored aggregates, so it costs one read and no
   recompute — the operator can try numbers freely. */
async function previewWeights(body) {
  const weights = urgency.mergeWeights(body.urgency_weights || {});
  const rows = await db.select(
    "company_leads?select=id,company,distinct_role_count,total_job_count,max_role_count,repost_count," +
      "has_hr_role,seniority_tier,newest_posted_at,run_appearance_count,urgency_score" +
      "&excluded_reason=is.null&order=urgency_score.desc&limit=15"
  );

  const preview = (rows || []).map((row) => {
    const daysSinceNewest = row.newest_posted_at
      ? Math.max(0, (Date.now() - new Date(row.newest_posted_at).getTime()) / rules.MS_PER_DAY)
      : null;
    const { score, breakdown } = urgency.scoreCompany({ ...row, days_since_newest: daysSinceNewest }, weights);
    return { id: row.id, company: row.company, current: Number(row.urgency_score), proposed: score, breakdown };
  });

  preview.sort((a, b) => b.proposed - a.proposed);
  return json(200, { ok: true, weights, preview });
}

// ── Sync and AI actions ─────────────────────────────────────────────────────

/* Manual sync: pull the actor's last successful run.

   The webhook is the normal path; this is the fallback for a missed webhook or
   a first backfill. Synchronous, so it must stay inside the 10s limit — which is
   why publish defaults to false and the link/AI work is bounded. */
async function syncNow(body) {
  const token = ingest.getApifyToken();
  if (!token) return json(400, { ok: false, error: "APIFY_API_Key is not set in Netlify." });

  let datasetId = String(body.datasetId || "").trim();
  let runId = String(body.runId || "").trim() || null;
  let scrapedAt = null;

  if (!datasetId) {
    const run = await ingest.fetchLastSuccessfulRun(ACTOR_ID, token);
    if (!run?.defaultDatasetId) {
      return json(400, { ok: false, error: "No successful Apify run found for this actor." });
    }
    datasetId = run.defaultDatasetId;
    runId = run.id;
    scrapedAt = run.finishedAt || run.startedAt;
  }

  const result = await ingest.ingestDataset({
    datasetId,
    runId,
    scrapedAt: scrapedAt || new Date().toISOString(),
    publish: body.publish === true
  });

  return json(200, {
    ok: true,
    itemsReceived: result.itemsReceived,
    skipped: result.skipped,
    inserted: result.inserted,
    updated: result.updated,
    companiesTouched: result.companies.touched,
    linksChecked: result.links.checked,
    linksDead: result.links.dead,
    aiReviewed: result.reviewed,
    aiPending: result.aiPending,
    aiQuotaHit: result.aiQuotaHit,
    unmapped: result.unmapped,
    list: result.list
  });
}

/* Finish an AI review that a quota stop interrupted. */
async function resumeAiReview() {
  if (!gemini.isConfigured()) {
    return json(400, { ok: false, error: "Gemini_API_Key is not set in Netlify." });
  }
  const settings = await ingest.loadSettings();
  const state = gemini.newState();
  const result = await ingest.runCompanyReview(settings, state, 60);
  return json(200, {
    ok: true,
    reviewed: result.reviewed,
    stillPending: result.pending,
    quotaHit: result.quota,
    message: result.quota
      ? `Reviewed ${result.reviewed}. Quota reached again — ${result.pending} still waiting.`
      : `Reviewed ${result.reviewed} companies.`
  });
}

async function recheckLinks(body) {
  const settings = await ingest.loadSettings();

  // A single job, re-checked on demand from its row.
  const id = String(body.id || "").trim();
  if (id) {
    const rows = await db.select(`scraped_jobs?select=id,canonical_url,raw_url&id=eq.${encodeURIComponent(id)}&limit=1`);
    const job = Array.isArray(rows) ? rows[0] : null;
    if (!job) return json(404, { ok: false, error: "Job not found." });
    const result = await links.checkUrl(job.raw_url || job.canonical_url);
    await db.update(`scraped_jobs?id=eq.${encodeURIComponent(id)}`, {
      link_status: result.status,
      link_checked_at: new Date().toISOString(),
      link_status_code: result.code ?? null
    });
    return json(200, { ok: true, status: result.status, code: result.code, note: result.note });
  }

  // Bounded batch: this runs synchronously inside the 10s limit.
  const result = await ingest.checkJobLinks(settings, Math.min(60, Number(body.limit) || 60));
  return json(200, { ok: true, checked: result.checked, dead: result.dead });
}

async function rescoreAll() {
  const settings = await ingest.loadSettings();
  const result = await ingest.rescoreAllCompanies(settings);
  return json(200, { ok: true, updated: result.updated, message: `Rescored ${result.updated} leads.` });
}

// ── Handler ─────────────────────────────────────────────────────────────────

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
      case "overview": return await getOverview();
      case "jobs": return await getJobs(body);
      case "companies": return await getCompanies(body);
      case "companyJobs": return await getCompanyJobs(body);
      case "updateCompany": return await updateCompany(body);
      case "deleteCompany": return await deleteCompany(body);
      case "deleteJob": return await deleteJob(body);
      case "clearJobFlag": return await clearJobFlag(body);
      case "lists": return await getLists(body);
      case "list": return await getList(body);
      case "previewList": return await previewList(body);
      case "publishNow": return await publishNow(body);
      case "deleteList": return await deleteList(body);
      case "saveSettings": return await saveSettings(body);
      case "previewWeights": return await previewWeights(body);
      case "syncNow": return await syncNow(body);
      case "resumeAiReview": return await resumeAiReview();
      case "recheckLinks": return await recheckLinks(body);
      case "rescoreAll": return await rescoreAll();
      default: return json(400, { ok: false, error: `Unknown action: ${body.action}` });
    }
  } catch (error) {
    // The "you have not run the migration yet" case is by far the most likely
    // first failure, so it gets a plain instruction rather than a Postgres dump.
    if (error instanceof db.RestError && error.missingTable) {
      return json(400, {
        ok: false,
        setupRequired: true,
        error: "The leads tables are missing. Run supabase/migrations/20260929120000_leads_and_jobs.sql first."
      });
    }
    return json(500, { ok: false, error: error.message || "Something went wrong." });
  }
};
