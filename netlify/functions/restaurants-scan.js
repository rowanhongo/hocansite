// TEMPORARY — one-off scan of below-median restaurants around Westlands,
// Parklands and Kilimani, for a single lead-team report. Deliberately standalone:
// it shares nothing with the jobs/leads pipeline, so deleting this file, the
// "Restaurants" panel in admin.html and its nav item removes it completely.
//
// Cheap synchronous actions instead of one long one, because a Maps scrape
// takes minutes and Netlify's synchronous functions stop at ~26s:
//   start   -> kicks off an Apify run and returns its ids immediately
//   status  -> polled until the run finishes
//   places  -> reads a places dataset, returns the venues inside the band
//   report  -> reads the finished datasets and returns the whole report payload
//
// Review text and place data stay in Apify and are read through this function
// behind the admin password; nothing scraped is committed to the repository.

const ACTOR = "compass~crawler-google-places";
const APIFY = "https://api.apify.com/v2";

// The brief: venues rated 2.0 to 4.4 (4.4 is the median of the places scanned),
// and reviews of 3 stars or lower that mention staff, a manager or a waiter.
const MIN_RATING = 2.0;
const MAX_RATING = 4.4;
const MAX_REVIEW_STARS = 3;
const REVIEWS_PER_VENUE = 2;

const AREAS = ["Westlands", "Parklands", "Kilimani"];

// Sent to Google so only reviews containing these words come back at all.
const STAFF_FILTER = "staff waiter waitress manager";
// Applied again here, because Google's matching is looser than a word match and
// "staff" inside "staffing" or a name should not count as a complaint.
const STAFF_RE = /\b(staff|waiters?|waitress(es)?|managers?|management)\b/i;

/* Apify dataset ids, which are only readable with the account token, so they are
   safe to keep in source. `reviewsDataset` is filled in once the pull has run. */
const REPORT = {
  placesDatasets: ["fSSpoOpjbZl8alJQI", "8ASJW338M2wRyHkNB"],
  reviewsDataset: "SWQELAeAGs1rM8lb1"
};

/* Brand research, applied to venues by name. Filled in from public sources only;
   a blank field means it was looked for and not found. `source` is where each
   claim came from so a team member can check it. */
