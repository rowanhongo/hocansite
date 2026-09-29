// Deterministic urgency ranking for hiring companies.
//
// This is a script and not the AI on purpose: every signal here is a count or a
// date difference, and language models miscount. The score must also be stable —
// the same jobs must produce the same number today and next week — which an AI
// cannot promise.
//
// Shape: each signal produces a `measure` in 0..1, that measure is multiplied by
// its weight, and the weighted parts are summed. With the default weights
// summing to 100 the score reads as a percentage; if you change the weights so
// they sum to something else, the score is still normalised back to 0..100 so
// old and new scores stay comparable.
//
// Every signal is computed over DEDUPED jobs (one row per real posting), so a
// job seen through five sources counts once and cannot inflate a rank.

const { hasHrRole, seniorityTier, MS_PER_DAY } = require("./job-rules");

const DEFAULT_WEIGHTS = {
  distinct_roles: 25,
  bulk_hiring: 15,
  recency: 20,
  reposts: 10,
  hr_roles: 10,
  seniority: 10,
  persistence: 10
};

// Caps, i.e. the point at which a signal is "as strong as it gets". A company
// with 8 distinct openings and one with 20 are both simply hiring hard; letting
// 20 dominate would drown out every other signal.
const CAPS = {
  distinct_roles: 8,   // 8+ distinct titles = full marks
  bulk_hiring: 6,      // 6+ of one title = full marks
  recency_days: 20,    // linear decay to zero over 20 days
  reposts: 3,          // 3+ reposted roles = full marks
  seniority_tier: 4,   // tier 4 (C-suite/director) = full marks
  persistence: 4       // appearing in 4+ runs = full marks
};

// Human-readable explanation of each signal, rendered in the admin beside the
// weight inputs so the number is never a black box.
const SIGNAL_DOCS = {
  distinct_roles: {
    label: "Distinct open roles",
    why: "More separate positions means real, funded expansion rather than one backfill. Counted on deduped jobs, so the same role seen on five job boards counts once.",
    measure: `min(distinct titles, ${CAPS.distinct_roles}) / ${CAPS.distinct_roles}`
  },
  bulk_hiring: {
    label: "Bulk hiring of one role",
    why: "Several openings for the same title (10 drivers, 6 agents) is the strongest signal for outsourcing and recruitment work — it is volume hiring they probably cannot staff alone.",
    measure: `min(largest count for one title - 1, ${CAPS.bulk_hiring - 1}) / ${CAPS.bulk_hiring - 1}`
  },
  recency: {
    label: "Recency",
    why: "A need advertised three days ago is live; one from three weeks ago may already be filled. Decays linearly from the newest posting's date.",
    measure: `max(0, 1 - days since newest posting / ${CAPS.recency_days})`
  },
  reposts: {
    label: "Reposted roles",
    why: "Re-advertising the same role means their own hiring is not working — the clearest opening for our recruitment service. Counted as distinct titles seen at more than one canonical URL.",
    measure: `min(reposted titles, ${CAPS.reposts}) / ${CAPS.reposts}`
  },
  hr_roles: {
    label: "HR or people roles",
    why: "A company hiring HR staff is actively building people capability, so HR consulting, training and HR360 are an easy fit. It also often means there is no HR function yet to say no to us.",
    measure: "1 if any HR/recruiting/people/payroll/L&D title, else 0"
  },
  seniority: {
    label: "Seniority",
    why: "Senior and executive openings mean budget authority and structural change. Uses the most senior title on offer.",
    measure: `highest seniority tier / ${CAPS.seniority_tier} (4 = chief/director/head, 3 = manager, 2 = senior/officer, 1 = junior/intern)`
  },
  persistence: {
    label: "Appearances across runs and sources",
    why: "A company showing up week after week is hiring continuously, not once. Sustained demand is worth more than a single spike.",
    measure: `min(distinct runs - 1, ${CAPS.persistence - 1}) / ${CAPS.persistence - 1}`
  }
};

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function mergeWeights(weights) {
  const merged = { ...DEFAULT_WEIGHTS };
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = Number(weights?.[key]);
    // A weight of 0 is meaningful ("ignore this signal"), so only a
    // non-numeric value falls back to the default.
    if (Number.isFinite(value) && value >= 0) merged[key] = value;
  }
  return merged;
}

/* Reduce a company's deduped jobs to the raw facts the score needs.

   `jobs` is an array of scraped_jobs rows for one company. Everything here is a
   count over that array — no job is counted twice, because the array itself is
   already one row per real posting. */
