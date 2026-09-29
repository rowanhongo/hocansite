// Pure, deterministic helpers shared by the ingest webhook and the admin
// read/write function. No network, no env vars, no Supabase — so every rule in
// here is testable in isolation and produces the same answer twice.

// Query parameters that identify a *click*, not a *job*. Two links differing
// only by these point at the same posting, so they must not survive into the
// canonical URL or the same job dedupes as two.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_source_platform", "utm_creative_format", "utm_marketing_tactic",
  "gclid", "fbclid", "msclkid", "dclid", "gbraid", "wbraid", "twclid",
  "igshid", "mc_cid", "mc_eid", "yclid", "_hsenc", "_hsmi", "hsa_acc",
  "ref", "referer", "referrer", "source", "src", "trk", "trkid",
  "trackingid", "tracking_id", "clickid", "click_id", "cid", "campaignid",
  "campaign_id", "adid", "ad_id", "aid", "sid", "session_id", "sessionid",
  "gh_src", "rx_source", "rx_campaign", "rx_medium", "rx_group", "rx_job",
  "from", "at", "tk", "jk", "vjs", "sjdu", "xkcb", "xpse", "xfps", "xpst",
  // Google Jobs / LinkedIn / Indeed viewer state that changes per impression.
  "trackingId", "refId", "position", "pageNum", "originalSubdomain",
  "eBP", "recommendedFlavor", "savedSearchId", "alternateChannel"
]);

// Hosts that wrap a real posting behind a redirect. We keep the URL as scraped
// (raw_url) but canonicalise on the inner target when one is present, so the
// same job behind two different wrappers dedupes to one row.
const REDIRECT_PARAM_NAMES = ["url", "u", "target", "redirect", "redirect_url", "dest", "destination", "link"];

/* Strip a URL down to what identifies the job.

   Drops tracking params, the fragment, default ports, a trailing slash and
   `www.`, lowercases scheme and host (but never the path — plenty of ATS hosts
   have case-sensitive job ids), and unwraps a single layer of redirect. Returns
   the input trimmed if it will not parse, so a malformed URL still produces a
   stable key rather than throwing mid-ingest. */
function canonicalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  let url;
  try {
    url = new URL(raw);
  } catch (_e) {
    // Not parseable even with a scheme guess — fall back to the trimmed string.
    try {
      url = new URL(`https://${raw}`);
    } catch (_e2) {
      return raw.toLowerCase();
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return raw.toLowerCase();

  // Unwrap one layer of redirect wrapper, if the inner value is itself a URL.
  for (const name of REDIRECT_PARAM_NAMES) {
    const inner = url.searchParams.get(name);
    if (!inner) continue;
    if (!/^https?:\/\//i.test(inner)) continue;
    try {
      const innerUrl = new URL(inner);
      if (innerUrl.host && innerUrl.host !== url.host) {
        url = innerUrl;
        break;
      }
    } catch (_e) {
      // leave the wrapper in place
    }
  }

  const keep = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (TRACKING_PARAMS.has(key) || TRACKING_PARAMS.has(key.toLowerCase())) continue;
    keep.push([key, value]);
  }
  // Sorted, so param order cannot produce two keys for one job.
  keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const scheme = url.protocol.toLowerCase();
  const port = url.port && url.port !== (scheme === "https:" ? "443" : "80") ? `:${url.port}` : "";
  let path = url.pathname.replace(/\/+$/, "");
  if (!path) path = "/";
  const query = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join("&")}` : "";

  return `${scheme}//${host}${port}${path}${query}`;
}

// Collapse whitespace, strip punctuation that varies between sightings, and
// lowercase. Used for both the fallback key and the company key.
function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[‘’“”]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Legal-form suffixes that appear inconsistently across sightings of the same
// employer ("Acme", "Acme Ltd", "Acme Limited"). Removed from the company key
// only — the display name keeps whatever was scraped.
const COMPANY_SUFFIXES = [
  "ltd", "limited", "plc", "llc", "inc", "incorporated", "corp", "corporation",
  "company", "co", "group", "holdings", "kenya", "ke", "east africa", "ea",
  "international", "intl", "africa", "sa", "pty", "gmbh", "bv", "nv", "srl"
];

