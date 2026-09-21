# ChatGPT CV tailoring workflow — specification

JARVIS finds, verifies, ranks and records roles. **It does not tailor CVs.**
Tailoring is done by a *separate* ChatGPT Scheduled Task that you configure in
ChatGPT yourself. The two never talk to each other directly: the Google Sheet
tracker is the only integration boundary.

```
JARVIS job agent (local)                          ChatGPT Scheduled Task (yours)
────────────────────────                          ──────────────────────────────
discover → verify open → evaluate → dedupe
→ add row to tracker (full JD, application URL,
  [JARVIS:<jobId>] marker)
→ Tailor Queue = "🟢 Ready"          ──────▶      finds "🟢 Ready" rows
                                                  sets "⚙ Processing"
                                                  reads JD + master CV
                                                  writes tailored DOCX/PDF to Drive
                                                  writes CV links back to the row
watches the tracker every ~30 min   ◀──────      sets "✅ Tailored"
→ state TAILORED → application queue
```

JARVIS never opens chatgpt.com, never automates the ChatGPT UI, never reuses
ChatGPT cookies or session tokens, never calls Codex, and never assumes a
ChatGPT subscription is an API. This document is the contract for the ChatGPT
side. Nothing in it was created in ChatGPT by Claude Code — you create the
Scheduled Task yourself (section 7).

---

## 1. Where things live

| What | Where |
|---|---|
| Tracker | Google Sheet **"Pranay — AI & Software Job Application Tracker"** (exact name; a `BACKUP - …` copy exists and must be ignored) |
| Main tab | The first tab whose header row contains `Programme`, `Application Status` and `Tailor Queue` |
| Master CV (factual source) | "Master CV URL" in the tracker's config tab (Resume Tailoring Automation Config). Also `JOBS_MASTER_CV_FILE_ID` in JARVIS. **Never modified.** |
| Tailored CV output root | "Tailored CV Root" / "Tailored CV Root folder ID" in the config tab |
| JARVIS bookkeeping | Tab **`JARVIS_META`** (one row per JARVIS job, keyed by `jobId`) |

## 2. The row contract (main tab)

A role JARVIS adds has, in its existing columns:

| Column | Written by JARVIS | Meaning |
|---|---|---|
| Programme | `Company — Title` | |
| Status | `VERIFIED OPEN — EMPLOYER ATS / GREENHOUSE` (etc.) | re-verified open when added |
| London? | e.g. `Yes — London hybrid` | |
| Opens / surfaced | `Posted 19 Sept 2026; JARVIS verified 21 Sept 2026` | |
| Your eligibility | `✅ reasons…` | why it passed JARVIS's canonical filters |
| Fit % | e.g. `90%` | JARVIS's banded fit (steps of 5, capped at 95) |
| Application Status | `☐ Not applied` | |
| View | `=HYPERLINK(url, "Open role ↗")` | canonical employer/ATS URL |
| Tailor Queue | `🟢 Ready` | **the hand-off signal** |
| Job Description | full plain-text JD | the tailoring input |
| JD Ready? | `✅ Full JD` or `❌ Missing` | |
| Automation Notes | starts with **`[JARVIS:jb_xxxxxx]`** | the stable job identifier |

The stable job id is the `[JARVIS:jb_…]` marker in **Automation Notes** (and
`jobId` in `JARVIS_META`). Row numbers are **not** stable — rows move between
tabs — so always find a row by its marker, never by position.

## 3. States and who changes them

| Tracker value (Tailor Queue) | JARVIS state | Set by |
|---|---|---|
| `🟢 Ready` | `READY_TO_TAILOR` | JARVIS |
| `⚙ Processing` | `TAILORING` | ChatGPT (when it starts a row) |
| `✅ Tailored` **and** a CV link in `CV DOCX` or `CV PDF` | `TAILORED` | ChatGPT |
| `⚠ Review` | `NEEDS_INPUT` (JARVIS tells you) | ChatGPT, when it cannot tailor truthfully |
| `⛔ Skip` | `CLOSED` | you or ChatGPT |

JARVIS detects the change automatically on its next watch pass (default every
30 minutes, `JOBS_TAILORING_WATCH_MINUTES`). No voice command is needed.

`✅ Tailored` without a CV link is **not** treated as tailored — both are needed.

## 4. What the ChatGPT workflow must write back

On success, in the same row:

* **Tailor Queue** → `✅ Tailored`
* **CV DOCX** → link to the tailored document (a Google Doc or `.docx`), e.g.
  `=HYPERLINK("https://docs.google.com/document/d/<id>/edit","DOCX")` or the bare URL
* **CV PDF** → link to the PDF export (optional but preferred)
* **Output Folder** → link to the role's Drive folder
* **Last Tailored** → timestamp, e.g. `21 Sep 2026 20:18`
* **Automation Notes** → *append* a short note; never delete the `[JARVIS:…]` marker
* Optionally **Tailor Decision**, **ATS Before/After**, **Key Gaps** as today

Optionally also, in `JARVIS_META` (row with the same `jobId`): `state` =
`TAILORED`, `tailoredCvUrl`, `tailoredPdfUrl`, `tailoredAt`, `tailoringNotes`.
JARVIS reads either place; the main row is authoritative.

On failure (insufficient facts, JD missing, contradiction): **Tailor Queue** →
`⚠ Review`, and a one-line reason appended to **Automation Notes** (and
`JARVIS_META.state` = `TAILORING_ERROR` or `NEEDS_INPUT` with
`tailoringNotes` = the reason). JARVIS then reports it as needing your input.

Never change: `Programme`, `View`, `Job Description`, `Application Status`,
`Fit %`, formulas, dropdowns, formatting, other rows, other tabs' structure.

