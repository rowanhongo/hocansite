import {getBlogPost} from "./sanity.js";
import {urlFor} from "./imageBuilder.js";

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
  // Supports:
  // - /blog/my-slug
  // - /blog/my-slug.html
  const path = window.location.pathname || "";
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (!last) return "";
  return last.replace(/\.html$/i, "");
}

function renderPortableText(blocks) {
  if (!Array.isArray(blocks)) return "";

  // Minimal, production-safe renderer for common Portable Text blocks:
  // - block: p, h2, h3, blockquote
  // - lists: bullet/number
  // - image blocks
  const out = [];
  let listType = null; // "ul" | "ol"

  const closeList = () => {
    if (listType) out.push(`</${listType}>`);
    listType = null;
  };

  const markWrap = (text, marks, markDefs) => {
    if (!marks?.length) return text;
    let wrapped = text;
    marks.forEach((m) => {
      if (m === "strong") wrapped = `<strong>${wrapped}</strong>`;
      else if (m === "em") wrapped = `<em>${wrapped}</em>`;
      else {
        // link mark
        const def = (markDefs || []).find((d) => d?._key === m && d?._type === "link");
        if (def?.href) wrapped = `<a href="${escapeHtml(def.href)}" target="_blank" rel="noopener noreferrer">${wrapped}</a>`;
      }
    });
    return wrapped;
  };

  const renderSpans = (children, markDefs) => {
    return (children || [])
      .map((c) => {
        if (c?._type !== "span") return "";
        const text = escapeHtml(c.text || "");
        return markWrap(text, c.marks, markDefs);
      })
      .join("");
  };

  for (const b of blocks) {
    if (!b) continue;

    if (b._type === "image") {
      closeList();
      const src = urlFor(b).width(1200).url();
      if (src) out.push(`<figure class="pt-figure"><img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async"></figure>`);
      continue;
    }

    if (b._type !== "block") {
      closeList();
      continue;
    }

    // Lists
    if (b.listItem) {
      const nextType = b.listItem === "number" ? "ol" : "ul";
      if (listType && listType !== nextType) closeList();
      if (!listType) {
        listType = nextType;
        out.push(`<${listType} class="pt-list">`);
      }
      out.push(`<li>${renderSpans(b.children, b.markDefs)}</li>`);
      continue;
    }

    closeList();

    const style = b.style || "normal";
    const inner = renderSpans(b.children, b.markDefs);

    if (!inner.trim()) continue;

    if (style === "h1") out.push(`<h1>${inner}</h1>`);
    else if (style === "h2") out.push(`<h2>${inner}</h2>`);
    else if (style === "h3") out.push(`<h3>${inner}</h3>`);
    else if (style === "blockquote") out.push(`<blockquote>${inner}</blockquote>`);
    else out.push(`<p>${inner}</p>`);
  }

  closeList();
  return out.join("\n");
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
    const post = await getBlogPost(slug);
    if (!post) {
      root.innerHTML = `<div class="article-empty">This article was not found.</div>`;
      return;
    }

    const cover = post?.coverImage ? urlFor(post.coverImage).width(1400).url() : "";

    root.innerHTML = `
      <a class="article-back" href="/blog.html">&larr; Back</a>
      <article class="article">
        <header class="article-header">
          <div class="article-meta">${escapeHtml(formatDate(post?._createdAt))}</div>
          <h1 class="article-title">${escapeHtml(post?.title || "")}</h1>
          ${post?.excerpt ? `<p class="article-excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
        </header>
        ${cover ? `<img class="article-cover" src="${escapeHtml(cover)}" alt="${escapeHtml(post?.title || "Article")}" decoding="async">` : ""}
        <div class="article-body">
          ${renderPortableText(post?.content)}
        </div>
      </article>
    `;
  } catch (e) {
    root.innerHTML = `<div class="article-empty">Unable to load this article right now.</div>`;
  }
}

init();

