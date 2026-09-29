// Apply-link liveness checking.
//
// A dead apply link is the worst thing we can put in front of a job seeker, so
// every link is verified before it can enter a list. Results are cached on the
// job row with a timestamp and only re-checked once stale, because re-checking
// thousands of links on every run would be both slow and rude to the hosts.

const DEFAULT_CONCURRENCY = 8;
const TIMEOUT_MS = 8000;

// Browser-ish UA. Several ATS hosts (Workday, Greenhouse, Taleo) return 403 to
// an obviously scripted request, which would read as a dead link.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* Check one URL.

   HEAD first because it is cheap, then GET on failure: a good number of job
   hosts do not implement HEAD and answer 405 to it, which is not a dead link.

   Returns { status: 'live'|'dead', code, note }. Treats 401/403/429 as LIVE:
   those mean "the page exists but will not talk to a robot", and marking them
   dead would strip legitimate ATS postings out of every list. */
async function checkUrl(url) {
  const target = String(url || "").trim();
  if (!target) return { status: "dead", code: null, note: "no url" };
  if (!/^https?:\/\//i.test(target)) return { status: "dead", code: null, note: "not http(s)" };

  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(target, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" }
      });
      return { ok: true, code: res.status };
    } catch (error) {
      return { ok: false, code: null, note: error.name === "AbortError" ? "timeout" : error.message };
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt("HEAD");
  // 405/501 = HEAD unsupported; 5xx and network errors deserve a GET before we
  // write a link off.
  if (!res.ok || res.code === 405 || res.code === 501 || res.code >= 500) {
    res = await attempt("GET");
  }

  if (!res.ok) return { status: "dead", code: null, note: res.note || "request failed" };

  const code = res.code;
  if (code >= 200 && code < 400) return { status: "live", code, note: "" };
  if (code === 401 || code === 403 || code === 429) {
    return { status: "live", code, note: "host blocks automated checks; assumed live" };
  }
  if (code === 404 || code === 410) return { status: "dead", code, note: "not found" };
  if (code >= 400 && code < 500) return { status: "dead", code, note: `client error ${code}` };
  return { status: "dead", code, note: `server error ${code}` };
}

/* Check many URLs with a bounded number of in-flight requests.

   A simple worker pool: `concurrency` workers pull from a shared cursor. Keeps
   us from opening hundreds of sockets at once, which Netlify's runtime handles
   badly and which looks like an attack to the hosts. */
async function checkMany(items, concurrency = DEFAULT_CONCURRENCY, onProgress) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      const item = list[index];
      const result = await checkUrl(item.url);
      results[index] = { ...item, ...result };
      done += 1;
      if (onProgress && done % 10 === 0) onProgress(done, list.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, worker);
  await Promise.all(workers);
  return results;
}

// A check is trusted for `days`; after that the link may well have been taken
// down and must be re-verified.
function isStale(checkedAt, days) {
  if (!checkedAt) return true;
  const when = new Date(checkedAt);
  if (!Number.isFinite(when.getTime())) return true;
  return (Date.now() - when.getTime()) / 86400000 > Number(days || 7);
}

module.exports = { checkUrl, checkMany, isStale, DEFAULT_CONCURRENCY };
