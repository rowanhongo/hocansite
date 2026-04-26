import { getPublicJobs } from "./supabase.js";

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
  return new Date(iso).toLocaleDateString("en-KE", { year: "numeric", month: "short", day: "numeric" });
}

function toJobUrl(slug) {
  return `/jobs/${encodeURIComponent(slug)}`;
}

async function renderJobs() {
  const list = document.getElementById("jobList") || document.getElementById("jobs-container");
  const count = document.getElementById("jobCount");
  if (!list) return;

  list.innerHTML = `<div class="jobs-loading">Loading jobs...</div>`;

  try {
    const jobs = await getPublicJobs();
    if (count) count.textContent = String(jobs?.length || 0);

    if (!jobs?.length) {
      list.innerHTML = `<div class="jobs-empty">No open positions right now.</div>`;
      return;
    }

    list.innerHTML = "";

    jobs.forEach((job) => {
      const card = document.createElement("a");
      card.className = "job-card";
      card.href = toJobUrl(job.slug);

      card.innerHTML = `
        <div class="job-main">
          <h3 class="job-title">${escapeHtml(job?.title || "")}</h3>
          <div class="job-meta">
            <span class="pill">${escapeHtml(job?.job_type || "Full time")}</span>
            ${job?.industry ? `<span class="pill">${escapeHtml(job.industry)}</span>` : ""}
            ${job?.location ? `<span class="pill">${escapeHtml(job.location)}</span>` : ""}
          </div>
          <p class="desc">${escapeHtml((job?.description || "").slice(0, 170))}${(job?.description || "").length > 170 ? "..." : ""}</p>
          <div class="job-footer"><span>${escapeHtml(formatDate(job?.posted_at || job?.created_at))}</span><span>View Details</span></div>
        </div>
      `;

      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = `<div class="jobs-empty">Unable to load jobs right now. Please try again shortly.</div>`;
  }
}

renderJobs();

