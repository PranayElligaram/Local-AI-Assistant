/**
 * The user's Google Sheet tracker: read its schema, map JARVIS's fields onto
 * the columns that already exist, and write without damaging anything.
 *
 * Preservation rules (all enforced here, all tested):
 *   - The layout is discovered, not assumed: header rows are found by name on
 *     every tab, so moved or added columns keep working.
 *   - Writes are Sheets `updateCells` with fields = "userEnteredValue" only,
 *     so formatting, data validation and notes on the cell are untouched.
 *   - A cell holding a formula is never written (copied-down formulas stay).
 *   - A new row goes into the first genuinely empty row below the table; if
 *     the grid is full, one row is inserted inheriting the row above's
 *     formatting/validation, and that row's formulas are copied down.
 *   - An existing row is never overwritten: updates are limited to a few
 *     JARVIS-owned transitions (queue a role for tailoring, record a verified
 *     application, append to Automation Notes) and each checks the current
 *     value first.
 *   - A value is written only if it is allowed by the cell's dropdown.
 *   - Text from job boards is written as a literal string, never a formula.
 *   - JARVIS's own bookkeeping lives in one extra tab, JARVIS_META.
 */

import { atsIdFromUrl, canonicalUrl, locationKey } from './job.mjs'
import { driveIdFromUrl } from './google/api.mjs'
import { normalizeKey } from './text.mjs'

export const META_TAB = 'JARVIS_META'
export const META_HEADERS = [
  'jobId', 'state', 'company', 'title', 'location', 'source', 'atsJobId', 'canonicalUrl', 'applicationUrl', 'postedDate',
  'discoveredAt', 'lastVerifiedAt', 'fitScore', 'rankScore', 'applicationDifficulty', 'interviewDifficulty', 'trackerTab',
  'descriptionFingerprint', 'tailoredCvUrl', 'tailoredPdfUrl', 'tailoredAt', 'tailoringNotes', 'needsInputReason',
  'appliedAt', 'submissionEvidence', 'updatedAt', 'mode',
]

/** JARVIS field -> header names it may appear under, most specific first. */
export const COLUMN_NAMES = {
  programme: ['programme', 'role', 'job', 'position'],
  status: ['status', 'vacancy status'],
  location: ['london', 'location'],
  surfaced: ['opens surfaced', 'posted', 'surfaced'],
  deadline: ['deadline'],
  eligibility: ['your eligibility', 'eligibility'],
  fit: ['fit', 'fit score'],
  priority: ['priority'],
  applicationStatus: ['application status', 'outcome stage'],
  view: ['view', 'link', 'url'],
  tailorQueue: ['tailor queue'],
  jd: ['job description'],
  jdReady: ['jd ready'],
  cvPdf: ['cv pdf', 'download cv pdf'],
  cvDocx: ['cv docx', 'download cv docx'],
  outputFolder: ['output folder'],
  lastTailored: ['last tailored'],
  notes: ['automation notes', 'notes'],
}
const REQUIRED_FOR_WRITES = ['programme', 'tailorQueue', 'jd', 'notes', 'applicationStatus']

export const MARKER = /\[JARVIS:(jb_[a-z0-9]+)\]/

const headerKey = (s) => normalizeKey(String(s ?? '').replace(/[%?]/g, ' '))

function cellOf(v) {
  if (!v) return { value: '', formula: null, link: null, validation: null, kind: null }
  const uev = v.userEnteredValue ?? {}
  const formula = typeof uev.formulaValue === 'string' ? uev.formulaValue : null
  let link = v.hyperlink ?? null
  if (!link && formula) {
    const m = /^=\s*HYPERLINK\(\s*"([^"]+)"/i.exec(formula)
    if (m) link = m[1]
  }
  const value = v.formattedValue ?? (uev.stringValue ?? (uev.numberValue != null ? String(uev.numberValue) : uev.boolValue != null ? String(uev.boolValue) : ''))
  const cond = v.dataValidation?.condition
  return {
    value: String(value),
    formula,
    link,
    kind: formula ? 'formula' : uev.numberValue != null ? 'number' : uev.stringValue != null ? 'string' : null,
    validation: cond ? { type: cond.type, values: (cond.values ?? []).map((x) => x.userEnteredValue), strict: Boolean(v.dataValidation.strict) } : null,
  }
}

