/**
 * Application automation safety: dry-run never submits, live needs explicit
 * configuration and a complete profile, every unresolved question stops the
 * application, and APPLIED needs positive evidence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplier, validateApplicationUrl } from '../bridge/jobs/apply/applier.mjs'
import { answer, planAnswers } from '../bridge/jobs/apply/questions.mjs'
import { blockers, evidence } from '../bridge/jobs/apply/verify.mjs'
import { auditProfile, loadProfile, normalizeProfile } from '../bridge/jobs/profile.mjs'
import { createStore } from '../bridge/jobs/store.mjs'
import { jobsConfig } from '../bridge/jobs/config.mjs'
import { fakeGoogle } from './jobs-fakes.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-apply-'))
const PROFILE = normalizeProfile({
  fields: { firstName: 'Test', lastName: 'Person', email: 'test@example.invalid', phone: '+44 0000 000000', city: 'London', rightToWorkUK: 'Yes', requiresSponsorship: 'No', linkedinUrl: 'https://linkedin.com/in/test' },
  declarations: { privacyConsent: true },
})

const FORM = [
  { id: '0:0', label: 'First Name *', type: 'text', required: true },
  { id: '0:1', label: 'Last Name *', type: 'text', required: true },
  { id: '0:2', label: 'Email *', type: 'email', required: true },
  { id: '0:3', label: 'Phone', type: 'tel', required: false },
  { id: '0:4', label: 'Resume/CV *', type: 'file', required: true },
  { id: '0:5', label: 'LinkedIn Profile', type: 'text', required: false },
  { id: '0:6', label: 'Are you legally authorised to work in the UK?', type: 'select', required: true, options: ['Yes', 'No'] },
  { id: '0:7', label: 'Will you now or in the future require visa sponsorship?', type: 'select', required: true, options: ['Yes', 'No'] },
  { id: '0:8', label: 'Gender', type: 'select', required: false, options: ['Male', 'Female', 'Prefer not to say'] },
]

/** A scripted page: before/after submit. */
function fakeDriver({ page = {}, fields = FORM, after = { text: 'Thank you for applying! Your application has been received. Reference number: GH-12345' }, onOpen } = {}) {
  const log = { opened: [], filled: [], uploads: [], submits: 0, closed: 0 }
  return {
    log,
    async open(url) {
      log.opened.push(url)
      onOpen?.(url)
      let submitted = false
      return {
        snapshot: async () => (submitted ? { url: `${url}/confirmation`, title: 'Application submitted', ...after } : { url, title: 'Apply', text: 'Apply for this job', ...page }),
        fields: async () => fields,
        fill: async (id, v) => log.filled.push([id, v]),
        choose: async (id, o) => log.filled.push([id, o]),
        check: async (id) => log.filled.push([id, true]),
        upload: async (id, p) => log.uploads.push([id, p]),
        submit: async () => {
          log.submits++
          submitted = true
        },
        close: async () => log.closed++,
      }
    },
  }
}

const tailoredJob = (over = {}) => ({
  id: 'jb_test1',
  title: 'Graduate Software Engineer',
  company: 'Acme AI',
  source: 'greenhouse:acme',
  status: 'TAILORED',
  applicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/9001',
  canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/9001',
  tailoredCvUrl: 'https://docs.google.com/document/d/1TailoredDocId_abcdef/edit',
  tailoredPdfUrl: 'https://drive.google.com/file/d/1TailoredPdfId_abcdef/view',
  rankScore: 100,
  ...over,
})

function setup({ mode = 'dry-run', driver = fakeDriver(), profile = PROFILE, google = fakeGoogle(), job = tailoredJob() } = {}) {
  const dir = tmp()
  const store = createStore(join(dir, 'state.json'))
  store.upsertJob(job)
  const cfg = { ...jobsConfig({}), applicationMode: mode, maxApplicationsPerDay: 3, trackerWrites: false }
  const applier = createApplier({ cfg, store, google, profile, driver, cvDir: join(dir, 'cv'), now: () => new Date('2026-09-21T12:00:00Z') })
  return { applier, store, driver, run: () => applier.processQueue({ parsed: null, byId: new Map() }) }
}

// --- modes --------------------------------------------------------------------