function companyKey(company) {
  let key = normalizeText(company);
  if (!key) return "";
  // Strip trailing suffixes repeatedly: "Acme Kenya Ltd" -> "acme".
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (key.endsWith(` ${suffix}`)) {
        key = key.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return key || normalizeText(company);
}

// Location is deliberately coarsened to the city: the same job is listed as
// "Nairobi", "Nairobi, Kenya" and "Nairobi County" across sources, and a
// fallback key that treated those as different would fail to match reposts.
function locationKey(location) {
  const norm = normalizeText(location);
  if (!norm) return "";
  const city = norm.split(" ")[0] || norm;
  return city;
}

/* The fallback dedupe key: company + title + location.

   This is what catches a repost at a brand-new URL, which canonical_url cannot.
   Deliberately coarse on all three parts. */
function fallbackKey(company, title, location) {
  return [companyKey(company), normalizeText(title), locationKey(location)].join("|");
}

const MS_PER_DAY = 86400000;
const RELATIVE_UNITS = {
  minute: 60000, minutes: 60000, min: 60000, mins: 60000,
  hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000,
  day: MS_PER_DAY, days: MS_PER_DAY,
  week: MS_PER_DAY * 7, weeks: MS_PER_DAY * 7,
  month: MS_PER_DAY * 30, months: MS_PER_DAY * 30,
  year: MS_PER_DAY * 365, years: MS_PER_DAY * 365
};

/* Resolve the scraper's `postedAt` to an absolute instant.

   Google Jobs reports relative strings ("3 days ago", "30+ days ago"), so the
   reference point must be when the scrape ran — not when we ingested it, which
   can be hours later and would drift every posting's date.

   Returns { postedAt: Date|null, exact: boolean }. `exact` is false for
   anything derived from a relative string, which is accurate to the day at
   best; the admin shows those dates as approximate. */
function resolvePostedAt(postedRaw, scrapedAt) {
  const reference = scrapedAt instanceof Date ? scrapedAt : new Date(scrapedAt || Date.now());
  const base = Number.isFinite(reference.getTime()) ? reference : new Date();
  const raw = String(postedRaw || "").trim();
  if (!raw) return { postedAt: null, exact: false };

  const lower = raw.toLowerCase();

  if (/^(just now|today|moments? ago)$/.test(lower)) {
    return { postedAt: new Date(base.getTime()), exact: false };
  }
  if (lower === "yesterday") {
    return { postedAt: new Date(base.getTime() - MS_PER_DAY), exact: false };
  }

  // "3 days ago", "30+ days ago", "about 2 hours ago", "2 weeks ago"
  const relative = lower.match(/(\d+)\s*\+?\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)\s*(ago)?/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = RELATIVE_UNITS[relative[2]];
    if (Number.isFinite(amount) && unitMs) {
      return { postedAt: new Date(base.getTime() - amount * unitMs), exact: false };
    }
  }

  // An absolute date the scraper passed straight through.
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) {
    // Guard against a "date" that is really a bare number parsed as a year.
    if (/\d{4}/.test(raw) || /[a-z]{3}/i.test(raw)) {
      return { postedAt: parsed, exact: true };
    }
  }

  return { postedAt: null, exact: false };
}

// ── Exclusion rules ─────────────────────────────────────────────────────────
// Deterministic and auditable: every exclusion names the rule that caused it,
// and the admin shows that reason. Gemini only ever *flags* borderline cases on
// top of this; it never silently drops a job.

