// TEMPORARY — one-off scan of low-rated restaurants around Westlands, Parklands
// and Kilimani, for a single PDF. Deliberately standalone: it shares nothing
// with the jobs/leads pipeline, so deleting this file, the "Restaurants" panel
// in admin.html and its nav item removes it completely.
//
// Three cheap synchronous actions instead of one long one, because a Maps scrape
// takes minutes and Netlify's synchronous functions stop at ~26s:
//   start   -> kicks off the Apify run, returns its ids immediately
//   status  -> polled by the panel until the run finishes
//   results -> reads the dataset, applies the filters, returns the shaped rows

const ACTOR = "compass~crawler-google-places";
const APIFY = "https://api.apify.com/v2";

// The brief: venue overall rating from 2.0 to 3.7, reviews of 3 stars or lower,
// the five lowest per venue.
const MIN_RATING = 2.0;
const MAX_RATING = 3.7;
const MAX_REVIEW_STARS = 3;
const REVIEWS_PER_VENUE = 5;

const AREAS = ["Westlands", "Parklands", "Kilimani"];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

// Constant-time compare, same as the other admin functions.
function passwordMatches(supplied) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  const a = String(supplied || "");
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function token() {
  return (process.env.APIFY_API_Key || process.env.APIFY_API_KEY || process.env.APIFY_TOKEN || "").trim();
}

async function apify(path, options) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${APIFY}${path}${sep}token=${encodeURIComponent(token())}`, options);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_e) { /* leave null */ }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 300);
    throw new Error(`Apify ${res.status}: ${msg}`);
  }
  return data;
}

// Different search terms surface different slices of Google's list, because
// each is capped and ranked by popularity. One term per area returned only ~19
// places, all well rated; many terms reach further down towards the 2.0-3.7
// band, and the results are de-duplicated by place id.
const TERMS = ["restaurant", "cafe", "bar and grill", "bistro", "pub", "eatery", "steakhouse", "pizza", "fast food", "coffee shop"];

/* Two phases, so reviews are only paid for where they can matter.

   Phase "places": every term x area, no reviews. Cheap, and enough to see each
   venue's overall rating.
   Phase "reviews": only the place ids that landed inside the band, with the five
   lowest reviews each. */
async function start(body) {
  const placeIds = Array.isArray(body.placeIds) ? body.placeIds.filter(Boolean).slice(0, 150) : [];
  let input;

  if (placeIds.length) {
    input = {
      searchStringsArray: placeIds.map((id) => `place_id:${id}`),
      language: "en",
      // Five is enough because the sort returns the harshest reviews first.
      maxReviews: REVIEWS_PER_VENUE,
      reviewsSort: String(body.sort || "lowestRanking"),
      // Review text only. Reviewer names, ids, urls and photos are not collected.
      scrapeReviewsPersonalData: false
    };
  } else {
    const perSearch = Math.min(120, Math.max(1, Number(body.limit) || 60));
    const areas = Array.isArray(body.areas) && body.areas.length ? body.areas : AREAS;
    const terms = Array.isArray(body.terms) && body.terms.length ? body.terms : TERMS;
    input = {
      searchStringsArray: areas.flatMap((area) => terms.map((t) => `${t} in ${area}, Nairobi, Kenya`)),
      maxCrawledPlacesPerSearch: perSearch,
      language: "en"
    };
  }

  const run = await apify(`/acts/${ACTOR}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return json(200, {
    ok: true,
    phase: placeIds.length ? "reviews" : "places",
    runId: run.data.id,
    datasetId: run.data.defaultDatasetId,
    searches: input.searchStringsArray.length
  });
}

// What the account has used this month against its cap, so a scan is never
// started blind.
async function limits() {
  const res = await apify("/users/me/limits");
  const d = res.data || {};
  return json(200, {
    ok: true,
    usedUsd: d.current?.monthlyUsageUsd ?? null,
    capUsd: d.limits?.maxMonthlyUsageUsd ?? null
  });
}

async function status(body) {
  const run = await apify(`/actor-runs/${encodeURIComponent(String(body.runId || ""))}`);
  const d = run.data || {};
  return json(200, {
    ok: true,
    status: d.status,
    datasetId: d.defaultDatasetId,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    usageUsd: d.usageTotalUsd ?? null
  });
}

const dayMs = 86400000;

function reviewText(r) {
  return String(r.text || r.textTranslated || "").replace(/\s+/g, " ").trim();
}

/* Apply the brief to the raw places.

   Everything here is arithmetic and string handling — no AI. A venue is kept when
   its overall rating is inside the band and at least one of the reviews we pulled
   is 3 stars or lower; each kept venue carries its five lowest such reviews. */