test('51. live mode is never the default and needs explicit configuration', () => {
  assert.equal(jobsConfig({}).applicationMode, 'dry-run')
  assert.equal(jobsConfig({ JOBS_APPLICATION_MODE: 'LIVE!' }).applicationMode, 'dry-run')
  assert.equal(jobsConfig({ JOBS_APPLICATION_MODE: 'live' }).applicationMode, 'live')
})

test('50. dry-run inspects the real form but never types, uploads or submits', async () => {
  const { run, store, driver } = setup()
  const r = await run()
  assert.equal(driver.log.opened.length, 1)
  assert.equal(driver.log.submits, 0)
  assert.deepEqual(driver.log.filled, [])
  assert.deepEqual(driver.log.uploads, [])
  assert.equal(r.submitted, 0)
  const j = store.job('jb_test1')
  assert.equal(j.status, 'TAILORED')
  assert.ok(j.dryRunInspectedAt)
  assert.ok(j.dryRunPlan.answered >= 7)
  await run()
  assert.equal(driver.log.opened.length, 1, 'an inspected job is not re-inspected every pass')
})

test('live mode with an incomplete profile applies to nothing', async () => {
  const { run, driver } = setup({ mode: 'live', profile: normalizeProfile({ fields: { firstName: 'Test' } }) })
  const r = await run()
  assert.deepEqual(r.errorCategories, ['PROFILE_INCOMPLETE'])
  assert.equal(driver.log.opened.length, 0)
})

test('49. verified success produces APPLIED with a small evidence record', async () => {
  const { run, store, driver } = setup({ mode: 'live' })
  const r = await run()
  assert.equal(r.submitted, 1)
  const j = store.job('jb_test1')
  assert.equal(j.status, 'APPLIED')
  assert.equal(j.submissionEvidence.verified, true)
  assert.equal(j.submissionEvidence.kind, 'confirmation-number')
  assert.equal(j.submissionEvidence.confirmationId, 'GH-12345')
  assert.ok(!JSON.stringify(j.submissionEvidence).includes('Test Person'))
  assert.equal(driver.log.uploads.length, 1)
  assert.ok(driver.log.filled.some(([id, v]) => id === '0:6' && v === 'Yes'))
  assert.ok(driver.log.filled.some(([id, v]) => id === '0:7' && v === 'No'))
  assert.ok(!driver.log.filled.some(([id]) => id === '0:8'), 'optional demographic question left blank')
  assert.equal(store.day(new Date('2026-09-21T12:00:00Z')).submitted, 1)
})

test('48. a submit click without confirmation is NOT applied', async () => {
  for (const after of [{ text: 'Apply for this job' }, { text: '' }, { text: 'Thank you for applying', formStillPresent: true }, { text: 'Thank you for applying. There were errors: this field is required.' }]) {
    const { run, store } = setup({ mode: 'live', driver: fakeDriver({ after }) })
    const r = await run()
    assert.equal(r.submitted, 0, JSON.stringify(after))
    assert.notEqual(store.job('jb_test1').status, 'APPLIED')
    assert.equal(store.job('jb_test1').status, 'APPLICATION_FAILED')
  }
})

// --- NEEDS_INPUT ------------------------------------------------------------

test('43. a CAPTCHA stops the application', async () => {
  const { run, store, driver } = setup({ mode: 'live', driver: fakeDriver({ page: { captchaFrames: 1 } }) })
  await run()
  const j = store.job('jb_test1')
  assert.equal(j.status, 'NEEDS_INPUT')
  assert.match(j.needsInput.reason, /CAPTCHA/)
  assert.equal(j.resumeState, 'APPLYING')
  assert.equal(driver.log.submits, 0)
})

test('44. a two-factor prompt or login stops the application', async () => {
  for (const page of [{ text: 'Enter the code we sent to your email' }, { hasPasswordField: true, text: 'Sign in to apply' }]) {
    const { run, store, driver } = setup({ mode: 'live', driver: fakeDriver({ page }) })
    await run()
    assert.equal(store.job('jb_test1').status, 'NEEDS_INPUT')
    assert.equal(driver.log.submits, 0)
  }
})

test('45. an unknown mandatory question stops the application with the question captured', async () => {
  const fields = [...FORM, { id: '0:9', label: 'Describe a time you disagreed with a colleague *', type: 'textarea', required: true }]
  const { run, store, driver } = setup({ mode: 'live', driver: fakeDriver({ fields }) })
  await run()
  const j = store.job('jb_test1')
  assert.equal(j.status, 'NEEDS_INPUT')
  assert.match(j.needsInput.question, /disagreed with a colleague/)
  assert.equal(driver.log.submits, 0)
})