const CHAINS = [
  {
    re: /galito/i, brand: "Galito's",
    operator: "Simbisa Brands Kenya Limited (formerly Innscor Kenya), ICD Road, Nairobi",
    hiring: "Simbisa Kenya posts roles on MyJobMag and JobWebKenya; no HR email published",
    source: "simbisabrands.com (Galito's listed as a Simbisa brand, Kenya a market); Mwango Capital post citing 252 Kenyan outlets incl. Galito's",
    note: "Medium confidence: individual outlets may be franchised rather than company-run."
  },
  {
    re: /pizza inn|chicken inn/i, brand: "Pizza Inn / Chicken Inn",
    operator: "Simbisa Brands Kenya Limited (formerly Innscor Kenya), ICD Road, Nairobi",
    hiring: "Simbisa Kenya posts roles on MyJobMag and JobWebKenya; no HR email published",
    source: "Business Daily (63 Chicken Inn, 74 Pizza Inn, 402 jobs added); LinkedIn: Simbisa Brands Kenya Limited",
    note: "High confidence. Simbisa runs c.250 Kenyan outlets across seven brands, so one conversation covers several of these leads."
  },
  {
    re: /domino/i, brand: "Domino's Pizza",
    operator: "Eat 'N' Go Limited, master franchisee (took over the Kenyan franchise April 2021; earlier Om Nom Nom Ltd)",
    hiring: "Posts on MyJobMag, Fuzu and JobWebKenya; recruiting actively in Nairobi (Apr-May 2026 listings)",
    source: "ir.dominos.com Kenya launch release; dominos.co.ke; MyJobMag and Fuzu listings for Eat 'N' Go Limited",
    note: "High confidence on operator."
  },
  {
    re: /java house/i, brand: "Java House",
    operator: "Java House Africa Ltd (also owns 360 Degrees Pizza)",
    hiring: "Careers portal jobs.javahouseafrica.com; applications email jointheteam@javahouseafrica.com (seen on a May 2025 listing, unverified)",
    source: "MyJobMag and Fuzu listings; jobs.javahouseafrica.com; Wikipedia: Java House",
    note: "Hiring branch supervisors and managers (Apr 2026 listing)."
  },
  {
    re: /\bkfc\b/i, brand: "KFC",
    operator: "Kuku Foods Kenya Ltd (Kuku Foods East Africa), the KFC franchisee",
    hiring: "KFC Kenya says vacancies are received only via admin@kfeah.com; also posts crew roles on BrighterMonday",
    source: "KFC Kenya official account on X (Aug 2023); howwemadeitinafrica.com; BrighterMonday listings",
    note: "High confidence. The email is from a 2023 post, so confirm it is still current."
  },
  {
    re: /pizza hut/i, brand: "Pizza Hut",
    operator: "",
    hiring: "",
    source: "Searched. Two dated sources conflict: Feast Limited (c.2015) and Liberty Eagle (older Business Daily piece)",
    note: "Operator not confirmed; left blank rather than guess."
  },
  {
    re: /papa john/i, brand: "Papa John's",
    operator: "Kitchen Express Ltd, master franchisee for Kenya and Uganda; subsidiary of AAH Limited, sister to Hass Petroleum",
    hiring: "",
    source: "BusinessWire (Nov 2021); Benzinga; global-franchise.com",
    note: "High confidence on operator. No careers page or HR contact found."
  },
  {
    re: /chicken cottage/i, brand: "Chicken Cottage",
    operator: "Kitchen Express Ltd (reported as Express Kitchen), subsidiary of AAH Limited, sister to Hass Petroleum",
    hiring: "",
    source: "Business Daily: UK food chain Chicken Cottage enters Kenya; The Standard",
    note: "Same group as Papa John's. No careers page or HR contact found."
  },
  {
    re: /pizza mojo/i, brand: "Pizza Mojo",
    operator: "",
    hiring: "",
    source: "Searched. One Tripadvisor reviewer says Big Square; no authoritative source",
    note: "Owner not confirmed. A business line (+254 729 918 435) appears on BusinessList.co.ke."
  },
  {
    re: /spur/i, brand: "Spur Steak Ranches",
    operator: "",
    hiring: "",
    source: "Searched. Listings show a South African franchise brand; no Kenyan franchisee named",
    note: "Franchisee not found. Soaring Eagle Spur showed as closed on Uber Eats in Nov 2024, so check it is trading."
  },
  {
    re: /artcaff/i, brand: "Artcaffe",
    operator: "Artcaffe Coffee & Bakery Limited (trademark holder per site footer)",
    hiring: "HR inbox hr@artcaffe.co.ke with a coded subject line (from 2025-26 job listings); hiring waitstaff and baristas",
    source: "artcaffe.co.ke footer; MyJobMag, CorporateStaffing and Opportunities for Young Kenyans listings",
    note: "Medium confidence on the email: not shown on the company's own site."
  },
  {
    re: /^mezza\b/i, brand: "Mezza",
    operator: "",
    hiring: "",
    source: "Searched. mezza.co.ke lists only MEZZA as the parent organisation",
    note: "Legal owner not found."
  },
  {
    re: /chicking/i, brand: "ChicKing",
    operator: "UAE halal fast-food brand. Kenyan franchise partner reported as Crispy Ltd (Mombasa launch); Nairobi operator not confirmed",
    hiring: "",
    source: "Business Daily (2022); nation.africa; chicking.ke",
    note: "Low confidence on the Nairobi operator."
  },
  {
    re: /k'?osewe/i, brand: "K'Osewe Ranalo Foods",
    operator: "Family-run local group, flagship on Kimathi Street (founded 1970s by William Guda Osewe)",
    hiring: "",
    source: "Tripadvisor; nairobirestaurants.co.ke; kosewe.com",
    note: "Single local operator rather than a franchise. No careers page found."
  },
  {
    re: /chowpaty/i, brand: "Chowpaty",
    operator: "Chowpaty Restaurants Ltd / Chowpaty Fast Foods Ltd, Diamond Plaza, Parklands (incorporated 1996; also runs Cafe Tajiri)",
    hiring: "",
    source: "BusinessList.co.ke; Facebook page; chowpatyrestaurants.com",
    note: "Local operator. No careers page found."
  },
  {
    re: /tomoca/i, brand: "Tomoca Coffee",
    operator: "Tomoca Coffee Kenya Ltd, a joint venture with an unnamed local investor (not a franchise)",
    hiring: "",
    source: "Addis Fortune; allAfrica (Two Rivers Mall opening, Sept 2020)",
    note: "No careers page found."
  }
];

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