/** Parse a spreadsheets.get (with grid data) into tabs with located headers. */
export function parseSpreadsheet(ss, { mainTab = null } = {}) {
  const sheets = (ss.sheets ?? []).map((s) => {
    const p = s.properties ?? {}
    const grid = s.data?.[0] ?? {}
    const offset = grid.startRow ?? 0
    const rows = (grid.rowData ?? []).map((r, i) => ({ row: offset + i, cells: (r.values ?? []).map(cellOf) }))
    const tab = { sheetId: p.sheetId, title: p.title ?? '', index: p.index ?? 0, rowCount: p.gridProperties?.rowCount ?? rows.length, columnCount: p.gridProperties?.columnCount ?? 0, rows, headerRow: null, cols: {}, headers: [] }
    for (const r of rows.slice(0, 25)) {
      const keys = r.cells.map((c) => headerKey(c.value))
      const hits = Object.values(COLUMN_NAMES).filter((names) => keys.some((k) => names.includes(k))).length
      if (keys.includes('programme') || (keys.includes('jobid') && keys.includes('state')) || hits >= 4) {
        tab.headerRow = r.row
        tab.headers = keys
        for (const [field, names] of Object.entries(COLUMN_NAMES)) {
          for (const n of names) {
            const col = keys.indexOf(n)
            if (col >= 0) {
              tab.cols[field] = col
              break
            }
          }
        }
        break
      }
    }
    return tab
  })
  const tabs = sheets.filter((t) => t.headerRow != null)
  const main =
    (mainTab && tabs.find((t) => t.title === mainTab)) ??
    tabs
      .filter((t) => t.title !== META_TAB && t.headers.includes('application status') && 'tailorQueue' in t.cols && !/void|applied|reject|archive|closed|hold|pipeline|round/i.test(t.title))
      .sort((a, b) => a.index - b.index)[0] ??
    null
  const meta = sheets.find((t) => t.title === META_TAB) ?? null
  return { title: ss.properties?.title ?? '', sheets, tabs, main, meta }
}

/** Is the mapping complete enough to write safely? */
export function mappingProblems(parsed) {
  if (!parsed.main) return ['no main tracker tab with Programme / Application Status / Tailor Queue headers was found']
  return REQUIRED_FOR_WRITES.filter((f) => !(f in parsed.main.cols)).map((f) => `main tab has no column for ${f}`)
}

const cellAt = (tab, row, col) => tab.rows.find((r) => r.row === row)?.cells[col] ?? { value: '', formula: null, link: null, validation: null, kind: null }

/** Split "Company — Title" as the tracker writes it. */
export function splitProgramme(s) {
  const text = String(s ?? '').trim()
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(text)
  return m ? { company: m[1].trim(), title: m[2].trim() } : { company: '', title: text }
}

/** Every role row on every tab, as dedupe/queue records. */
export function trackerRecords(parsed) {
  const out = []
  for (const tab of parsed.tabs) {
    if (tab.title === META_TAB || !('programme' in tab.cols)) continue
    for (const r of tab.rows) {
      if (r.row <= tab.headerRow) continue
      const get = (f) => (f in tab.cols ? r.cells[tab.cols[f]] ?? cellOf(null) : cellOf(null))
      const programme = get('programme').value.trim()
      if (!programme) continue
      const { company, title } = splitProgramme(programme)
      const view = get('view')
      const marker = MARKER.exec(get('notes').value)
      out.push({
        tab: tab.title,
        sheetId: tab.sheetId,
        row: r.row,
        isMain: tab === parsed.main,
        programme,
        company,
        title,
        location: get('location').value,
        applicationUrl: canonicalUrl(view.link ?? (/^https?:/.test(view.value) ? view.value : '')) ?? '',
        jobId: marker?.[1] ?? null,
        tailorQueue: queueState(get('tailorQueue').value),
        applicationStatus: applicationState(get('applicationStatus').value, tab.title),
        cvPdf: get('cvPdf').link ?? (/^https?:/.test(get('cvPdf').value) ? get('cvPdf').value : null),
        cvDocx: get('cvDocx').link ?? (/^https?:/.test(get('cvDocx').value) ? get('cvDocx').value : null),
        outputFolder: get('outputFolder').link ?? null,
        lastTailored: get('lastTailored').value,
      })
    }
  }
  return out
}