const AGENCY_PATTERNS = [
  /\brecruit(ing|ment|er|ers)?\b/, /\bstaffing\b/, /\btalent\s+(solutions|acquisition|partners|group)\b/,
  /\bmanpower\b/, /\bemployment\s+agency\b/, /\bplacement(s)?\s+(agency|services|ltd)\b/,
  /\bexecutive\s+search\b/, /\bheadhunt(er|ers|ing)\b/, /\boutsourc(ing|e|ed)\b/,
  /\bhr\s+(solutions|consult\w*|services|outsourcing|advisory)\b/,
  /\bhuman\s+(resource|capital)\s+(solutions|consult\w*|services|partners)\b/,
  /\bpeople\s+(solutions|consult\w*)\b/, /\bworkforce\s+(solutions|services)\b/,
  /\bjob\s+(board|portal|search)\b/, /\bcareer(s)?\s+(agency|solutions)\b/,
  /\btemp(orary)?\s+agency\b/, /\blabour\s+(hire|broker|outsourcing)\b/
];

const CONFIDENTIAL_PATTERNS = [
  /\bconfidential\b/, /\bundisclosed\b/, /\bnot\s+disclosed\b/, /\bprivate\s+company\b/,
  /\bour\s+client\b/, /\ba\s+client\b/, /\bclient\s+of\b/, /\bleading\s+(company|firm|organisation|organization)\b/,
  /\bwell[-\s]?known\s+(company|firm)\b/, /\banonymous\b/, /\bn\/a\b/, /^unknown$/, /^company$/,
  /\bhidden\b/, /\bemployer\s+confidential\b/, /\bmultiple\s+employers\b/
];

// Kenya check is positive-match, not a blocklist: the scraper targets Nairobi,
// so anything that names a *different* country or a known non-Kenyan city is
// out, while a blank or Nairobi location stays in.
const NON_KENYA_PATTERNS = [
  /\b(uganda|kampala|tanzania|dar es salaam|dodoma|rwanda|kigali|burundi|bujumbura)\b/,
  /\b(ethiopia|addis ababa|somalia|mogadishu|south sudan|juba|sudan|khartoum)\b/,
  /\b(nigeria|lagos|abuja|ghana|accra|south africa|johannesburg|cape town|pretoria|durban)\b/,
  /\b(egypt|cairo|morocco|casablanca|tunisia|algeria|zambia|lusaka|zimbabwe|harare)\b/,
  /\b(malawi|lilongwe|mozambique|maputo|botswana|gaborone|namibia|windhoek)\b/,
  /\b(united states|usa|u\.s\.|canada|united kingdom|london|uk|ireland|dublin)\b/,
  /\b(germany|berlin|france|paris|netherlands|amsterdam|spain|madrid|italy|rome)\b/,
  /\b(india|mumbai|delhi|bangalore|pakistan|china|beijing|shanghai|japan|tokyo)\b/,
  /\b(australia|sydney|melbourne|new zealand|singapore|malaysia|philippines|manila)\b/,
  /\b(dubai|abu dhabi|uae|united arab emirates|saudi|riyadh|qatar|doha|kuwait|oman|bahrain)\b/
];

const KENYA_PATTERNS = [
  /\bkenya\b/, /\bnairobi\b/, /\bmombasa\b/, /\bkisumu\b/, /\bnakuru\b/, /\beldoret\b/,
  /\bthika\b/, /\bmachakos\b/, /\bkiambu\b/, /\bnyeri\b/, /\bkakamega\b/, /\bkisii\b/,
  /\bwestlands\b/, /\bkilimani\b/, /\bruiru\b/, /\bathi river\b/, /\bmalindi\b/, /\bnanyuki\b/
];

const HR_ROLE_PATTERNS = [
  /\bhr\b/, /\bhuman resource/, /\bpeople\s+(officer|manager|partner|operations|lead|director)\b/,
  /\brecruit(er|ment|ing)\b/, /\btalent\s+(acquisition|manager|partner)\b/,
  /\bpayroll\b/, /\btraining\s+(officer|manager|coordinator)\b/,
  /\blearning\s+and\s+development\b/, /\bl&d\b/, /\bchief people officer\b/, /\bcpo\b/,
  /\bcompensation\s+and\s+benefits\b/, /\bemployee\s+relations\b/, /\bhrbp\b/
];