async function dataset(id) {
  const items = await apify(`/datasets/${encodeURIComponent(id)}/items?clean=true&format=json&limit=3000`);
  return Array.isArray(items) ? items : [];
}

// Different search terms surface different slices of Google's list, because
// each is capped and ranked by popularity.
const TERMS = ["restaurant", "cafe", "bar and grill", "bistro", "pub", "eatery", "steakhouse", "pizza", "fast food", "coffee shop"];

/* Two phases, so reviews are only paid for where they can matter.
   "places": every term x area, no reviews — cheap, gives each overall rating.
   "reviews": only the place ids inside the band, filtered to staff complaints. */
async function start(body) {
  const placeIds = Array.isArray(body.placeIds) ? body.placeIds.filter(Boolean).slice(0, 250) : [];
  let input;

  if (placeIds.length) {
    input = {
      searchStringsArray: placeIds.map((id) => `place_id:${id}`),
      language: "en",
      maxReviews: Math.min(10, Math.max(1, Number(body.maxReviews) || REVIEWS_PER_VENUE)),
      // Lowest-first, so with the keyword filter the ones that come back are the
      // harshest reviews that actually mention staff.
      reviewsSort: String(body.sort || "lowestRanking"),
      reviewsFilterString: String(body.filter || STAFF_FILTER),
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
    searches: input.searchStringsArray.length,
    input
  });
}

async function status(body) {
  const run = await apify(`/actor-runs/${encodeURIComponent(String(body.runId || ""))}`);
  const d = run.data || {};
  return json(200, {
    ok: true,
    status: d.status,
    datasetId: d.defaultDatasetId,
    usageUsd: d.usageTotalUsd ?? null
  });
}

