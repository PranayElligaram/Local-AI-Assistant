# JARVIS job agent

An autonomous, conservative job search that runs inside JARVIS. Once set up it
needs no voice command: it searches on a timer, keeps your existing Google
Sheet tracker up to date, hands suitable roles to a separate ChatGPT workflow
for CV tailoring, notices when the CV is ready, and prepares (or, only when you
switch it on, submits) the application.

```
timer (every JOBS_SEARCH_INTERVAL_MINUTES)          timer (every JOBS_TAILORING_WATCH_MINUTES)
  │                                                    │
  ▼                                                    ▼
public ATS boards ──► normalise ──► dedupe ──►     read tracker ──► ChatGPT set ✅ Tailored?
(Greenhouse, Lever,   (job.mjs)    (tracker,           │                 │ yes
 Ashby, Workable,                   META tab,          │                 ▼
 employer JSON-LD)                  local state)       │           TAILORED ──► applier
  │                                                    │           (dry-run: inspect form,
  ▼                                                    │            live: fill, upload CV,
title/location pre-filter ──► full JD ──► evaluate     │            submit, verify evidence)
(criteria.mjs: canonical requirements, fit, rank)      │                 │
  │                                                    │                 ▼
  ▼                                                    │   APPLIED / NEEDS_INPUT / FAILED
rank ──► re-verify open ──► add row to tracker ──► Tailor Queue = 🟢 Ready
                              + JARVIS_META row          (ChatGPT's queue)
                                                             │
            batched update ──► JARVIS transcript + Windows toast; "How is the job search going?"
```

States (`bridge/jobs/state.mjs`), validated on every change:
`DISCOVERED → QUALIFIED → READY_TO_TAILOR → TAILORING → TAILORED → APPLYING → APPLIED`,
plus `REJECTED`, `NEEDS_INPUT` (remembers where it paused), `APPLICATION_FAILED`,
`CLOSED`, `WITHDRAWN` (the agent never withdraws). There is no path from
DISCOVERED to APPLIED, no APPLYING without a tailored CV, and no APPLIED
without positive submission evidence.

## 1. Search rules (canonical — `bridge/jobs/criteria.mjs`)

* **Location**: London / Greater London (onsite or hybrid). UK-remote only when
  the fit is ≥ 85%. Anywhere else is rejected.