## 5. Drive output structure

```
<Tailored CV Root>/
  2026/
    <Company>/
      <Role>/
        job-description            (copy of the JD, optional)
        Pranay_Elligaram_<Company>_<Role>_CV   (Google Doc)
        Pranay_Elligaram_<Company>_<Role>_CV.pdf
        application-notes          (optional)
```

Use filesystem-safe names. **Reuse the folder if it already exists** (look it
up by name first) — never create a duplicate folder on a re-run. A re-run for
the same row updates the existing files rather than adding copies.

## 6. CV tailoring safety contract

The approved master CV / career profile is the **factual boundary**.

**Never invent:** employers · dates · technologies · responsibilities ·
qualifications · metrics · achievements · certifications · education · job
titles.

**May:** rewrite · reorder · emphasise · shorten · expand wording where the
master CV supports it · improve ATS terminology (using the JD's words for
things the candidate genuinely did) · align the summary to the role · reorder
skills · prioritise relevant projects · keep relevant university coursework and
projects (especially for graduate roles).

**Preserve** relevant technical detail and engineering depth — do not
over-compress projects. Follow the tracker config: full 1-page only when the
evidence genuinely fills it, otherwise a balanced 2-page CV.

If the JD asks for something the master CV does not evidence, **do not add
it** — list it under Key Gaps. If the facts are insufficient to produce an
honest, competitive CV, set `⚠ Review` with the reason instead of guessing.

## 7. Paste-ready ChatGPT Scheduled Task prompt

Create this yourself in ChatGPT → Scheduled Tasks (suggested cadence: every
6 hours, matching the tracker's "CV tailoring cadence"). ChatGPT needs its
Google Drive / Sheets connector enabled for your account.

```text
You are my CV tailoring assistant. Run this workflow now, then stop.

SOURCES
- Tracker: the Google Sheet named exactly "Pranay — AI & Software Job Application Tracker"
  (ignore any file whose name starts with "BACKUP").
- Master CV: the file linked as "Master CV URL" in the tracker's
  "Resume Tailoring Automation Config" section. It is the ONLY source of facts about me.
  Never edit it.
- Also follow the "Resume Playbook URL" and "Humanize Skill URL" documents linked there.
- Output root: "Tailored CV Root" folder linked there.

WHAT TO PROCESS
1. Open the main tab (header row contains "Programme", "Application Status", "Tailor Queue").
2. Find rows whose Tailor Queue is exactly "🟢 Ready". Process at most 3 per run,
   highest "Fit %" first. Skip every other row.
3. Identify each row by the "[JARVIS:jb_…]" marker in Automation Notes (if present),
   never by row number. Re-find the row by that marker before every write.
4. If "JD Ready?" is not "✅ Full JD" or the Job Description cell is short or clearly
   incomplete: set Tailor Queue to "⚠ Review", append "NEED_JD: <reason>" to Automation
   Notes, and move on. Do not tailor from a title or URL alone.

FOR EACH ROW
5. Set Tailor Queue to "⚙ Processing".
6. Read the full Job Description cell and the master CV.
7. Tailor the CV truthfully:
   - NEVER invent employers, dates, technologies, responsibilities, qualifications,
     metrics, achievements, certifications, education or job titles.
   - You MAY rewrite, reorder, emphasise, shorten, expand wording where the master CV
     supports it, use the JD's terminology for things I genuinely did, align the summary,
     reorder skills, prioritise relevant projects, and keep relevant university
     coursework and projects.
   - Keep technical depth. Full 1-page only if the evidence fills it; otherwise a
     balanced 2-page CV.
   - Anything the JD wants that the master CV does not evidence goes in "Key Gaps",
     not in the CV.
8. Save to Drive under <Tailored CV Root>/2026/<Company>/<Role>/ (reuse existing folders
   with the same name; never create duplicates). Create the Google Doc
   "Pranay_Elligaram_<Company>_<Role>_CV" and a PDF export of it. If the files already
   exist from an earlier run, update them instead of creating copies.
9. Write back to the SAME row (found again by its marker):
   - CV DOCX: link to the Google Doc
   - CV PDF: link to the PDF
   - Output Folder: link to the role folder
   - Last Tailored: current date and time
   - Tailor Decision, ATS Before, ATS After, Key Gaps: as usual
   - Automation Notes: APPEND one short line; keep the [JARVIS:…] marker intact
   - Tailor Queue: "✅ Tailored"  (only after the links are written)
   If the tracker has a JARVIS_META tab with a row whose jobId matches the marker, also
   set there: state=TAILORED, tailoredCvUrl, tailoredPdfUrl, tailoredAt, tailoringNotes.
10. If you cannot produce an honest CV (facts insufficient, contradictions, the role is
    not what the JD row says): set Tailor Queue to "⚠ Review", append the reason to
    Automation Notes, and (if JARVIS_META exists) set state=TAILORING_ERROR with
    tailoringNotes=<reason>.

NEVER
- Never submit a job application, send an email, or contact an employer.
- Never change Programme, View, Job Description, Application Status, Fit %, formulas,
  dropdown validation, formatting, other rows, or the structure of any tab.
- Never modify the master CV.

FINISH
Reply with a short summary: rows processed, rows tailored, rows set to Review (with reasons).
```

## 8. Checking the hand-off

* `npm run jobs -- watch` runs one watch pass and prints what JARVIS noticed.
* "How is the job search going?" reports CVs waiting for tailoring and tailored
  roles ready to apply.
* A tailored row is attributed to the right job only through its
  `[JARVIS:…]` marker; rows without one are left alone by JARVIS.
