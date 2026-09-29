# Leads & Jobs Feed — how to use them

Two panels in the admin dashboard, both fed by the weekly Apify scrape of jobs
advertised in Nairobi.

- **Jobs Feed** — the raw scraped jobs, and the weekly job-seeker lists you hand
  out as PDFs.
- **Leads** — the companies doing the hiring, ranked by how urgently they seem to
  need help, for business development.

Everything is paginated 30 rows at a time.

---

## One-time setup

Do these three things once, in order. Until they are done both panels will show a
red notice telling you what is missing.

### 1. Create the database tables

In Supabase → **SQL Editor**, run the migrations in `supabase/migrations/` in
filename order, newest last:

```
20260929120000_leads_and_jobs.sql               (tables)
20260929170000_fix_ingest_run_conflict_index.sql (index fix)
```

Both are safe to run more than once — they create nothing that already exists
and delete no data.

If the tables were created before 29 Sep 2026, you still need the second file:
without it every ingest writes its data correctly but then reports a failure, and
the "Last scrape ingested" line never updates.

### 2. Add the environment variables

Netlify → **Site settings → Environment variables**:

| Variable | Value | What breaks without it |
|---|---|---|
| `APIFY_API_Key` | Your Apify API token | Nothing can be pulled at all |
| `Gemini_API_Key` | Your Gemini API key | Fit scores, pitch angles, summaries and reworded-repost matching. Everything else still works |
| `GEMINI_MAX_CALLS` | *(optional)* defaults to `12` | Raise it only if your key is on a paid tier — see the note on quotas below |
| `APIFY_WEBHOOK_SECRET` | A long random string you invent | Weekly runs will not ingest by themselves; you would have to press Sync each week |
| `APIFY_ACTOR_ID` | *(optional)* defaults to `inovaflow/google-jobs-scraper` | Only needed if you change scraper |
| `GEMINI_MODEL` | *(optional)* defaults to `gemini-3.8-flash` | Only needed when Google retires a model — set it here rather than waiting for a code change |

For `APIFY_WEBHOOK_SECRET`, any long random string works. This one is fine:

```
openssl rand -hex 32
```

Redeploy after adding them, or the functions will not see them.

### 3. Point Apify at the site

In the Apify console, open your scraper → **Integrations → Add webhook**:

- **Event:** `Run succeeded`
- **URL:**
  ```
  https://hocanholdings.co.ke/.netlify/functions/apify-jobs-webhook-background?secret=YOUR_SECRET_HERE
  ```
  (replace `YOUR_SECRET_HERE` with the exact `APIFY_WEBHOOK_SECRET` value)
- **Payload template:** leave the default

That URL is the credential — anyone holding it can post data in, so treat it
like a password and do not paste it into a public channel.

From then on, every time the scraper finishes, the site ingests the run and
publishes that week's job-seeker list automatically.

> **Worth knowing:** Apify will always show this webhook as succeeding, even if
> the secret is wrong. That is not the site being dishonest — the ingest runs as
> a background job, so Netlify has to acknowledge Apify immediately, before the
> work (or the rejection) happens. **Apify's webhook log is therefore not proof
> that data arrived.** The real check is the "Last scrape ingested" line at the
> top of the Jobs Feed panel. If that date does not move after a run, the secret
> does not match.

---

## Jobs Feed

### Ingestion

The top box shows the last scrape that was ingested: how many jobs and companies
the scraper reported, how many were new, how many links were checked, and how
many were dead.

- **Sync Latest Apify Run** — pulls the most recent successful run by hand. Use
  it for the first load, or if a webhook was missed. It does *not* publish a
  list, so it is always safe to press.
- **Re-check Links** — re-tests a batch of apply links now.

If the scraper ever starts sending a field the site does not store, a yellow
note appears naming it. Nothing is broken when that happens, but it is worth
telling whoever maintains the scraper mapping.

### Weekly job-seeker lists

A list is cut and published automatically after each weekly scrape. A job is
only eligible if it:

- is not from a recruitment agency, and not a confidential or hidden employer
- is in Kenya
- was posted within the last 20 days (adjustable)
- has an apply link that was **verified as working**
- **has never been featured in a previous list**

That last rule is the important one. Because the scraper runs weekly, the same
job will keep appearing in the raw data — but it only ever goes out to job
seekers once. A job reposted at a brand new web address is still recognised, by
matching company + title + location, and the AI additionally catches reposts
whose title was reworded ("Sales Executive" → "Sales Exec – FMCG").

Buttons:

- **Preview Next List** — shows exactly what would go out, and how many jobs were
  held back and why. Nothing is committed. Use this to sanity-check a week.
- **Publish List Now** — cuts a list immediately. Asks you to confirm, because
  every job in it is permanently marked as featured and can never appear again.
  You normally do not need this; the weekly run does it for you.
- **Download PDF** — on any row in the history.

Four weeks are kept (this week plus three back). When a fifth is published the
oldest PDF drops off. The jobs in a dropped list stay marked as featured, so
they still never come back.

**The PDF** is Hocan-branded, with the week's date, and every "Apply for this
job" line is a real clickable link — verified to work in Acrobat, Preview,
Chrome and phone viewers. It carries no job descriptions and no recruiter names
or contact details, only the role, employer, location, date, source and link,
plus a one-line summary where one helps.

### Scraped Jobs

The full table, newest posting first. The **view** dropdown filters it:

| View | Shows |
|---|---|
| Ready for a list | Eligible, link verified, not yet featured |
| All jobs | Everything |
| Already featured | Jobs that have gone out |
| Flagged by AI | Suspected agency or hidden employer — needs your call |
| Excluded | Dropped by the keyword rules, with the reason |
| Dead links | Apply link is broken |

**Flagged jobs are held back but not deleted.** The AI only raises a hand; you
decide. If it is wrong, press **Unflag** and the job becomes eligible again.

A date shown as "approx." was worked out from a relative label like "3 days
ago", so it is accurate to the day at best.

---

## Leads

One row per hiring company: the roles they are advertising with counts, where
they are, how recent, industry, size, and where we saw them.

### Urgency

A 0–100 score worked out **by a script, not the AI** — models miscount, and a
rank has to mean the same thing every week. Seven signals:

| Signal | Default weight | Why it matters |
|---|---|---|
| Distinct open roles | 25 | Several separate positions means funded expansion, not one backfill |
| Bulk hiring of one role | 15 | 10 drivers or 6 agents is volume hiring they probably cannot staff alone — our strongest opening |
| Recency | 20 | A need advertised three days ago is live; three weeks ago may be filled |
| Reposted roles | 10 | Re-advertising means their own hiring is not working |
| HR or people roles | 10 | They are building people capability, and often have no HR function to say no to us |
| Seniority | 10 | Senior and executive openings mean budget authority |
| Appearances across runs | 10 | Showing up week after week is continuous demand, not a spike |

Every count is taken over **de-duplicated** jobs, so the same posting seen on
five job boards counts once and cannot inflate a rank.

To change the weights, open **Urgency Formula & Weights**, adjust the numbers,
and press **Preview Effect** to see how your top leads would be re-ranked before
you commit. **Save Weights & Rescore** applies them to every lead at once. The
score is rescaled so it stays a 0–100 reading whatever numbers you choose, which
means old and new scores remain comparable.

Press **Details** on any row to see the score broken down signal by signal,
alongside the actual postings it was computed from. The rank is always auditable.

### A note on the AI, and why the vetting does not depend on it

The free Gemini tier is small — a real key allowed **20 requests per day**. That
is enough to keep the weekly list and the fit scores ticking over, but not
enough to re-review everything on demand, and you will see "Awaiting AI Review"
whenever it runs out. That resets at midnight Pacific time.

**This does not weaken the vetting.** Everything that decides whether a job or a
company is worth your attention is deterministic and runs without the AI:

- agencies, competitors, confidential and non-Kenya postings are excluded by
  keyword rules plus your own blocklists
- duplicates and reposts are matched on the canonical apply URL and on
  company + title + location
- apply links are verified by an actual HTTP request
- the urgency ranking is arithmetic over de-duplicated jobs

The AI adds a fit score, a pitch angle and a catch for reworded reposts. Useful,
not load-bearing. A list published with no AI at all is still correctly filtered,
correctly de-duplicated, correctly ordered and free of dead links.

If you want the AI columns filled reliably, enabling billing on the Gemini key is
the only real fix, and it is cheap at this volume. Otherwise press **Resume AI
Review** the next day and it will catch up.

### AI review

Layered on top, advisory only:

- **Fit score 1–10** for our services
- **A one-line reason** citing what in the data drove it
- **A suggested pitch angle** — which service to lead with

The AI is instructed to use only the scraped text, to answer "unknown" rather
than guess, never to invent contacts or facts, to reject agencies, competitors
and non-Kenya jobs, and to score multinationals lower when the role is regional
or head-office rather than Nairobi operational. Where it says **unknown**, that
is a real answer, not a loading state.

You can edit what it is told we sell under **Exclusions & AI Brief** — useful if
the pitch angles are coming back off-target.

Because the Gemini free tier allows roughly 250 requests a day, a large scrape
can run out part-way. If that happens nothing is lost or guessed: the remaining
companies sit in "Awaiting AI Review" and a **Resume AI Review** button appears.
Press it to finish.

### Working the pipeline

Set **status** straight from the table: `new → contacted → replied → won` or
`rejected`. A company you have already contacted will never resurface as new,
including after later scrapes — the status, notes and review date are yours and
are never overwritten by the weekly recompute.

Press **Details** to add **notes**, a **website** and an **industry**, and
**Save & Mark Reviewed** to stamp the review date.

**Delete** removes a lead from the pipeline along with its notes and status. It
asks you to confirm. The scraped jobs behind it are kept, so the company can
come back as a fresh lead on a later scrape if it starts hiring again.

### Fixing a wrong exclusion

Agencies and competitors are caught by keyword rules first, so every exclusion
is explainable rather than a silent judgement. If something was wrongly dropped
— or wrongly kept — open **Exclusions & AI Brief** and edit the two blocklists.
Matching is loose, so "Acme" also catches "Acme Kenya Ltd". Changes apply from
the next scrape; press **Sync Latest Apify Run** to re-evaluate immediately.

Tick **Show rejected/excluded** on the leads table to see what was excluded and
why.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| Red "Setup needed" notice | The migration has not been run. See step 1 |
| "APIFY_API_Key is not set" | Add it in Netlify and redeploy |
| "APIFY_WEBHOOK_SECRET is not set" | Weekly runs will not auto-ingest. Use Sync until you add it |
| "Gemini_API_Key is not set" | AI columns unavailable; urgency ranking and lists still work |
| Lots of companies "Awaiting AI Review" | Free-tier quota ran out. Press Resume AI Review |
| Badge reads "Jobs OK, AI unavailable" | The scrape landed and the urgency ranks are correct; only the AI columns are missing. Usually a passing Google outage — press Sync again later, or Resume AI Review |
| `Gemini model "..." is unavailable (404)` | Google retired that model. Set `GEMINI_MODEL` in Netlify to a current one and redeploy |
| A thin weekly list | Normal after a few weeks — most jobs have already been featured. Press Preview Next List to see the breakdown |
| Apply link marked dead but works in your browser | Some job sites refuse automated checks. 401/403/429 are already treated as live; a genuine 404 is not. Press Re-check on the row |
| Apify says the webhook succeeded but nothing arrived | Almost always a mismatched `APIFY_WEBHOOK_SECRET`. Apify sees a success either way (see the note in step 3) — trust the "Last scrape ingested" date instead. Re-copy the secret, redeploy, and press Sync in the meantime |
