import {getBlogPosts} from "./sanity.js";
import {urlFor} from "./imageBuilder.js";

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

async function renderBlogs() {
  const container = document.getElementById("blog-container");
  if (!container) return;

  container.innerHTML = `<div class="blog-loading">Loading posts...</div>`;

  try {
    const posts = await getBlogPosts();
    if (!posts?.length) {
      container.innerHTML = `<div class="blog-empty">No blog posts yet.</div>`;
      return;
    }

    container.innerHTML = "";

    posts.forEach((post) => {
      const href = post?.slug ? `/blog/${post.slug}` : "#";
      const img = post?.coverImage ? urlFor(post.coverImage).width(600).url() : "";

      const card = document.createElement("a");
      card.className = "blog-card";
      card.href = href;

      card.innerHTML = `
        ${img ? `<img class="blog-card-img" src="${escapeHtml(img)}" alt="${escapeHtml(post?.title || "Blog post")}" loading="lazy" decoding="async">` : ""}
        <div class="blog-card-body">
          <div class="blog-card-meta">${escapeHtml(formatDate(post?._createdAt))}</div>
          <div class="blog-card-title">${escapeHtml(post?.title || "")}</div>
          <div class="blog-card-excerpt">${escapeHtml(post?.excerpt || "")}</div>
        </div>
      `;

      container.appendChild(card);
    });
  } catch (e) {
    container.innerHTML = `<div class="blog-empty">Unable to load posts right now. Please try again shortly.</div>`;
  }
}

renderBlogs();

