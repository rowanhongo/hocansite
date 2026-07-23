import { getPublicBlogs } from "./supabase.js";

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {year: "numeric", month: "short", day: "numeric"});
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toPostUrl(slug) {
  return `/blog/${encodeURIComponent(slug)}`;
}

function postDate(post) {
  const raw = post?.published_at || post?.created_at;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

let allPosts = [];
let search = "";
let range = "all";   // "all" | "30" | "365"
let year = "all";

/** Match against the fields the listing query returns (body text isn't fetched here). */
function matchesSearch(post, terms) {
  if (!terms.length) return true;
  const haystack = [post?.title, post?.excerpt, post?.category, post?.author]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function matchesDate(post) {
  const d = postDate(post);
  if (year !== "all") {
    if (!d || d.getFullYear() !== Number(year)) return false;
  }
  if (range !== "all") {
    if (!d) return false;
    const cutoff = Date.now() - Number(range) * 86400000;
    if (d.getTime() < cutoff) return false;
  }
  return true;
}

function cardHtml(post) {
  const img = post?.cover_image_url || "";
  return `
        ${img ? `<img class="blog-card-img" src="${escapeHtml(img)}" alt="${escapeHtml(post?.title || "Blog post")}" loading="lazy" decoding="async">` : ""}
        <div class="blog-card-body">
          <div class="blog-card-meta">${escapeHtml(formatDate(post?.published_at || post?.created_at))}</div>
          <div class="blog-card-title">${escapeHtml(post?.title || "")}</div>
          ${post?.excerpt ? `<div class="blog-card-excerpt">${escapeHtml(post.excerpt)}</div>` : ""}
          <div class="blog-card-more">Read article <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7"/></svg></div>
        </div>
      `;
}

function apply() {
  const container = document.getElementById("blog-container");
  const countEl = document.getElementById("blogCount");
  if (!container) return;

  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = allPosts.filter((p) => matchesSearch(p, terms) && matchesDate(p));

  container.innerHTML = "";
  if (!shown.length) {
    container.innerHTML = `<div class="blog-empty">No articles match your filters. Try a different keyword or date range.</div>`;
  } else {
    shown.forEach((post) => {
      const card = document.createElement("a");
      card.className = "blog-card";
      card.href = post?.slug ? toPostUrl(post.slug) : "#";
      card.innerHTML = cardHtml(post);
      container.appendChild(card);
    });
  }

  if (countEl) {
    const filtered = shown.length !== allPosts.length;
    countEl.innerHTML = filtered
      ? `Showing <strong>${shown.length}</strong> of ${allPosts.length} articles`
      : `<strong>${allPosts.length}</strong> article${allPosts.length === 1 ? "" : "s"}`;
  }
}

function populateYears() {
  const select = document.getElementById("blogYear");
  if (!select) return;
  const years = [...new Set(allPosts.map((p) => postDate(p)?.getFullYear()).filter(Boolean))].sort((a, b) => b - a);
  select.innerHTML =
    `<option value="all">All years</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
}

function setupControls() {
  const input = document.getElementById("blogSearch");
  const clear = document.getElementById("blogSearchClear");
  const yearSelect = document.getElementById("blogYear");

  if (input) {
    let timer;
    input.addEventListener("input", () => {
      if (clear) clear.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(() => {
        search = input.value.trim();
        apply();
      }, 180);
    });
  }

  if (clear) {
    clear.addEventListener("click", () => {
      if (!input) return;
      input.value = "";
      clear.hidden = true;
      search = "";
      apply();
      input.focus();
    });
  }

  document.querySelectorAll("[data-range]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-range]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      range = btn.dataset.range;
      apply();
    });
  });

  if (yearSelect) {
    yearSelect.addEventListener("change", () => {
      year = yearSelect.value;
      apply();
    });
  }
}

async function renderBlogs() {
  const container = document.getElementById("blog-container");
  if (!container) return;

  container.innerHTML = `<div class="blog-loading">Loading posts...</div>`;

  try {
    allPosts = await getPublicBlogs();
    if (!allPosts?.length) {
      container.innerHTML = `<div class="blog-empty">No blog posts yet.</div>`;
      return;
    }

    populateYears();
    setupControls();
    apply();
  } catch (e) {
    container.innerHTML = `<div class="blog-empty">Unable to load posts right now. Please try again shortly.</div>`;
  }
}

renderBlogs();
