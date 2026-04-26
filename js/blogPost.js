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
  const last = parts[parts.length - 1] || "";
  return last.replace(/\.html$/i, "");
}

function renderContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || !block.type) return "";

      if (block.type === "heading") {
        return `<h2>${escapeHtml(block.text || "")}</h2>`;
      }
      if (block.type === "subheading") {
        return `<h3>${escapeHtml(block.text || "")}</h3>`;
      }
      if (block.type === "quote") {
        return `<blockquote>${escapeHtml(block.text || "")}</blockquote>`;
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
      return `<p>${escapeHtml(block.text || "")}</p>`;
    })
    .join("\n");
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
      copyBtn.textContent = "Copied";
      setTimeout(() => {
        copyBtn.textContent = "Copy Link";
      }, 1400);
    } catch (_e) {
      copyBtn.textContent = "Copy failed";
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

    root.innerHTML = `
      <a class="article-back" href="/blogs.html">&larr; Back</a>
      <article class="article">
        <header class="article-header">
          <div class="article-meta">${escapeHtml(formatDate(post?.published_at || post?.created_at))}</div>
          <h1 class="article-title">${escapeHtml(post?.title || "")}</h1>
          ${post?.excerpt ? `<p class="article-excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
          <div class="article-byline">
            <span class="author-avatar">${escapeHtml(initials(author))}</span>
            <span class="author-info"><strong>${escapeHtml(author)}</strong><small>Author</small></span>
          </div>
          <div class="article-share">
            <a href="${share.facebook}" target="_blank" rel="noopener noreferrer">Facebook</a>
            <a href="${share.x}" target="_blank" rel="noopener noreferrer">X</a>
            <a href="${share.linkedin}" target="_blank" rel="noopener noreferrer">LinkedIn</a>
            <a href="${share.whatsapp}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
            <button type="button" data-share-copy>Copy Link</button>
          </div>
        </header>
        ${cover ? `<img class="article-cover" src="${escapeHtml(cover)}" alt="${escapeHtml(post?.title || "Article")}" decoding="async">` : ""}
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

