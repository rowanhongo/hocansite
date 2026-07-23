import { getPublicBlogBySlug } from "./supabase.js";

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {year: "numeric", month: "long", day: "numeric"});
}

function getSlugFromPath() {
  const path = window.location.pathname || "";
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return "";
  if (parts[0] !== "blog") return "";
  const last = (parts[parts.length - 1] || "").replace(/\.html$/i, "");
  // The listing encodes the slug, so decode it back before looking it up.
  try {
    return decodeURIComponent(last);
  } catch (_e) {
    return last;
  }
}

function renderContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || !block.type) return "";

      if (block.type === "heading") {
        return block.text ? `<h2>${escapeHtml(block.text)}</h2>` : "";
      }
      if (block.type === "subheading") {
        return block.text ? `<h3>${escapeHtml(block.text)}</h3>` : "";
      }
      if (block.type === "quote") {
        if (!block.text) return "";
        return `<blockquote><p>${escapeHtml(block.text)}</p></blockquote>`;
      }
      if (block.type === "list") {
        const items = Array.isArray(block.items) ? block.items : [];
        if (!items.length) return "";
        return `<ul class="pt-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      }
      if (block.type === "image") {
        if (!block.url) return "";
        return `
          <figure class="pt-figure">
            <img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption || "Blog image")}" loading="lazy" decoding="async">
            ${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}
          </figure>
        `;
      }
      if (!block.text) return "";
      return `<p>${escapeHtml(block.text)}</p>`;
    })
    .join("\n");
}

const ICONS = {
  linkedin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z"/></svg>`,
  x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.22-6.82-5.96 6.82H1.68l7.73-8.84L1.25 2.25h6.82l4.71 6.23 5.46-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.11l11.97 15.64Z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M24 12.07C24 5.44 18.63.07 12 .07S0 5.44 0 12.07c0 5.99 4.39 10.95 10.13 11.85v-8.38H7.08v-3.47h3.05V9.43c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.95h-1.51c-1.49 0-1.96.93-1.96 1.87v2.25h3.33l-.53 3.47h-2.8v8.38C19.61 23.03 24 18.06 24 12.07Z"/></svg>`,
  whatsapp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.91-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.08-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.06 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.18-1.42-.08-.12-.28-.2-.58-.34m-5.42 7.4h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.83 9.83 0 0 1 2.89 6.99c0 5.45-4.44 9.88-9.88 9.88m8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.69 1.45c6.55 0 11.89-5.34 11.89-11.9a11.82 11.82 0 0 0-3.48-8.41Z"/></svg>`,
  link: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a1 1 0 0 1 0-1.41l2.83-2.83a1 1 0 0 1 1.41 1.41l-2.83 2.83a1 1 0 0 1-1.41 0Zm-1.42 4.24-1.41 1.42a3 3 0 0 1-4.24-4.24l2.82-2.83a3 3 0 0 1 4.25 0l1.41-1.41a5 5 0 0 0-7.07 0l-2.83 2.82a5 5 0 0 0 7.07 7.08l1.42-1.42a5.02 5.02 0 0 1-1.42-1.42Zm11.31-13.3a5 5 0 0 0-7.07 0l-1.42 1.42a5.02 5.02 0 0 1 1.42 1.42l1.41-1.42a3 3 0 0 1 4.24 4.24l-2.82 2.83a3 3 0 0 1-4.25 0l-1.41 1.41a5 5 0 0 0 7.07 0l2.83-2.82a5 5 0 0 0 0-7.08Z"/></svg>`
};

function readingTime(blocks) {
  if (!Array.isArray(blocks)) return "";
  const words = blocks
    .map((b) => (b?.type === "list" ? (b.items || []).join(" ") : b?.text || ""))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  if (!words) return "";
  return `${Math.max(1, Math.round(words / 200))} min read`;
}

function getShareLinks(title) {
  const url = encodeURIComponent(window.location.href);
  const text = encodeURIComponent(title || "Hocan Holdings Blog");
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    x: `https://twitter.com/intent/tweet?url=${url}&text=${text}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    whatsapp: `https://wa.me/?text=${text}%20${url}`
  };
}

function initials(name) {
  return String(name || "HH")
    .split(" ")
    .map((part) => part[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function setupShareActions() {
  const copyBtn = document.querySelector("[data-share-copy]");
  if (!copyBtn) return;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copyBtn.classList.add("copied");
      copyBtn.textContent = "Copied";
      copyBtn.setAttribute("aria-label", "Link copied");
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.innerHTML = ICONS.link;
        copyBtn.setAttribute("aria-label", "Copy link");
      }, 1600);
    } catch (_e) {
      /* clipboard unavailable — leave the icon as-is */
    }
  });
}

async function init() {
  const root = document.getElementById("blog-post");
  if (!root) return;

  const slug = getSlugFromPath() || new URLSearchParams(window.location.search).get("slug") || "";
  if (!slug) {
    root.innerHTML = `<div class="article-empty">Missing blog slug.</div>`;
    return;
  }

  root.innerHTML = `<div class="article-loading">Loading article...</div>`;

  try {
    const post = await getPublicBlogBySlug(slug);
    if (!post) {
      root.innerHTML = `<div class="article-empty">This article was not found.</div>`;
      return;
    }

    const cover = post?.cover_image_url || "";
    const author = post?.author || "Hocan Holdings";
    const share = getShareLinks(post?.title || "");

    const date = formatDate(post?.published_at || post?.created_at);
    const mins = readingTime(post?.content);

    root.innerHTML = `
      <a class="article-back" href="/blogs.html"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H6M12 19l-7-7 7-7"/></svg> All articles</a>
      <article class="article">
        <header class="article-header">
          <div class="article-meta">${[date, mins].filter(Boolean).map(escapeHtml).join(" &middot; ")}</div>
          <h1 class="article-title">${escapeHtml(post?.title || "")}</h1>
          ${post?.excerpt ? `<p class="article-excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
          <div class="article-byline">
            <span class="byline-person">
              <span class="author-avatar">${escapeHtml(initials(author))}</span>
              <span class="author-info"><strong>${escapeHtml(author)}</strong><small>Author</small></span>
            </span>
            <div class="article-share">
              <a href="${share.linkedin}" target="_blank" rel="noopener noreferrer" aria-label="Share on LinkedIn">${ICONS.linkedin}</a>
              <a href="${share.x}" target="_blank" rel="noopener noreferrer" aria-label="Share on X">${ICONS.x}</a>
              <a href="${share.facebook}" target="_blank" rel="noopener noreferrer" aria-label="Share on Facebook">${ICONS.facebook}</a>
              <a href="${share.whatsapp}" target="_blank" rel="noopener noreferrer" aria-label="Share on WhatsApp">${ICONS.whatsapp}</a>
              <button type="button" data-share-copy aria-label="Copy link">${ICONS.link}</button>
            </div>
          </div>
        </header>
        ${cover ? `<div class="article-cover-wrap"><img class="article-cover" src="${escapeHtml(cover)}" alt="${escapeHtml(post?.title || "Article")}" decoding="async"></div>` : ""}
        <div class="article-body">
          ${renderContentBlocks(post?.content)}
        </div>
      </article>
    `;
    setupShareActions();
  } catch (e) {
    root.innerHTML = `<div class="article-empty">Unable to load this article right now.</div>`;
  }
}

init();

