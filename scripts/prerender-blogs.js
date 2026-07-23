/**
 * Pre-renders published blog posts to static HTML for search engines and AI crawlers.
 * Run during build: node scripts/prerender-blogs.js
 *
 * Writes one real .html file per post to /blog/<slug>.html, each with its own
 * title, meta description, canonical, OG/Twitter tags, JSON-LD Article, and the
 * full article text in the markup. The client-side renderer still takes over on
 * load, so the reader experience is unchanged.
 *
 * Uses: SUPABASE_URL, SUPABASE_ANON_KEY (same env vars as generate-config.js).
 * Never uses the service role key — only published rows are read.
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const SITE = "https://hocanholdings.co.ke";
const TABLE_CANDIDATES = ["blog_posts", "blogs"];

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// JSON-LD sits inside a <script> block, so the only real hazard is closing that block.
function jsonLdSafe(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function fetchPublishedPosts() {
  let lastError = null;
  for (const table of TABLE_CANDIDATES) {
    const url =
      `${SUPABASE_URL}/rest/v1/${table}` +
      `?select=title,slug,category,author,excerpt,content,cover_image_url,published_at,created_at` +
      `&published=eq.true&order=published_at.desc.nullslast`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) return res.json();
    lastError = `${table}: ${res.status} ${await res.text()}`;
  }
  throw new Error(`Could not read blog table. Tried ${TABLE_CANDIDATES.join(", ")}. Last error — ${lastError}`);
}

/** Render the admin's content blocks to semantic HTML (mirrors js/blogPost.js). */
function renderBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || !block.type) return "";
      if (block.type === "heading") return block.text ? `<h2>${escapeHtml(block.text)}</h2>` : "";
      if (block.type === "subheading") return block.text ? `<h3>${escapeHtml(block.text)}</h3>` : "";
      if (block.type === "quote") return block.text ? `<blockquote><p>${escapeHtml(block.text)}</p></blockquote>` : "";
      if (block.type === "list") {
        const items = Array.isArray(block.items) ? block.items : [];
        if (!items.length) return "";
        return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
      }
      if (block.type === "image") {
        if (!block.url) return "";
        const cap = block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : "";
        return `<figure><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption || "Blog image")}">${cap}</figure>`;
      }
      return block.text ? `<p>${escapeHtml(block.text)}</p>` : "";
    })
    .filter(Boolean)
    .join("\n      ");
}