test('46. sensitive questions are never guessed', () => {
  const ask = (label, extra = {}) => answer({ label, type: 'select', required: true, options: ['Yes', 'No', 'Prefer not to say'], ...extra }, PROFILE)
  assert.equal(ask('Do you have any unspent criminal convictions?').action, 'needs-input')
  assert.equal(ask('Do you have a disability?').action, 'needs-input')
  assert.equal(ask('Do you hold active security clearance?').action, 'needs-input')
  assert.equal(ask('What is your ethnicity?').action, 'needs-input')
  assert.equal(ask('Gender', { required: false }).action, 'skip')
  // Only an explicit policy or answer changes that.
  const declines = normalizeProfile({ fields: PROFILE.fields, demographics: { policy: 'decline' } })
  assert.deepEqual(answer({ label: 'Gender', type: 'select', required: true, options: ['Male', 'Female', 'Prefer not to say'] }, declines), { action: 'choose', option: 'Prefer not to say' })
  assert.equal(answer({ label: 'Criminal record?', type: 'select', required: true, options: ['No'] }, declines).action, 'needs-input')
  // Unconfigured sponsorship / salary are never invented.
  const bare = normalizeProfile({ fields: { firstName: 'T' } })
  assert.equal(answer({ label: 'Do you require sponsorship?', type: 'select', required: true, options: ['Yes', 'No'] }, bare).action, 'needs-input')
  assert.equal(answer({ label: 'Salary expectations', type: 'text', required: true }, PROFILE).action, 'needs-input')
})

test('47. no tailored CV, no application', async () => {
  for (const job of [tailoredJob({ tailoredCvUrl: '', tailoredPdfUrl: '' })]) {
    const { run, store, driver } = setup({ mode: 'live', job })
    await run()
    assert.equal(store.job('jb_test1').status, 'NEEDS_INPUT')
    assert.match(store.job('jb_test1').needsInput.reason, /no tailored CV/)
    assert.equal(driver.log.opened.length, 0)
  }
  const { run, store } = setup({ mode: 'live', google: null })
  await run()
  assert.match(store.job('jb_test1').needsInput.reason, /cannot be fetched/)
})

test('the daily limit caps applications', async () => {
  const { applier, store, driver } = setup({ mode: 'live' })
  for (let i = 2; i <= 6; i++) store.upsertJob(tailoredJob({ id: `jb_test${i}` }))
  await applier.processQueue({ parsed: null, byId: new Map() })
  assert.equal(driver.log.submits, 3)
  await applier.processQueue({ parsed: null, byId: new Map() })
  assert.equal(driver.log.submits, 3, 'no more today')
})