export function queueState(v) {
  const s = String(v ?? '').toLowerCase()
  if (!s.trim()) return ''
  if (/ready/.test(s)) return 'ready'
  if (/processing|in progress|tailoring/.test(s)) return 'processing'
  if (/tailored|generated|done|complete/.test(s)) return 'tailored'
  if (/review|need/.test(s)) return 'review'
  if (/skip/.test(s)) return 'skip'
  if (/ignore/.test(s)) return 'ignore'
  return 'other'
}

export function applicationState(v, tabTitle = '') {
  const s = String(v ?? '').toLowerCase()
  if (/not applied/.test(s)) return 'not-applied'
  if (/reject/.test(s)) return 'rejected'
  if (/void|closed|deadline/.test(s) || /void/i.test(tabTitle)) return 'void'
  if (/applied|waiting|next round|interview|offer/.test(s)) return 'applied'
  return s.trim() ? 'other' : ''
}

/** The option in a dropdown matching `re`, else `fallback` (or null when a strict list forbids it). */
function option(tab, col, re, fallback) {
  const sample = tab.rows.filter((r) => r.row > tab.headerRow).map((r) => r.cells[col]?.validation).find((v) => v?.type === 'ONE_OF_LIST')
  if (!sample) return fallback
  return sample.values.find((v) => re.test(String(v))) ?? null
}