/** Plain text of the post, for meta description fallback and word count. */
function toPlainText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b?.type === "list" ? (b.items || []).join(" ") : b?.text || ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(str, max) {
  const s = String(str || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

function isoDate(post) {
  const raw = post.published_at || post.created_at;
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function buildPage(post) {
  const url = `${SITE}/blog/${encodeURIComponent(post.slug)}`;
  const plain = toPlainText(post.content);
  const description = truncate(post.excerpt || plain || `An article from Hocan Holdings.`, 155);
  const author = post.author || "Hocan Holdings";
  const published = isoDate(post);
  const cover = post.cover_image_url || `${SITE}/assets/logo.png`;
  const words = plain ? plain.split(/\s+/).length : 0;

  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: truncate(post.title || "", 110),
    description,
    image: cover ? [cover] : undefined,
    datePublished: published || undefined,
    dateModified: published || undefined,
    author: { "@type": "Person", name: author },
    publisher: {
      "@type": "Organization",
      name: "Hocan Holdings",
      logo: { "@type": "ImageObject", url: `${SITE}/assets/logo.png` }
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    articleSection: post.category || undefined,
    wordCount: words || undefined,
    inLanguage: "en"
  };

  const dateLabel = published
    ? new Date(published).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(post.title || "Blog Post")} — Hocan Holdings</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="${escapeHtml(author)}">
  <link rel="canonical" href="${escapeHtml(url)}">
  <link rel="icon" type="image/png" href="/Hocan%20Logo.png">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Hocan Holdings">
  <meta property="og:title" content="${escapeHtml(post.title || "")}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(cover)}">
  ${published ? `<meta property="article:published_time" content="${escapeHtml(published)}">` : ""}
  ${post.category ? `<meta property="article:section" content="${escapeHtml(post.category)}">` : ""}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(post.title || "")}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(cover)}">
  <script type="application/ld+json">${jsonLdSafe(ld)}</script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
${fs.readFileSync(path.join(root, "blog-post.html"), "utf8").match(/<style>[\s\S]*?<\/style>/)[0].replace(/^/gm, "  ")}
</head>
<body>
  <main class="container">
    <header class="top-nav">
      <a href="/index.html"><img src="/assets/logo.png" alt="Hocan Holdings"></a>
      <nav>
        <a href="/index.html">Home</a>
        <a href="/about-us.html">About Us</a>
        <a href="/hocan-hr-consulting.html">Services</a>
        <a href="/blogs.html" class="active">Blogs</a>
        <a href="/contact.html">Contact Us</a>
      </nav>
    </header>

    <!-- Pre-rendered for crawlers. js/blogPost.js re-renders this from live data on load. -->
    <div id="blog-post">
      <a class="article-back" href="/blogs.html">All articles</a>
      <article class="article">
        <header class="article-header">
          <div class="article-meta">${escapeHtml(dateLabel)}</div>
          <h1 class="article-title">${escapeHtml(post.title || "")}</h1>
          ${post.excerpt ? `<p class="article-excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
          <div class="article-byline">
            <span class="byline-person">
              <span class="author-info"><strong>${escapeHtml(author)}</strong><small>Author</small></span>
            </span>
          </div>
        </header>
        ${post.cover_image_url ? `<div class="article-cover-wrap"><img class="article-cover" src="${escapeHtml(post.cover_image_url)}" alt="${escapeHtml(post.title || "Article")}"></div>` : ""}
        <div class="article-body">
      ${renderBlocks(post.content)}
        </div>
      </article>
    </div>

${fs.readFileSync(path.join(root, "blog-post.html"), "utf8").match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0].replace(/^/gm, "    ")}
  </main>
  <script type="module" src="/js/blogPost.js"></script>
</body>
</html>
`;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn("prerender-blogs: SUPABASE_URL/ANON_KEY not set — skipping prerender.");
    return;
  }

  const posts = (await fetchPublishedPosts()).filter((p) => p && p.slug && p.title);
  const outDir = path.join(root, "blog");
  fs.mkdirSync(outDir, { recursive: true });

  for (const post of posts) {
    // Slugs come from an admin free-text field; keep the filename filesystem-safe.
    if (/[\\/]|\.\./.test(post.slug)) {
      console.warn(`prerender-blogs: skipping unsafe slug ${JSON.stringify(post.slug)}`);
      continue;
    }
    // <slug>/index.html rather than <slug>.html so /blog/<slug> resolves to a real
    // file without depending on Netlify's optional "Pretty URLs" post-processing.
    const postDir = path.join(outDir, post.slug);
    fs.mkdirSync(postDir, { recursive: true });
    fs.writeFileSync(path.join(postDir, "index.html"), buildPage(post), "utf8");
  }

  writeSitemap(posts);
  appendBlogsToLlmsTxt(posts);
  console.log(`prerender-blogs: wrote ${posts.length} post page(s), sitemap and llms.txt entries.`);
}

/** Replace the placeholder blog-post.html entry with one entry per real post. */
function writeSitemap(posts) {
  const file = path.join(root, "sitemap.xml");
  let xml = fs.readFileSync(file, "utf8");

  // Drop the non-indexable template entries and any previously generated post block.
  xml = xml.replace(/\s*<url>\s*<loc>[^<]*\/blog-post\.html<\/loc>[\s\S]*?<\/url>/g, "");
  xml = xml.replace(/\s*<!-- blog:start -->[\s\S]*?<!-- blog:end -->/g, "");

  const entries = posts
    .map((p) => {
      const lastmod = (isoDate(p) || "").slice(0, 10);
      return `  <url>
    <loc>${SITE}/blog/${encodeURIComponent(p.slug)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;
    })
    .join("\n");

  const block = `\n  <!-- blog:start -->\n${entries}\n  <!-- blog:end -->\n`;
  xml = xml.replace("</urlset>", `${block}</urlset>`);
  fs.writeFileSync(file, xml, "utf8");
}

/** Give LLM crawlers a plain-text index of every article. */
function appendBlogsToLlmsTxt(posts) {
  for (const name of ["llms.txt", "llms-full.txt"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    let txt = fs.readFileSync(file, "utf8").replace(/\n*<!-- blog:start -->[\s\S]*?<!-- blog:end -->\n*/g, "\n");

    const full = name === "llms-full.txt";
    const lines = posts.map((p) => {
      const head = `- [${p.title}](${SITE}/blog/${encodeURIComponent(p.slug)})`;
      const summary = truncate(p.excerpt || toPlainText(p.content), full ? 600 : 160);
      return summary ? `${head}: ${summary}` : head;
    });

    const block = `\n<!-- blog:start -->\n## Blog & Insights\n\nArticles from Hocan Holdings on HR, recruitment, logistics and business in Kenya and East Africa.\n\n${lines.join("\n")}\n<!-- blog:end -->\n`;
    fs.writeFileSync(file, txt.trimEnd() + "\n" + block, "utf8");
  }
}

main().catch((err) => {
  // Never fail the site build over prerendering.
  console.error("prerender-blogs failed:", err.message);
  process.exitCode = 0;
});