test('end to end: discovered -> queued -> tailored by the workflow -> applied with evidence -> tracker updated', async () => {
  const { runSearch, runWatch } = await import('../bridge/jobs/pipeline.mjs')
  const { COL, fakeHttp, fakeSource, posting } = await import('./jobs-fakes.mjs')
  const google = fakeGoogle()
  const dir = tmp()
  const store = createStore(join(dir, 'state.json'))
  const cfg = { ...jobsConfig({}), trackerWrites: true, applicationMode: 'live' }
  const driver = fakeDriver()
  const ctx = { cfg, store, google, trackerId: 'SHEET_ID_123456', http: fakeHttp(), sources: [fakeSource([posting({ applicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/9001' })])], now: () => new Date('2026-09-21T12:00:00Z') }
  await runSearch(ctx)
  const row = google.fixture.tabs[0].rows[8]
  row[COL['Tailor Queue']].formattedValue = '✅ Tailored'
  row[COL['CV PDF']] = { userEnteredValue: { formulaValue: '=HYPERLINK("https://drive.google.com/file/d/1TailoredPdfId_abcdef/view","PDF")' }, formattedValue: 'PDF' }
  ctx.applier = createApplier({ ...ctx, profile: PROFILE, driver, cvDir: join(dir, 'cv') })
  const r = await runWatch(ctx)
  assert.equal(r.run.tailoredObserved, 1)
  assert.equal(r.run.applicationsSubmitted, 1)
  const job = store.jobs()[0]
  assert.equal(job.status, 'APPLIED')
  assert.deepEqual(job.history.map((h) => h.to), ['QUALIFIED', 'READY_TO_TAILOR', 'TAILORED', 'APPLYING', 'APPLIED'])
  assert.equal(google.fixture.tabs[0].rows[8][COL['Application Status']].userEnteredValue.stringValue, '✅ Applied')
  assert.match(google.fixture.tabs[0].rows[8][COL['Automation Notes']].userEnteredValue.stringValue, /Applied automatically; evidence: confirmation-number/)
  const meta = google.fixture.tabs.find((t) => t.properties.title === 'JARVIS_META')
  assert.equal(meta.rows[1][1].userEnteredValue.stringValue, 'APPLIED')
})

// --- URL validation -----------------------------------------------------------

test('55/57. the browser opens only validated job URLs', () => {
  const job = { source: 'greenhouse:acme', canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/1' }
  assert.equal(validateApplicationUrl('https://job-boards.greenhouse.io/acme/jobs/1', job).ok, true)
  assert.equal(validateApplicationUrl('https://jobs.ashbyhq.com/relay/abc/application', job).ok, true)
  for (const bad of ['http://job-boards.greenhouse.io/acme/jobs/1', 'javascript:alert(1)', 'file:///C:/Windows/System32/cmd.exe', 'https://user:pw@jobs.lever.co/x', 'https://some-aggregator.example/job/1', 'https://jobs.lever.co/x" --remote-debugging-port=9222', '--disable-web-security', 'https://evil.greenhouse.io.example.com/x']) {
    assert.equal(validateApplicationUrl(bad, job).ok, false, bad)
  }
  const careers = { source: 'careers:example.com' }
  assert.equal(validateApplicationUrl('https://careers.example.com/jobs/1', careers).ok, true)
  const embedded = { source: 'greenhouse:helsing', canonicalUrl: 'https://helsing.ai/jobs/1?gh_jid=1' }
  assert.equal(validateApplicationUrl('https://helsing.ai/jobs/1?gh_jid=1', embedded).ok, true)
})

test('a URL refused by validation stops the job before any browser opens', async () => {
  const { run, store, driver } = setup({ mode: 'live', job: tailoredJob({ applicationUrl: 'https://some-aggregator.example/job/1' }) })
  await run()
  assert.equal(store.job('jb_test1').status, 'NEEDS_INPUT')
  assert.equal(driver.log.opened.length, 0)
})

// --- verification and audit -------------------------------------------------------

test('evidence and blockers are read from the page, not inferred', () => {
  assert.equal(evidence({ text: 'Your application has been submitted successfully.' }).verified, true)
  assert.equal(evidence({ text: '' }).verified, false)
  assert.equal(evidence({ url: 'https://x/thank-you', text: 'Loading…' }).verified, false, 'a thank-you URL alone proves nothing')
  assert.deepEqual(blockers({ text: 'This job is no longer accepting applications' }).map((b) => b.kind), ['closed'])
})

test('the profile audit lists names, never values, and gates live mode', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'p.json'), JSON.stringify({ fields: { firstName: 'Secret-Name', email: 'secret@example.invalid', rightToWorkUK: 'maybe' } }))
  const a = auditProfile(loadProfile(dir, 'p.json'), { applicationMode: 'live' })
  const text = JSON.stringify(a)
  assert.ok(!text.includes('Secret-Name') && !text.includes('secret@example.invalid'))
  assert.equal(a.liveModeAllowed, false)
  assert.ok(a.unresolvedRequiredForLive.includes('rightToWorkUK'), 'an answer that is not an explicit Yes/No does not count')
  assert.ok(a.neverAutoAnswered.length >= 3)
  assert.equal(auditProfile(PROFILE).liveModeAllowed, true)
  const missing = auditProfile(loadProfile(dir, 'nope.json'))
  assert.equal(missing.liveModeAllowed, false)
})

test('planAnswers answers the standard form entirely from the profile', () => {
  const { unresolved, uploads, plan } = planAnswers(FORM, PROFILE)
  assert.equal(unresolved.length, 0)
  assert.equal(uploads.length, 1)
  assert.deepEqual(plan.find((p) => p.field.id === '0:0'), { field: FORM[0], action: 'fill', value: 'Test' })
})