/** How existing rows store this column: 'number', 'formula', 'string' or null. */
function columnKind(tab, col) {
  const counts = {}
  for (const r of tab.rows) if (r.row > tab.headerRow && r.cells[col]?.kind) counts[r.cells[col].kind] = (counts[r.cells[col].kind] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const SOURCE_LABEL = { greenhouse: 'EMPLOYER ATS / GREENHOUSE', lever: 'EMPLOYER ATS / LEVER', ashby: 'EMPLOYER ATS / ASHBY', workable: 'EMPLOYER ATS / WORKABLE', careers: 'EMPLOYER CAREERS' }
const quoteFormula = (s) => String(s).replace(/"/g, '""')

/** A literal cell value. Strings are stringValue, so "=..." from a job board stays text. */
export const literal = (v) => (typeof v === 'number' ? { numberValue: v } : { stringValue: String(v ?? '') })

/**
 * Where a new role row goes and what is written into it.
 * @returns {{ ok: boolean, reason?: string, sheetId?: number, row?: number, insertRow?: boolean, cells?: {col:number, value:object}[], copyFormulasFrom?: number, formulaCols?: number[] }}
 */
export function planInsert(parsed, job, { queue = false, now = new Date(), tabName } = {}) {
  const problems = mappingProblems(parsed)
  if (problems.length) return { ok: false, reason: problems.join('; ') }
  const tab = parsed.main
  const c = tab.cols
  const dataRows = tab.rows.filter((r) => r.row > tab.headerRow)
  const lastData = dataRows.filter((r) => String(r.cells[c.programme]?.value ?? '').trim()).at(-1)?.row ?? tab.headerRow
  // First row below the table whose every non-formula cell is empty.
  let target = null
  for (let row = lastData + 1; row < tab.rowCount; row++) {
    const r = tab.rows.find((x) => x.row === row)
    if (!r || r.cells.every((cell) => cell.formula || !String(cell.value).trim())) {
      target = row
      break
    }
  }
  // No free row: insert one directly under the table, as a person would.
  const insertRow = target == null
  if (insertRow) target = lastData + 1
  const formulaColsOf = (row) => (tab.rows.find((r) => r.row === row)?.cells ?? []).map((cell, i) => (cell.formula ? i : -1)).filter((i) => i >= 0)
  const formulaSource = lastData
  const formulaCols = insertRow ? formulaColsOf(lastData) : []
  const blocked = new Set(insertRow ? formulaCols : formulaColsOf(target))

  const cells = []
  const put = (field, value) => {
    if (!(field in c) || value == null || value === '') return
    const col = c[field]
    if (blocked.has(col)) return
    cells.push({ col, value })
  }
  const ev = job.evaluation ?? {}
  put('programme', literal(`${job.company} — ${job.title}`))
  put('status', literal(`VERIFIED OPEN — ${SOURCE_LABEL[String(job.source).split(':')[0]] ?? 'EMPLOYER'}`))
  put('location', literal(ev.location?.label ?? job.location))
  put('surfaced', literal(`${job.postedDate ? `Posted ${fmtDate(job.postedDate)}; ` : ''}JARVIS verified ${fmtDate(job.lastVerifiedAt ?? now.toISOString())}`))
  put('deadline', literal('Not stated'))
  put('eligibility', literal(`✅ ${(job.fitReasons ?? []).join('; ')}`.slice(0, 600)))
  if ('fit' in c) put('fit', columnKind(tab, c.fit) === 'number' ? literal(job.fitScore / 100) : literal(`${job.fitScore}%`))
  if ('priority' in c) {
    const want = job.fitScore >= 90 ? /^very high/i : job.fitScore >= 85 ? /^high/i : job.fitScore >= 80 ? /^medium-high/i : /^medium$/i
    const p = option(tab, c.priority, want, job.fitScore >= 90 ? 'Very high' : job.fitScore >= 85 ? 'High' : job.fitScore >= 80 ? 'Medium-high' : 'Medium')
    if (p) put('priority', literal(p))
  }
  const notApplied = option(tab, c.applicationStatus, /not applied/i, '☐ Not applied')
  if (notApplied) put('applicationStatus', literal(notApplied))
  const url = canonicalUrl(job.applicationUrl)
  if (url && 'view' in c) put('view', columnKind(tab, c.view) === 'formula' ? { formulaValue: `=HYPERLINK("${quoteFormula(url)}","Open role ↗")` } : literal(url))
  if (queue) {
    const ready = option(tab, c.tailorQueue, /ready/i, '🟢 Ready')
    if (!ready) return { ok: false, reason: 'the Tailor Queue dropdown has no "Ready" option' }
    put('tailorQueue', literal(ready))
  }
  put('jd', literal(String(job.description ?? '').slice(0, 45_000)))
  const full = String(job.description ?? '').length >= 600
  const jdReady = option(tab, c.jdReady ?? -1, full ? /full/i : /missing/i, full ? '✅ Full JD' : '❌ Missing')
  if (jdReady) put('jdReady', literal(jdReady))
  put('notes', literal(noteText(job, now, tabName)))
  return { ok: true, sheetId: tab.sheetId, row: target, insertRow, cells, copyFormulasFrom: insertRow ? formulaSource : null, formulaCols: insertRow ? formulaCols : [] }
}

export function noteText(job, now = new Date(), extra = '') {
  return [
    `[JARVIS:${job.id}] Added ${fmtDate(now.toISOString())} by the JARVIS job agent from ${job.source}.`,
    `Fit ${job.fitScore}% — ${(job.fitReasons ?? []).slice(0, 4).join('; ')}.`,
    `Application ${String(job.applicationDifficulty).toLowerCase()}; interview ${String(job.interviewDifficulty).toLowerCase()}.`,
    extra,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000)
}

/** Sheets requests for a planInsert result. */
export function insertRequests(plan) {
  const reqs = []
  if (plan.insertRow) {
    reqs.push({ insertDimension: { range: { sheetId: plan.sheetId, dimension: 'ROWS', startIndex: plan.row, endIndex: plan.row + 1 }, inheritFromBefore: true } })
    for (const col of plan.formulaCols) {
      reqs.push({
        copyPaste: {
          source: { sheetId: plan.sheetId, startRowIndex: plan.copyFormulasFrom, endRowIndex: plan.copyFormulasFrom + 1, startColumnIndex: col, endColumnIndex: col + 1 },
          destination: { sheetId: plan.sheetId, startRowIndex: plan.row, endRowIndex: plan.row + 1, startColumnIndex: col, endColumnIndex: col + 1 },
          pasteType: 'PASTE_FORMULA',
        },
      })
    }
  }
  for (const { col, value } of plan.cells) reqs.push(cellWrite(plan.sheetId, plan.row, col, value))
  return reqs
}

export const cellWrite = (sheetId, row, col, value) => ({
  updateCells: { start: { sheetId, rowIndex: row, columnIndex: col }, rows: [{ values: [{ userEnteredValue: value }] }], fields: 'userEnteredValue' },
})

/**
 * The few updates JARVIS may make to a row that already exists, each only
 * from an expected current value. Anything else is refused.
 *   queue:    Tailor Queue empty/Ignore -> Ready
 *   applied:  Application Status "Not applied" -> Applied (verified submissions only)
 *   note:     append a line to Automation Notes
 */
export function planRowUpdate(parsed, rec, change) {
  const tab = parsed.tabs.find((t) => t.sheetId === rec.sheetId)
  if (!tab) return { ok: false, reason: 'tab not found' }
  const c = tab.cols
  const current = (f) => cellAt(tab, rec.row, c[f])
  const reqs = []
  if (change.queue) {
    const cur = current('tailorQueue')
    if (cur.formula || !['', 'ignore'].includes(queueState(cur.value))) return { ok: false, reason: `Tailor Queue is "${cur.value}", not empty/Ignore` }
    const ready = option(tab, c.tailorQueue, /ready/i, '🟢 Ready')
    if (!ready) return { ok: false, reason: 'no Ready option' }
    reqs.push(cellWrite(tab.sheetId, rec.row, c.tailorQueue, literal(ready)))
  }
  if (change.applied) {
    if (!change.evidence?.verified) return { ok: false, reason: 'no verified submission evidence' }
    const cur = current('applicationStatus')
    if (cur.formula || applicationState(cur.value) !== 'not-applied') return { ok: false, reason: `Application Status is "${cur.value}"` }
    const applied = option(tab, c.applicationStatus, /^✅?\s*applied/i, '✅ Applied')
    if (!applied) return { ok: false, reason: 'no Applied option' }
    reqs.push(cellWrite(tab.sheetId, rec.row, c.applicationStatus, literal(applied)))
  }
  if (change.note && 'notes' in c) {
    const cur = current('notes')
    if (!cur.formula) {
      const text = `${cur.value ? `${cur.value}\n` : ''}${String(change.note).slice(0, 400)}`.slice(-4000)
      reqs.push(cellWrite(tab.sheetId, rec.row, c.notes, literal(text)))
      // Later notes planned into the same batch append to this one, not replace it.
      const row = tab.rows.find((r) => r.row === rec.row)
      if (row) row.cells[c.notes] = { ...cur, value: text, kind: 'string' }
    }
  }
  return { ok: true, requests: reqs }
}

// --- marker recovery -----------------------------------------------------------

const metaAts = (m) => (m.atsJobId && m.source ? `${String(m.source).split(':')[0]}:${m.atsJobId}` : atsIdFromUrl(m.applicationUrl) ?? atsIdFromUrl(m.canonicalUrl))
const ctlKey = (company, title, location) => (company && title ? `${normalizeKey(company)}|${normalizeKey(title)}|${locationKey(location)}` : null)
const LEVELS = ['ats', 'url', 'ctl']

/**
 * How strongly an unmarked row is the same vacancy as a meta record: 'ats',
 * 'url', 'ctl' (company + title + location, exact after normalising case and
 * punctuation), or null. Differing ATS ids rule a pair out entirely.
 */
function identityLevel(rec, m) {
  const ra = atsIdFromUrl(rec.applicationUrl)
  const ma = metaAts(m)
  if (ra && ma) return ra === ma ? 'ats' : null
  if (rec.applicationUrl && [m.applicationUrl, m.canonicalUrl].map(canonicalUrl).includes(rec.applicationUrl)) return 'url'
  const rk = ctlKey(rec.company, rec.title, rec.location)
  if (rk && rk === ctlKey(m.company, m.title, m.location)) return 'ctl'
  return null
}

/**
 * Re-link tracker rows whose [JARVIS:id] marker was removed (e.g. Automation
 * Notes rewritten by the tailoring workflow) to their JARVIS_META record.
 * Deterministic only: each meta record in `jobIds` is matched at the
 * strongest identity level available, and only when exactly one unmarked row
 * matches at that level and that row matches no other record at that level.
 * Anything else is reported as a problem and left alone — never guessed.
 * @returns {{ matches: Map<string, object>, problems: {jobId:string, reason:string}[] }}
 */
export function recoverMarkers(records, metas, jobIds) {
  const marked = new Set(records.map((r) => r.jobId).filter(Boolean))
  const unmarked = records.filter((r) => !r.jobId)
  const wanted = metas.filter((m) => jobIds.has(m.jobId) && !marked.has(m.jobId))
  const levelOf = new Map() // `${jobId}#${row}` -> level
  for (const m of wanted) for (const r of unmarked) {
    const l = identityLevel(r, m)
    if (l) levelOf.set(`${m.jobId}#${r.sheetId}!${r.row}`, l)
  }
  const matches = new Map()
  const problems = []
  for (const m of wanted) {
    const hits = unmarked.map((r) => ({ r, l: levelOf.get(`${m.jobId}#${r.sheetId}!${r.row}`) })).filter((h) => h.l)
    if (!hits.length) {
      problems.push({ jobId: m.jobId, reason: 'no tracker row carries its marker or matches it exactly' })
      continue
    }
    const best = LEVELS.find((l) => hits.some((h) => h.l === l))
    const top = hits.filter((h) => h.l === best)
    if (top.length > 1) {
      problems.push({ jobId: m.jobId, reason: `${top.length} unmarked rows match by ${best}: ${top.map((h) => `${h.r.tab}!${h.r.row + 1}`).join(', ')}` })
      continue
    }
    const r = top[0].r
    const rivals = wanted.filter((o) => o !== m && levelOf.get(`${o.jobId}#${r.sheetId}!${r.row}`) === best)
    if (rivals.length) {
      problems.push({ jobId: m.jobId, reason: `row ${r.tab}!${r.row + 1} also matches ${rivals.map((o) => o.jobId).join(', ')} by ${best}` })
      continue
    }
    matches.set(m.jobId, { ...r, jobId: m.jobId, recoveredBy: best })
  }
  return { matches, problems }
}

// --- JARVIS_META -------------------------------------------------------------

export function metaRecords(parsed) {
  const tab = parsed.meta
  if (!tab || tab.headerRow == null) return []
  const idx = Object.fromEntries(META_HEADERS.map((h) => [h, tab.headers.indexOf(normalizeKey(h))]))
  return tab.rows
    .filter((r) => r.row > tab.headerRow && r.cells[idx.jobId]?.value)
    .map((r) => ({ row: r.row, ...Object.fromEntries(META_HEADERS.map((h) => [h, idx[h] >= 0 ? r.cells[idx[h]]?.value ?? '' : ''])) }))
}

/** Requests that create the meta tab (at the end, never touching other tabs) if it is missing. */
export function ensureMetaRequests(parsed, sheetId = 7_000_000 + Math.floor(Math.random() * 1_000_000)) {
  if (parsed.meta) return { sheetId: parsed.meta.sheetId, requests: [] }
  return {
    sheetId,
    requests: [
      { addSheet: { properties: { sheetId, title: META_TAB, index: parsed.sheets.length, gridProperties: { rowCount: 200, columnCount: META_HEADERS.length, frozenRowCount: 1 } } } },
      { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: META_HEADERS.map((h) => ({ userEnteredValue: literal(h) })) }], fields: 'userEnteredValue' } },
    ],
  }
}

