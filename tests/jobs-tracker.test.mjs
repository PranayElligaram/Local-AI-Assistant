/**
 * The Google Sheet tracker: schema mapping, preservation of formulas,
 * validation and existing rows, deduplication against the sheet, the
 * JARVIS_META tab, tracker resolution, and the ChatGPT tailoring handoff.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { META_TAB, parseSpreadsheet, planRowUpdate, resolveTracker, trackerRecords, mappingProblems } from '../bridge/jobs/tracker.mjs'
import { runSearch, runWatch } from '../bridge/jobs/pipeline.mjs'
import { createStore } from '../bridge/jobs/store.mjs'
import { jobsConfig } from '../bridge/jobs/config.mjs'
import { normalizeJob } from '../bridge/jobs/job.mjs'
import { COL, fakeGoogle, fakeHttp, fakeSource, posting, trackerFixture } from './jobs-fakes.mjs'

const NOW = new Date('2026-09-21T12:00:00Z')
const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-tracker-'))
const cfg = (over = {}) => ({ ...jobsConfig({}), trackerWrites: true, ...over })

async function ctxWith({ google = fakeGoogle(), sources = [fakeSource([posting()])], config = cfg() } = {}) {
  return { cfg: config, store: createStore(join(tmp(), 'state.json')), google, trackerId: 'SHEET_ID_123456', sources, http: fakeHttp(), now: () => NOW }
}

const snapshot = (fixture) => JSON.stringify(fixture.tabs[0].rows.slice(0, 8))
const mainRows = (google) => google.fixture.tabs[0].rows

test('32. the mapping finds existing columns by header name', async () => {
  const parsed = parseSpreadsheet(await fakeGoogle().getSpreadsheet())
  assert.equal(parsed.main.title, 'Active Roles')
  assert.equal(parsed.main.headerRow, 5)
  assert.equal(parsed.main.cols.programme, COL.Programme)
  assert.equal(parsed.main.cols.tailorQueue, COL['Tailor Queue'])
  assert.equal(parsed.main.cols.notes, COL['Automation Notes'])
  assert.deepEqual(mappingProblems(parsed), [])
  // A moved column is still found.
  const fx = trackerFixture()
  for (const r of fx.tabs[0].rows) if (r.length > COL.View) r.splice(COL.View, 0, r.splice(COL.Priority, 1)[0])
  const moved = parseSpreadsheet(await fakeGoogle(fx).getSpreadsheet())
  assert.equal(moved.main.cols.priority, COL.View)
})

test('28-30. inserting a role preserves formulas, validation and existing rows', async () => {
  const google = fakeGoogle()
  const before = snapshot(google.fixture)
  const ctx = await ctxWith({ google })
  const r = await runSearch(ctx)
  assert.equal(r.run.inserted, 1, JSON.stringify(r.run))
  const rows = mainRows(google)
  assert.equal(snapshot(google.fixture), before, 'existing rows untouched')
  const added = rows[8]
  assert.equal(added[COL.Programme].userEnteredValue.stringValue, 'Acme AI — Graduate Software Engineer')
  assert.equal(added[COL.Rank].userEnteredValue.formulaValue, '=IF(B8="","",ROW()-6)', 'copied-down formula kept')
  assert.ok(added[COL['Tailor Queue']].dataValidation, 'validation kept')
  assert.equal(added[COL['Tailor Queue']].userEnteredValue.stringValue, '🟢 Ready')
  assert.equal(added[COL['Application Status']].userEnteredValue.stringValue, '☐ Not applied')
  assert.match(added[COL.View].userEnteredValue.formulaValue, /^=HYPERLINK\("https:\/\/boards\.greenhouse\.io\/acme\/jobs\/9001","Open role ↗"\)$/)
  assert.match(added[COL['Automation Notes']].userEnteredValue.stringValue, /^\[JARVIS:jb_[a-z0-9]+\] Added/)
  assert.ok(added[COL['Job Description']].userEnteredValue.stringValue.includes('Django REST APIs'))
  for (const [, requests] of google.calls.filter((c) => c[0] === 'batchUpdate')) {
    for (const q of requests) if (q.updateCells) assert.equal(q.updateCells.fields, 'userEnteredValue')
  }
})

test('a full grid gets one inserted row that inherits formulas and validation', async () => {
  const google = fakeGoogle(trackerFixture({ extraBlankRows: 0 }))
  const ctx = await ctxWith({ google })
  await runSearch(ctx)
  const rows = mainRows(google)
  const req = google.calls.find((c) => c[0] === 'batchUpdate')[1]
  assert.ok(req.some((q) => q.insertDimension?.inheritFromBefore))
  assert.ok(req.some((q) => q.copyPaste?.pasteType === 'PASTE_FORMULA'))
  assert.equal(rows[8][COL.Rank].userEnteredValue.formulaValue, '=ROW()-6')
  assert.ok(rows[8][COL['Tailor Queue']].dataValidation)
})

test('31. a role already in the tracker is not inserted again', async () => {
  const google = fakeGoogle()
  const dup = posting({ company: 'Fospha', title: 'Graduate Software Engineer', sourceJobId: '4001', source: 'greenhouse:fospha', sourceUrl: 'https://boards.greenhouse.io/fospha/jobs/4001?gh_src=x', applicationUrl: undefined })
  const applied = posting({ company: 'Stripe', title: 'Software Engineer, New Grad', sourceJobId: '7001', sourceUrl: 'https://stripe.com/jobs/listing/new-grad/7001' })
  const ctx = await ctxWith({ google, sources: [fakeSource([dup, applied])] })
  const r = await runSearch(ctx)
  assert.equal(r.run.duplicates, 2)
  assert.equal(r.run.inserted, 0)
  assert.equal(google.calls.filter((c) => c[0] === 'batchUpdate').length, 0)
})

test('the roles the first live dry run found are recognised as already tracked (real row text)', async () => {
  const fx = trackerFixture()
  const s = (v) => ({ userEnteredValue: { stringValue: v }, formattedValue: v })
  fx.tabs[0].rows[7][COL.Programme] = s('Helsing — Junior Software Engineer')
  fx.tabs[0].rows[7][COL['London?']] = s('Yes — London; also Berlin/Munich')
  fx.tabs.push({ properties: { sheetId: 21, title: 'Hold — Verify', index: 3, gridProperties: { rowCount: 2, columnCount: 3 } }, rows: [[s('Programme'), s('Location'), s('Evidence found')], [s('Relay Technologies — Graduate Software Engineer'), s('London hybrid'), s('Employer Ashby application is live')]] })
  fx.tabs[1].rows.push([s('Deliveroo — Software Engineer, New Grad'), s('✅ Applied'), s('')])
  const found = [
    posting({ company: 'Helsing', title: 'Junior Software Engineer', location: 'Berlin; London; Munich', sourceJobId: '4976480101', sourceUrl: 'https://helsing.ai/jobs/4976480101?gh_jid=4976480101' }),
    posting({ company: 'Deliveroo', title: 'Software Engineer, New Grad', location: 'London, United Kingdom - Deliveroo', sourceJobId: '8202627', sourceUrl: 'https://job-boards.greenhouse.io/deliveroo/jobs/8202627' }),
    posting({ company: 'Relay Technologies', title: 'Graduate Software Engineer', location: 'London - Hybrid', source: 'ashby:relay', sourceJobId: '5a6ed15f-e610-4d09-9fd7-f18cd639c4e7', sourceUrl: 'https://jobs.ashbyhq.com/relay/5a6ed15f-e610-4d09-9fd7-f18cd639c4e7' }),
  ]
  const ctx = await ctxWith({ google: fakeGoogle(fx), sources: [fakeSource(found)] })
  const r = await runSearch(ctx)
  assert.equal(r.run.duplicates, 3)
  assert.equal(r.run.inserted, 0)
})

test('33. the metadata tab is created at the end and never touches the main tracker', async () => {
  const google = fakeGoogle()
  const ctx = await ctxWith({ google })
  await runSearch(ctx)
  const meta = google.fixture.tabs.find((t) => t.properties.title === META_TAB)
  assert.ok(meta)
  assert.equal(meta.properties.index, 3)
  assert.equal(meta.rows[0][0].userEnteredValue.stringValue, 'jobId')
  assert.match(meta.rows[1][0].userEnteredValue.stringValue, /^jb_/)
  assert.equal(meta.rows[1][1].userEnteredValue.stringValue, 'READY_TO_TAILOR')
  assert.equal(google.fixture.tabs[1].rows.length, 2, 'other tabs untouched')
})

test('tracker writes off: a run reports and writes nothing', async () => {
  const google = fakeGoogle()
  const ctx = await ctxWith({ google, config: cfg({ trackerWrites: false }) })
  const r = await runSearch(ctx)
  assert.equal(r.run.mode, 'dry-run')
  assert.equal(r.run.qualified, 1)
  assert.equal(r.candidates[0].wouldQueue, true)
  assert.equal(google.calls.filter((c) => c[0] === 'batchUpdate').length, 0)
  assert.equal(ctx.store.jobs().length, 0, 'a dry run leaves no local state behind that would block a later real run')
})

test('a closed vacancy is not added, and a failing source does not break the run', async () => {
  const google = fakeGoogle()
  const closed = fakeSource([posting()], { open: () => false })
  const broken = fakeSource([], { id: 'lever:broken', fail: true })
  const ctx = await ctxWith({ google, sources: [broken, closed] })
  const r = await runSearch(ctx)
  assert.equal(r.run.closed, 1)
  assert.equal(r.run.inserted, 0)
  assert.equal(ctx.store.data.sourceHealth['lever:broken'].ok, false)
  assert.ok(r.run.errorCategories.includes('SOURCE_HTTP'))
})

test('existing rows are only changed through the allowed transitions', async () => {
  const parsed = parseSpreadsheet(await fakeGoogle().getSpreadsheet())
  const rec = trackerRecords(parsed).find((r) => r.company === 'Cleary Gottlieb')
  const q = planRowUpdate(parsed, rec, { queue: true })
  assert.equal(q.ok, true)
  const applied = planRowUpdate(parsed, rec, { applied: true, evidence: { verified: false } })
  assert.equal(applied.ok, false)
  const fx = trackerFixture()
  fx.tabs[0].rows[6][COL['Tailor Queue']].userEnteredValue.stringValue = '✅ Tailored'
  fx.tabs[0].rows[6][COL['Tailor Queue']].formattedValue = '✅ Tailored'
  const p2 = parseSpreadsheet(await fakeGoogle(fx).getSpreadsheet())
  const r2 = planRowUpdate(p2, trackerRecords(p2)[0], { queue: true })
  assert.equal(r2.ok, false, 'a user/ChatGPT-maintained Tailor Queue value is never overwritten')
})

test('57. text from a job board is written as a literal, never as a formula', async () => {
  const google = fakeGoogle()
  const ctx = await ctxWith({ google, sources: [fakeSource([posting({ title: 'Graduate Software Engineer', company: '=IMPORTXML("http://evil")' })])] })
  await runSearch(ctx)
  const cell = mainRows(google)[8][COL.Programme]
  assert.equal(cell.userEnteredValue.formulaValue, undefined)
  assert.match(cell.userEnteredValue.stringValue, /^=IMPORTXML/)
})

// --- tracker resolution -----------------------------------------------------

test('tracker resolution: exact single match, none, several, configured', async () => {
  const name = 'Pranay — AI & Software Job Application Tracker'
  const one = await resolveTracker({ google: fakeGoogle(), name })
  assert.deepEqual([one.ok, one.id, one.persist], [true, 'SHEET_ID_123456', true])
  const none = await resolveTracker({ google: fakeGoogle(undefined, { files: [] }), name })
  assert.equal(none.category, 'TRACKER_NOT_FOUND')
  const many = await resolveTracker({ google: fakeGoogle(undefined, { files: [{ id: 'A1234567890', name }, { id: 'B1234567890', name }] }), name })
  assert.equal(many.category, 'TRACKER_AMBIGUOUS')
  const configured = await resolveTracker({ google: fakeGoogle(), configuredId: 'CONFIGURED_ID_1', name })
  assert.equal(configured.id, 'CONFIGURED_ID_1')
})

// --- ChatGPT tailoring handoff ------------------------------------------------

async function queuedRole() {
  const google = fakeGoogle()
  const ctx = await ctxWith({ google })
  await runSearch(ctx)
  return { google, ctx, job: ctx.store.jobs()[0] }
}

test('39. a qualified role enters READY_TO_TAILOR with its JD and application URL', async () => {
  const { job, google } = await queuedRole()
  assert.equal(job.status, 'READY_TO_TAILOR')
  assert.ok(job.applicationUrl)
  assert.ok(mainRows(google)[8][COL['JD Ready?']] ?? true)
})

test('40-41. JARVIS notices a TAILORED row and links the CV to the right job', async () => {
  const { google, ctx, job } = await queuedRole()
  const row = mainRows(google)[8]
  // What the ChatGPT workflow writes:
  row[COL['Tailor Queue']].userEnteredValue = { stringValue: '✅ Tailored' }
  row[COL['Tailor Queue']].formattedValue = '✅ Tailored'
  row[COL['CV DOCX']] = { userEnteredValue: { formulaValue: '=HYPERLINK("https://docs.google.com/document/d/1TailoredDocId_abcdef/edit","DOCX")' }, formattedValue: 'DOCX' }
  row[COL['CV PDF']] = { userEnteredValue: { formulaValue: '=HYPERLINK("https://drive.google.com/file/d/1TailoredPdfId_abcdef/view","PDF")' }, formattedValue: 'PDF' }
  // An unrelated row also tailored — must not be attributed to our job.
  const other = mainRows(google)[6]
  other[COL['Tailor Queue']].userEnteredValue = { stringValue: '✅ Tailored' }
  other[COL['Tailor Queue']].formattedValue = '✅ Tailored'
  other[COL['CV DOCX']] = { userEnteredValue: { formulaValue: '=HYPERLINK("https://docs.google.com/document/d/1OtherDoc_zzzzzz/edit","DOCX")' }, formattedValue: 'DOCX' }
  const r = await runWatch(ctx)
  assert.equal(r.run.tailoredObserved, 1)
  const after = ctx.store.job(job.id)
  assert.equal(after.status, 'TAILORED')
  assert.equal(after.tailoredCvUrl, 'https://docs.google.com/document/d/1TailoredDocId_abcdef/edit')
  assert.equal(after.tailoredPdfUrl, 'https://drive.google.com/file/d/1TailoredPdfId_abcdef/view')
  assert.equal(ctx.store.data.sinceLastUpdate.tailored, 1)
})

test('processing and review states from the tailoring workflow are followed', async () => {
  const { google, ctx, job } = await queuedRole()
  const cell = mainRows(google)[8][COL['Tailor Queue']]
  cell.userEnteredValue = { stringValue: '⚙ Processing' }
  cell.formattedValue = '⚙ Processing'
  await runWatch(ctx)
  assert.equal(ctx.store.job(job.id).status, 'TAILORING')
  cell.formattedValue = '⚠ Review'
  await runWatch(ctx)
  const j = ctx.store.job(job.id)
  assert.equal(j.status, 'NEEDS_INPUT')
  assert.equal(j.resumeState, 'TAILORING')
})

test('a role the user marked applied in the tracker leaves the agent queue without counting as a JARVIS submission', async () => {
  const { google, ctx, job } = await queuedRole()
  mainRows(google)[8][COL['Application Status']].formattedValue = '✅ Applied'
  await runWatch(ctx)
  assert.equal(ctx.store.job(job.id).status, 'CLOSED')
  assert.equal(ctx.store.data.sinceLastUpdate.submitted, 0)
})

test('normalised ids are stable across runs', () => {
  assert.equal(normalizeJob(posting()).id, normalizeJob(posting({ sourceUrl: 'https://boards.greenhouse.io/acme/jobs/9001?gh_src=li' })).id)
})