function aggregateCompany(jobs, now) {
  const reference = now instanceof Date ? now : new Date(now || Date.now());
  const rows = Array.isArray(jobs) ? jobs : [];

  // Group by normalised title so "Sales Agent" and "sales  agent" are one role.
  const byTitle = new Map();
  const runIds = new Set();
  const sources = new Set();
  let newest = null;
  let oldest = null;
  let maxTier = 0;
  let anyHr = false;

  for (const job of rows) {
    const titleKey = String(job.title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!byTitle.has(titleKey)) {
      byTitle.set(titleKey, { title: job.title || "", count: 0, urls: new Set(), newest_posted_at: null });
    }
    const group = byTitle.get(titleKey);
    group.count += 1;
    if (job.canonical_url) group.urls.add(job.canonical_url);

    const posted = job.posted_at ? new Date(job.posted_at) : null;
    if (posted && Number.isFinite(posted.getTime())) {
      if (!group.newest_posted_at || posted > new Date(group.newest_posted_at)) {
        group.newest_posted_at = posted.toISOString();
      }
      if (!newest || posted > newest) newest = posted;
      if (!oldest || posted < oldest) oldest = posted;
    }

    for (const runId of job.run_ids || []) runIds.add(runId);
    const jobSources = Array.isArray(job.sources) ? job.sources : [];
    for (const src of jobSources) {
      if (src?.via) sources.add(String(src.via));
      else if (src?.applySource) sources.add(String(src.applySource));
    }

    if (hasHrRole(job.title)) anyHr = true;
    const tier = seniorityTier(job.title);
    if (tier > maxTier) maxTier = tier;
  }

  const roles = [...byTitle.values()]
    .map((g) => ({
      title: g.title,
      count: g.count,
      url_count: g.urls.size,
      newest_posted_at: g.newest_posted_at
    }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));

  // A repost is one title advertised at more than one canonical URL. Counting
  // *titles* rather than *extra URLs* keeps one heavily-reposted role from
  // looking like a company-wide pattern.
  const repostCount = roles.filter((r) => r.url_count > 1).length;
  const maxRoleCount = roles.reduce((max, r) => Math.max(max, r.count), 0);
  const daysSinceNewest = newest
    ? Math.max(0, (reference.getTime() - newest.getTime()) / MS_PER_DAY)
    : null;

  return {
    roles,
    distinct_role_count: roles.length,
    total_job_count: rows.length,
    max_role_count: maxRoleCount,
    repost_count: repostCount,
    has_hr_role: anyHr,
    seniority_tier: maxTier,
    newest_posted_at: newest ? newest.toISOString() : null,
    oldest_posted_at: oldest ? oldest.toISOString() : null,
    days_since_newest: daysSinceNewest,
    run_appearance_count: Math.max(1, runIds.size),
    sources: [...sources]
  };
}

/* Turn aggregated facts into a 0-100 score plus a per-signal breakdown.

   The breakdown is stored alongside the score so the admin can show exactly
   which signals produced a rank, and so changing a weight visibly moves the
   parts it should move and nothing else. */
function scoreCompany(aggregate, weights) {
  const w = mergeWeights(weights);
  const a = aggregate || {};

  const measures = {
    distinct_roles: clamp01(Math.min(a.distinct_role_count || 0, CAPS.distinct_roles) / CAPS.distinct_roles),

    // -1 because a single posting is not "bulk"; two is the first real signal.
    bulk_hiring: clamp01(
      Math.min(Math.max((a.max_role_count || 0) - 1, 0), CAPS.bulk_hiring - 1) / (CAPS.bulk_hiring - 1)
    ),

    // No known date scores 0 rather than full marks: absence of evidence must
    // not read as freshness.
    recency: a.days_since_newest === null || a.days_since_newest === undefined
      ? 0
      : clamp01(1 - a.days_since_newest / CAPS.recency_days),

    reposts: clamp01(Math.min(a.repost_count || 0, CAPS.reposts) / CAPS.reposts),

    hr_roles: a.has_hr_role ? 1 : 0,

    seniority: clamp01((a.seniority_tier || 0) / CAPS.seniority_tier),

    persistence: clamp01(
      Math.min(Math.max((a.run_appearance_count || 1) - 1, 0), CAPS.persistence - 1) / (CAPS.persistence - 1)
    )
  };

  const breakdown = {};
  let total = 0;
  let weightSum = 0;
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const weight = w[key];
    const measure = measures[key];
    const points = weight * measure;
    breakdown[key] = {
      weight,
      measure: Math.round(measure * 1000) / 1000,
      points: Math.round(points * 100) / 100
    };
    total += points;
    weightSum += weight;
  }

  // Normalise so the score stays a 0-100 reading after the weights are edited.
  // Guard the all-zero case, which would otherwise divide by zero.
  const score = weightSum > 0 ? (total / weightSum) * 100 : 0;

  return {
    score: Math.round(score * 10) / 10,
    breakdown: {
      signals: breakdown,
      weight_sum: weightSum,
      raw_total: Math.round(total * 100) / 100,
      computed_at: new Date().toISOString()
    }
  };
}

module.exports = {
  DEFAULT_WEIGHTS,
  CAPS,
  SIGNAL_DOCS,
  aggregateCompany,
  scoreCompany,
  mergeWeights
};