export function metaRow(job, mode) {
  const v = {
    jobId: job.id,
    state: job.status,
    company: job.company,
    title: job.title,
    location: job.location,
    source: job.source,
    atsJobId: job.sourceJobId,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl,
    postedDate: job.postedDate ?? '',
    discoveredAt: job.discoveredAt,
    lastVerifiedAt: job.lastVerifiedAt,
    fitScore: job.fitScore,
    rankScore: job.rankScore,
    applicationDifficulty: job.applicationDifficulty,
    interviewDifficulty: job.interviewDifficulty,
    trackerTab: job.trackerTab ?? '',
    descriptionFingerprint: job.descriptionFingerprint ?? '',
    tailoredCvUrl: job.tailoredCvUrl ?? '',
    tailoredPdfUrl: job.tailoredPdfUrl ?? '',
    tailoredAt: job.tailoredAt ?? '',
    tailoringNotes: job.tailoringNotes ?? '',
    needsInputReason: job.needsInput?.reason ?? '',
    appliedAt: job.appliedAt ?? '',
    submissionEvidence: job.submissionEvidence ? `${job.submissionEvidence.kind}: ${job.submissionEvidence.detail}`.slice(0, 200) : '',
    updatedAt: job.updatedAt ?? new Date().toISOString(),
    mode,
  }
  return META_HEADERS.map((h) => ({ userEnteredValue: literal(typeof v[h] === 'number' ? v[h] : String(v[h] ?? '')) }))
}