// Unnamed run datasets expire; naming one keeps it. Used once, on the finished pulls.
async function keep(body) {
  const pairs = Array.isArray(body.pairs) ? body.pairs : [];
  const done = [];
  for (const { id, name } of pairs) {
    if (!id || !/^[a-z0-9-]{3,60}$/.test(String(name))) continue;
    await apify(`/datasets/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    done.push(name);
  }
  return json(200, { ok: true, named: done });
}

// What the account has used this month against its cap.
async function limits() {
  const res = await apify("/users/me/limits");
  const d = res.data || {};
  return json(200, {
    ok: true,
    usedUsd: d.current?.monthlyUsageUsd ?? null,
    capUsd: d.limits?.maxMonthlyUsageUsd ?? null
  });
}

const closed = (p) => p.permanentlyClosed || p.temporarilyClosed;
const inBand = (r) => Number.isFinite(r) && r >= MIN_RATING && r <= MAX_RATING;

// Distinct places across one or more datasets.
function distinctPlaces(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const p of list) {
      const key = p.placeId || `${p.title}|${p.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

async function places(body) {
  const ids = Array.isArray(body.datasetIds) && body.datasetIds.length ? body.datasetIds : REPORT.placesDatasets;
  const all = distinctPlaces(await Promise.all(ids.map(dataset)));
  const open = all.filter((p) => !closed(p) && Number(p.totalScore) > 0);
  const band = open.filter((p) => inBand(Number(p.totalScore)));
  return json(200, {
    ok: true,
    distinct: all.length,
    rated: open.length,
    inBand: band.length,
    belowBand: open.filter((p) => Number(p.totalScore) < MIN_RATING).length,
    placeIds: band.map((p) => p.placeId).filter(Boolean),
    venues: band.map((p) => ({ placeId: p.placeId, title: p.title, rating: Number(p.totalScore), reviewsCount: p.reviewsCount }))
  });
}

const reviewText = (r) => String(r.text || r.textTranslated || "").replace(/\s+/g, " ").trim();

function chainFor(name) {
  return CHAINS.find((c) => c.re.test(name)) || null;
}

/* Shape one scraped place into a lead row.

   A venue with no qualifying staff review is kept and flagged, not dropped: a
   quiet review history is not evidence of a good team, and the lead is still
   worth approaching. */
function lead(place) {
  const address = String(place.address || "");
  const area =
    AREAS.find((a) => new RegExp(a, "i").test(`${address} ${place.neighborhood || ""}`)) ||
    place.neighborhood || "Nairobi";

  const all = Array.isArray(place.reviews) ? place.reviews : [];
  const staffReviews = all
    .filter((r) => Number(r.stars) <= MAX_REVIEW_STARS && STAFF_RE.test(reviewText(r)))
    .sort((a, b) => Number(a.stars) - Number(b.stars) || new Date(b.publishedAtDate || 0) - new Date(a.publishedAtDate || 0))
    .slice(0, REVIEWS_PER_VENUE)
    .map((r) => ({ stars: Number(r.stars), text: reviewText(r).slice(0, 400), date: r.publishedAtDate || null }));

  const chain = chainFor(String(place.title || ""));
  return {
    placeId: place.placeId,
    name: place.title,
    area,
    address,
    rating: Number(place.totalScore),
    reviewsCount: Number(place.reviewsCount) || 0,
    category: place.categoryName || "",
    phone: place.phone || "",
    website: place.website || "",
    mapsUrl: place.url || "",
    reviewsReturned: all.length,
    staffReviews,
    noStaffComplaint: staffReviews.length === 0,
    chain: chain ? { brand: chain.brand, operator: chain.operator, hiring: chain.hiring, source: chain.source, note: chain.note || "" } : null
  };
}

async function report(body) {
  const placeSets = Array.isArray(body.placesDatasets) && body.placesDatasets.length ? body.placesDatasets : REPORT.placesDatasets;
  const reviewsId = String(body.reviewsDataset || REPORT.reviewsDataset || "");
  if (!reviewsId) return json(400, { ok: false, error: "No reviews dataset is set yet." });

  const [placeLists, reviewed] = await Promise.all([Promise.all(placeSets.map(dataset)), dataset(reviewsId)]);
  const all = distinctPlaces(placeLists).filter((p) => !closed(p) && Number(p.totalScore) > 0);

  // Distribution over every distinct, open, rated place — the whole market, not
  // just the band, because the report is about where the band sits in it.
  const ratings = all.map((p) => Number(p.totalScore)).sort((a, b) => a - b);
  const buckets = {};
  for (const r of ratings) {
    const k = (Math.round(r * 10) / 10).toFixed(1);
    buckets[k] = (buckets[k] || 0) + 1;
  }
  const mean = ratings.reduce((s, x) => s + x, 0) / (ratings.length || 1);
  const median = ratings.length ? ratings[Math.floor(ratings.length / 2)] : null;

  const seen = new Set();
  const leads = [];
  for (const p of reviewed) {
    if (!p.placeId || seen.has(p.placeId) || closed(p) || !inBand(Number(p.totalScore))) continue;
    seen.add(p.placeId);
    leads.push(lead(p));
  }

  // Most staff complaints first, then the lowest rating; venues with none go last.
  leads.sort((a, b) =>
    b.staffReviews.length - a.staffReviews.length ||
    a.rating - b.rating ||
    b.reviewsCount - a.reviewsCount
  );

  return json(200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    market: {
      placesScanned: all.length,
      mean: Number(mean.toFixed(2)),
      median,
      buckets,
      belowBand: ratings.filter((r) => r < MIN_RATING).length,
      inBand: ratings.filter(inBand).length,
      above: ratings.filter((r) => r > MAX_RATING).length
    },
    band: { min: MIN_RATING, max: MAX_RATING },
    leads,
    withStaffComplaint: leads.filter((l) => !l.noStaffComplaint).length,
    totalStaffReviews: leads.reduce((n, l) => n + l.staffReviews.length, 0)
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
      case "places": return await places(body);
      case "report": return await report(body);
      case "limits": return await limits();
      case "keep": return await keep(body);
      default: return json(400, { ok: false, error: `Unknown action: ${body.action}` });
    }
  } catch (error) {
    return json(500, { ok: false, error: error.message || "Something went wrong." });
  }
};