* **Seniority**: graduate / entry / junior. A title that does not say so must be
  backed by the description (graduate/early-careers wording, not "mentor junior
  engineers") or an explicit ≤ 2-year requirement; II/III titles are mid-level.
* **Experience**: > 2 years **mandatory** is a hard reject. Each mention is
  classified by sentence and section heading as mandatory, preferred or
  ambiguous; "2+ years preferred" / "nice to have: 3+ years" do not reject;
  an unqualified "3+ years of experience" is treated conservatively as required.
* **Hard exclusions**: senior/lead/staff/principal/manager/architect titles,
  PhD *required* (a preferred PhD is fine), research-scientist level roles,
  heavy production MLOps/SRE, major architecture ownership, pure data/business
  analyst, sales, customer support, manual QA, unpaid roles, postings older than
  `JOBS_MAX_JOB_AGE_DAYS` (90), closed vacancies.
* **Fit** (≥ `JOBS_MIN_FIT_SCORE`, 70): seniority, mandatory experience, role
  family, technical overlap with your background, location, education, other
  mandatory requirements. Banded to steps of 5 and capped at 95 — no fake
  precision. Reasons are recorded for every pass and every rejection.
* **Rank** (what gets added first): fit, then freshness, application ease
  (EASY/MEDIUM/HARD/UNKNOWN from the JD and the real form's question count),
  interview burden (LIGHT/MODERATE/HEAVY/UNKNOWN — unknown stays unknown),
  salary when known (£45k+ up, ~£25k strongly down, unknown neutral), start date.

## 2. Sources (`jarvis.jobs.sources.json`)

Public, documented, unauthenticated APIs only: Greenhouse board API, Lever
postings API (global/EU), Ashby posting API, Workable widget API, and
schema.org `JobPosting` data on employers' own https career pages. No LinkedIn,
no logged-in pages, no CAPTCHA handling, no private APIs. A board that blocks
automated access is recorded as blocked and skipped.

Each run has a request budget (`JOBS_MAX_SOURCE_REQUESTS_PER_RUN`, 60), 15 s
timeouts, a 4 MB response cap, at most one retry, and a per-run cache. Each
board fails independently; its health is in diagnostics. Keep the list short:
one board is one request. Very large boards (e.g. Palantir's Lever feed) exceed
the size cap and are skipped — leave them out.

```json
{ "greenhouse": [{ "board": "monzo", "company": "Monzo" }], "ashby": ["synthesia"],
  "lever": [], "leverEu": [], "workable": [], "careers": ["https://example.com/careers"] }
```

## 3. Google setup (one time)

1. <https://console.cloud.google.com> → new project → **APIs & Services → Library**:
   enable **Google Sheets API** and **Google Drive API**.
2. **OAuth consent screen**: External, app name "JARVIS", add your own Google
   account under **Test users**.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**.
4. In `.env.local` (git-ignored):
   ```
   JOBS_GOOGLE_CLIENT_ID=<client id>
   JOBS_GOOGLE_CLIENT_SECRET=<client secret>
   ```
5. `npm run jobs -- auth` — approves in your browser; the refresh token is
   encrypted with Windows DPAPI (current user) into
   `.jarvis/jobs/google-token.dpapi`. It is never logged or shown in diagnostics.
6. `npm run jobs -- resolve` — finds **"Pranay — AI & Software Job Application
   Tracker"** by exact name (the `BACKUP - …` copy does not match), shows its tabs
   and the column mapping. Zero or several matches → set
   `JOBS_TRACKER_SPREADSHEET_ID`; exactly one is remembered in
   `.jarvis/jobs/state.json`. Pin it anyway:
   `JOBS_TRACKER_SPREADSHEET_ID=<id printed by resolve>`.
7. `JOBS_MASTER_CV_FILE_ID=<id of the master CV>` (read-only check in `resolve`;
   the master CV is never modified — tailored CVs are separate files).

**Scopes**: `spreadsheets` (read the tracker, write JARVIS rows and the
`JARVIS_META` tab), `drive.readonly` (find the tracker by name, confirm the master
CV, download the tailored CV for upload), `drive.file` (only files JARVIS creates).
No full read-write Drive access. Revoke any time at
<https://myaccount.google.com/permissions>, then delete the token file.

## 4. Tracker preservation

* The layout is discovered by header names on every tab; nothing is assumed by
  position.
* Writes are `updateCells` with `fields = userEnteredValue` only: formatting,
  dropdown validation and notes are untouched. A formula cell is never written.
  A new row goes into the first empty row under the table (copied-down formulas
  stay); if the grid is full, one row is inserted inheriting the row above and
  its formulas are copied down.
* Existing rows are never overwritten. JARVIS changes an existing row only to:
  queue it (Tailor Queue empty/Ignore → Ready), record a **verified** application
  (Application Status "Not applied" → "✅ Applied"), and append to Automation Notes.
* Text from job boards is written as literal strings — a posting cannot inject a
  formula.
* Dropdown values are taken from the cell's own validation list.
* Everything JARVIS needs internally goes in one extra tab, `JARVIS_META`.
* Rows are identified by the `[JARVIS:jb_…]` marker in Automation Notes. If
  the marker is edited away, the watcher re-links the row to its `JARVIS_META`
  record only on an exact, unique match (ATS job id, then canonical URL, then
  company + title + location) and appends the marker back to the notes. Zero
  or several matches are reported (`reconcileProblems`), never guessed.

## 5. Application profile and modes

`JOBS_APPLICATION_MODE`:

| mode | what happens to TAILORED roles |
|---|---|
| `off` | nothing |
| `dry-run` (default) | opens the real application page in a separate JARVIS Chrome profile, reads the form, plans answers from your profile, reports blockers. **Types nothing, uploads nothing, submits nothing.** |
| `live` | only with a complete profile audit: fills approved answers, uploads the tailored CV, submits when nothing is unresolved, and records APPLIED only on a confirmation page / number |

Copy `jarvis.jobs.profile.example.json` → `jarvis.jobs.profile.json`
(git-ignored) and fill in only what you are happy to submit. Then
`npm run jobs -- audit` lists: auto-answerable fields, fields required before
live mode (`firstName, lastName, email, phone, city, rightToWorkUK,
requiresSponsorship` — right to work and sponsorship must be an explicit Yes/No),
and what is never answered automatically (health, criminal record, security
clearance, legal declarations beyond the two consents you configure).
Demographic questions are answered only from explicit per-question answers or
the `decline` policy; otherwise optional ones stay blank and required ones need
you. Nothing is ever inferred from the repository, a conversation, the browser
or a model.

**NEEDS_INPUT** (JARVIS stops and tells you) on: CAPTCHA (including an embedded
reCAPTCHA — common on Greenhouse and Ashby forms), login or account creation,
two-factor codes, a required question not covered by the profile, an
unconfigured sponsorship or salary question, a required demographic question,
a required cover letter, a missing tailored CV, a URL that fails validation, or
no recognisable CV upload field. The job keeps its place and resumes where it was.

**APPLIED** needs positive evidence in the page body: "thank you for applying",
"application received/submitted", or a confirmation number, with the form gone
and no error showing. A click, a navigation or a closed browser is never enough;
uncertain outcomes are APPLICATION_FAILED.

The browser opens only https URLs on known ATS hosts (Greenhouse, Lever, Ashby,
Workable, Teamtailor, SmartRecruiters, Recruitee, Personio, BambooHR) or the
employer's own site the job came from — never an aggregator, never a URL with
credentials, and the URL is never placed on a command line. Chrome is launched
per application with a dedicated profile (`.jarvis/jobs/browser-profile`) and
closed afterwards.

Note: the tracker's own config says `Automation mode = REVIEW_BEFORE_APPLY`.
Keep JARVIS in `dry-run` until you change that decision deliberately.

## 6. Scheduler, limits and resources

* Timers, not polling: one timer per task armed for the next due time, stored
  in `.jarvis/jobs/state.json`. First run ~2 minutes after start-up; a missed
  run while JARVIS was off produces exactly one catch-up. Runs never overlap (an
  in-process flag plus a cross-process lock shared with `npm run jobs`).
* "Pause job searching" / "Resume job searching": the queue is kept.
* Limits: `JOBS_MAX_APPLICATIONS_PER_DAY` (3), `JOBS_MAX_NEW_QUALIFIED_PER_RUN`
  (3), `JOBS_MAX_TAILOR_QUEUED_PER_RUN` (2), `JOBS_MAX_TAILOR_BACKLOG` (4),
  `JOBS_MAX_SOURCE_REQUESTS_PER_RUN` (60).
* Idle cost: two timers. No browser runs except during an application step.

## 7. Talking to it

| Say | Answer |
|---|---|
| "How is the job search going?" | today's counts, CVs waiting, roles ready, verified applications, needs-input |
| "How many jobs have you applied to?" | verified submissions only |
| "What jobs did you apply for today?" | |
| "Which applications need me?" | role + the exact blocking reason |
| "Show me today's jobs." | roles added today |
| "Pause job searching." / "Resume job searching." | |
| "Good morning" | adds one job line only when something happened |

A batched update ("Job search update. I found 12 new roles. Four matched your
criteria. …") appears in the JARVIS transcript and as a Windows toast, at most
every 3 hours unless something needs you. It is not spoken over you.

## 8. Diagnostics

`GET /diagnostics` → `jobs`: enabled, paused, mode, last/next run, run in
progress, today's counts, queue sizes, source health, Google/tracker connection,
last error category. No tokens, client secrets, profile values, CV or JD text,
contact details or cookies. Run history (last 30 runs, counts and error
categories only) is in `.jarvis/jobs/state.json`.

## 9. Commands

```
npm run jobs -- status               diagnostics
npm run jobs -- auth                 Google consent (one time)
npm run jobs -- resolve              tracker, tabs, column mapping, master CV check
npm run jobs -- discover [--limit N] DRY RUN: what would be added, and why
npm run jobs -- queue-one --yes      add ONE qualified role and queue it for tailoring
npm run jobs -- watch                one tracker watch pass
npm run jobs -- audit                application-profile audit
npm run jobs -- apply-check <jobId>  dry-run a real application form
```

## 10. Before live applications

1. Google set up; `resolve` shows the right tracker and no mapping problems.
2. `discover` output looks right to you for a few days (turn on
   `JOBS_TRACKER_WRITES=true` when it does).
3. `queue-one --yes`, then let the ChatGPT task tailor it; `watch` shows it TAILORED.
4. Profile filled; `audit` shows `liveModeAllowed: true`.
5. Several `dry-run` inspections (`apply-check`) read the forms correctly.
6. Change the tracker's `REVIEW_BEFORE_APPLY` decision, then
   `JOBS_APPLICATION_MODE=live` — your explicit choice; JARVIS never changes it.