/** Upsert one job's meta row: update in place if present, else append. */
export function metaUpsertRequests(parsed, metaSheetId, job, mode) {
  const existing = metaRecords(parsed).find((m) => m.jobId === job.id)
  const values = metaRow(job, mode)
  if (existing) return [{ updateCells: { start: { sheetId: metaSheetId, rowIndex: existing.row, columnIndex: 0 }, rows: [{ values }], fields: 'userEnteredValue' } }]
  return [{ appendCells: { sheetId: metaSheetId, rows: [{ values }], fields: 'userEnteredValue' } }]
}

// --- resolution --------------------------------------------------------------

/**
 * Which spreadsheet is the tracker. Explicit configuration wins; then the id
 * resolved earlier; then an EXACT name match in Drive — used only if there is
 * exactly one. Zero or several is a configuration problem, never a guess.
 */
export async function resolveTracker({ google, configuredId, storedId, name }) {
  if (configuredId) {
    const f = await google.getFile(configuredId)
    if (f.trashed) return { ok: false, category: 'TRACKER_TRASHED', message: 'The configured tracker is in the trash.' }
    return { ok: true, id: configuredId, source: 'configured', name: f.name }
  }
  if (storedId) return { ok: true, id: storedId, source: 'resolved-earlier' }
  const files = await google.findSpreadsheetsByName(name)
  if (files.length === 1) return { ok: true, id: files[0].id, source: 'drive-exact-name', name: files[0].name, persist: true }
  if (files.length === 0) return { ok: false, category: 'TRACKER_NOT_FOUND', message: `No spreadsheet named exactly "${name}". Set JOBS_TRACKER_SPREADSHEET_ID.` }
  return { ok: false, category: 'TRACKER_AMBIGUOUS', message: `${files.length} spreadsheets are named "${name}". Set JOBS_TRACKER_SPREADSHEET_ID to the right one.` }
}

/** Drive file id of the tailored CV for a record, preferring the DOCX/Doc, then PDF. */
export function tailoredFileIds(rec) {
  return { docId: driveIdFromUrl(rec.cvDocx), pdfId: driveIdFromUrl(rec.cvPdf), folderId: driveIdFromUrl(rec.outputFolder) }
}
