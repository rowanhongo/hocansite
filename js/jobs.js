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

let allJobs = [];

function normalize(v) {
  return String(v || "").toLowerCase();
}

function applyFilters() {
  const list = document.getElementById("jobList");
  const count = document.getElementById("jobCount");
  const q = normalize(document.getElementById("jobSearch")?.value);
  const industry = normalize(document.getElementById("industryFilter")?.value);
  const type = normalize(document.getElementById("typeFilter")?.value);

  const filtered = allJobs.filter((job) => {
    const hay = normalize(`${job.title} ${job.description} ${job.location} ${job.industry}`);
    if (q && !hay.includes(q)) return false;
    if (industry && normalize(job.industry) !== industry) return false;
    if (type && normalize(job.job_type) !== type) return false;
    return true;
  });

  if (count) count.textContent = String(filtered.length);
  list.innerHTML = "";

  if (!filtered.length) {
    list.innerHTML = `<div class="jobs-empty">No matching jobs found. Try different filters.</div>`;
    return;
  }

  filtered.forEach((job) => {
    const card = document.createElement("a");
    card.className = "job-card";
    card.href = toJobUrl(job.slug);

    card.innerHTML = `
      <div class="job-main">
        <h3 class="job-title">${escapeHtml(job?.title || "")}</h3>
        <div class="meta">
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
}

function setupFilterOptions(jobs) {
  const industries = [...new Set(jobs.map((j) => String(j.industry || "").trim()).filter(Boolean))].sort();
  const jobTypes = [...new Set(jobs.map((j) => String(j.job_type || "").trim()).filter(Boolean))].sort();

  const industrySelect = document.getElementById("industryFilter");
  const typeSelect = document.getElementById("typeFilter");
  if (industrySelect) {
    industrySelect.innerHTML = `<option value="">All Departments</option>${industries.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}`;
  }
  if (typeSelect) {
    typeSelect.innerHTML = `<option value="">All Job Types</option>${jobTypes.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}`;
  }
}

async function renderJobs() {
  const list = document.getElementById("jobList") || document.getElementById("jobs-container");
  const count = document.getElementById("jobCount");
  if (!list) return;

  list.innerHTML = `<div class="jobs-loading">Loading jobs...</div>`;

  try {
    const jobs = await getPublicJobs();
    allJobs = jobs || [];
    if (count) count.textContent = String(allJobs.length);

    if (!allJobs.length) {
      list.innerHTML = `<div class="jobs-empty">No open positions right now.</div>`;
      return;
    }

    setupFilterOptions(allJobs);
    applyFilters();
  } catch (e) {
    list.innerHTML = `<div class="jobs-empty">Unable to load jobs right now. Please try again shortly.</div>`;
  }
}

document.getElementById("applyFiltersBtn")?.addEventListener("click", applyFilters);
document.getElementById("jobSearch")?.addEventListener("input", applyFilters);
document.getElementById("industryFilter")?.addEventListener("change", applyFilters);
document.getElementById("typeFilter")?.addEventListener("change", applyFilters);

renderJobs();

