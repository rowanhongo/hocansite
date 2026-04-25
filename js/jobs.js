import {getJobPosts} from "./sanity.js";

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function renderJobs() {
  const list = document.getElementById("jobList") || document.getElementById("jobs-container");
  const count = document.getElementById("jobCount");
  if (!list) return;

  list.innerHTML = `<div class="jobs-loading">Loading jobs...</div>`;

  try {
    const jobs = await getJobPosts();
    if (count) count.textContent = String(jobs?.length || 0);

    if (!jobs?.length) {
      list.innerHTML = `<div class="jobs-empty">No open positions right now.</div>`;
      return;
    }

    list.innerHTML = "";

    jobs.forEach((job) => {
      const card = document.createElement("div");
      card.className = "job-card";
      card.tabIndex = 0;

      card.innerHTML = `
        <div class="job-main">
          <div class="job-title">${escapeHtml(job?.title || "")}</div>
          <div class="job-meta">
            <span>${escapeHtml(job?.location || "")}</span>
            <span class="dot">•</span>
            <span>${escapeHtml(job?.jobType || "")}</span>
          </div>
        </div>
      `;

      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = `<div class="jobs-empty">Unable to load jobs right now. Please try again shortly.</div>`;
  }
}

renderJobs();