function shape(items) {
  const seen = new Set();
  const dropped = { outOfBand: 0, closed: 0, noRating: 0, noNegativeReviews: 0, duplicate: 0 };
  const venues = [];

  for (const place of items) {
    const key = place.placeId || `${place.title}|${place.address}`;
    if (seen.has(key)) { dropped.duplicate += 1; continue; }
    seen.add(key);

    if (place.permanentlyClosed || place.temporarilyClosed) { dropped.closed += 1; continue; }

    const rating = Number(place.totalScore);
    if (!Number.isFinite(rating) || rating <= 0) { dropped.noRating += 1; continue; }
    if (rating < MIN_RATING || rating > MAX_RATING) { dropped.outOfBand += 1; continue; }

    const negatives = (Array.isArray(place.reviews) ? place.reviews : [])
      .filter((r) => Number.isFinite(Number(r.stars)) && Number(r.stars) <= MAX_REVIEW_STARS && reviewText(r))
      // Lowest stars first, then most recent, so the five that survive are the
      // harshest and the freshest of them.
      .sort((a, b) =>
        Number(a.stars) - Number(b.stars) ||
        new Date(b.publishedAtDate || 0) - new Date(a.publishedAtDate || 0)
      )
      .slice(0, REVIEWS_PER_VENUE)
      .map((r) => ({
        stars: Number(r.stars),
        text: reviewText(r).slice(0, 420),
        date: r.publishedAtDate || null
      }));

    if (!negatives.length) { dropped.noNegativeReviews += 1; continue; }

    const address = String(place.address || "");
    const area = AREAS.find((a) => new RegExp(a, "i").test(`${address} ${place.neighborhood || ""}`)) ||
      place.neighborhood || "Nairobi";

    venues.push({
      name: place.title,
      area,
      address,
      rating,
      reviewsCount: Number(place.reviewsCount) || 0,
      category: place.categoryName || "",
      phone: place.phone || "",
      website: place.website || "",
      mapsUrl: place.url || "",
      negativeReviews: negatives
    });
  }

  // Most to least promising: lowest rating first, then the most reviews behind it.
  venues.sort((a, b) => a.rating - b.rating || b.reviewsCount - a.reviewsCount);
  return { venues, dropped, scanned: items.length };
}

// The most recent finished run, so a scan started from anywhere can be opened
// from the panel without paying for a second one.
async function latest() {
  const run = await apify(`/acts/${ACTOR}/runs/last?status=SUCCEEDED`);
  const d = run.data || {};
  if (!d.defaultDatasetId) return json(404, { ok: false, error: "No finished scan found yet." });
  return json(200, {
    ok: true,
    datasetId: d.defaultDatasetId,
    finishedAt: d.finishedAt,
    usageUsd: d.usageTotalUsd ?? null
  });
}

async function results(body) {
  const datasetId = String(body.datasetId || "");
  if (!datasetId) return json(400, { ok: false, error: "datasetId is required." });
  const items = await apify(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=2000`);
  const list = Array.isArray(items) ? items : [];
  return json(200, {
    ok: true,
    ...shape(list),
    // Diagnostics: the spread of overall ratings seen, and the order reviews
    // arrive in for the first few places, so the scan depth and the sort value
    // can be judged from real data instead of assumed.
    ratingsSeen: list.map((p) => Number(p.totalScore)).filter(Number.isFinite).sort((a, b) => a - b),
    // Phase 1 output: places inside the band, to fetch reviews for.
    bandPlaces: (() => {
      const seenIds = new Set();
      return list
        .filter((p) => p.placeId && !p.permanentlyClosed && !p.temporarilyClosed)
        .filter((p) => Number(p.totalScore) >= MIN_RATING && Number(p.totalScore) <= MAX_RATING)
        .filter((p) => (seenIds.has(p.placeId) ? false : (seenIds.add(p.placeId), true)))
        .map((p) => ({ placeId: p.placeId, title: p.title, rating: Number(p.totalScore) }));
    })(),
    reviewOrderSample: list.slice(0, 4).map((p) => ({
      title: p.title,
      rating: p.totalScore,
      reviewCount: p.reviewsCount,
      starsInOrder: (Array.isArray(p.reviews) ? p.reviews : []).map((r) => r.stars)
    }))
  });
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_e) { return json(400, { ok: false, error: "Invalid body" }); }

  if (!passwordMatches(body.password)) return json(401, { ok: false, error: "Not authorised." });
  if (!token()) return json(400, { ok: false, error: "APIFY_API_Key is not set in Netlify." });

  try {
    switch (body.action) {
      case "start": return await start(body);
      case "status": return await status(body);
      case "results": return await results(body);
      case "latest": return await latest();
      case "limits": return await limits();
      default: return json(400, { ok: false, error: `Unknown action: ${body.action}` });
    }
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Something went wrong." });
  }
};