// Tier drives the seniority signal. Higher tier = more decision-making power in
// the company, which correlates with a budget for outside services.
const SENIORITY_TIERS = [
  { tier: 4, patterns: [/\bchief\b/, /\bc[eoft]o\b/, /\bmanaging director\b/, /\bmd\b/, /\bpresident\b/, /\bpartner\b/, /\bvp\b/, /\bvice president\b/, /\bhead of\b/, /\bdirector\b/, /\bcountry manager\b/] },
  { tier: 3, patterns: [/\bmanager\b/, /\bsenior manager\b/, /\bprincipal\b/, /\blead\b/, /\bsuperintendent\b/, /\bgeneral manager\b/] },
  { tier: 2, patterns: [/\bsenior\b/, /\bsupervisor\b/, /\bspecialist\b/, /\bcoordinator\b/, /\bteam leader\b/, /\bofficer\b/] },
  { tier: 1, patterns: [/\bjunior\b/, /\bassistant\b/, /\bintern(ship)?\b/, /\btrainee\b/, /\bgraduate\b/, /\bapprentice\b/, /\bentry\b/] }
];

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

function isAgency(company, extra, blocklist) {
  const haystack = `${normalizeText(company)} ${normalizeText(extra)}`;
  if (matchesAny(AGENCY_PATTERNS, haystack)) return true;
  const key = companyKey(company);
  return (blocklist || []).some((entry) => {
    const b = companyKey(entry);
    return b && (key === b || key.includes(b) || normalizeText(company).includes(normalizeText(entry)));
  });
}

function isConfidential(company) {
  const norm = normalizeText(company);
  if (!norm) return true;
  return matchesAny(CONFIDENTIAL_PATTERNS, norm);
}

function isCompetitor(company, blocklist) {
  const key = companyKey(company);
  if (!key) return false;
  return (blocklist || []).some((entry) => {
    const b = companyKey(entry);
    return b && (key === b || key.includes(b));
  });
}

function isNonKenya(location) {
  const norm = normalizeText(location);
  if (!norm) return false; // blank location: give it the benefit of the doubt
  if (matchesAny(KENYA_PATTERNS, norm)) return false;
  if (matchesAny(NON_KENYA_PATTERNS, norm)) return true;
  // "Remote" with no country named is kept; a named foreign place was caught above.
  return false;
}

function hasHrRole(title) {
  return matchesAny(HR_ROLE_PATTERNS, normalizeText(title));
}

function seniorityTier(title) {
  const norm = normalizeText(title);
  for (const { tier, patterns } of SENIORITY_TIERS) {
    if (matchesAny(patterns, norm)) return tier;
  }
  return 0;
}

/* Decide whether a job is eligible, and name the rule if not.

   Order matters for explainability: a confidential posting from an agency is
   reported as 'agency', the more actionable fact. Returns null when eligible. */
function exclusionReason(job, settings) {
  const s = settings || {};
  if (isCompetitor(job.company, s.competitor_blocklist)) return "competitor";
  if (isAgency(job.company, `${job.via || ""} ${job.applySource || ""}`, s.agency_blocklist)) return "agency";
  if (isConfidential(job.company)) return "confidential";
  if (isNonKenya(job.location)) return "non_kenya";
  return null;
}

// Age is checked separately from exclusionReason: a job that is merely too old
// is still a valid data point for a company's hiring history, it just cannot go
// into a job-seeker list.
function isTooOld(postedAt, maxAgeDays, now) {
  if (!postedAt) return false; // unknown date: do not exclude on age alone
  const ref = now instanceof Date ? now : new Date(now || Date.now());
  const posted = postedAt instanceof Date ? postedAt : new Date(postedAt);
  if (!Number.isFinite(posted.getTime())) return false;
  return (ref.getTime() - posted.getTime()) / MS_PER_DAY > Number(maxAgeDays || 20);
}

module.exports = {
  canonicalizeUrl,
  normalizeText,
  companyKey,
  locationKey,
  fallbackKey,
  resolvePostedAt,
  exclusionReason,
  isTooOld,
  isAgency,
  isConfidential,
  isCompetitor,
  isNonKenya,
  hasHrRole,
  seniorityTier,
  MS_PER_DAY
};
