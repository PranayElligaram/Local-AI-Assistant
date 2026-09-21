/**
 * The job agent as JARVIS sees it: lifecycle, pause/resume, batched
 * notifications, voice intents, diagnostics that leak nothing, and the
 * architecture boundary (no ChatGPT UI automation, no new shell surface).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createJobAgent } from '../bridge/jobs/agent.mjs'
import { jobsConfig } from '../bridge/jobs/config.mjs'
import { route } from '../bridge/router.mjs'
import { createTools } from '../bridge/tools.mjs'
import { fakeGoogle, fakeSource, posting } from './jobs-fakes.mjs'

const ROOT = join(import.meta.dirname, '..')
const NOW = new Date('2026-09-21T12:00:00Z')
const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-agent-'))

function agent(over = {}, deps = {}) {
  const runDir = tmp()
  const notes = []
  const cfg = { ...jobsConfig({}), enabled: true, trackerWrites: true, googleClientId: 'CLIENT-ID-abc.apps.googleusercontent.com', googleClientSecret: 'GOCSPX-TOP-SECRET', trackerSpreadsheetId: 'SHEET_ID_123456', ...over }
  const a = createJobAgent({
    cfg,
    root: ROOT,
    runDir,
    now: () => NOW,
    log: () => {},
    google: fakeGoogle(),
    loadSources: () => [fakeSource([posting()])],
    notify: (t) => notes.push(t),
    fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => '0' }, text: async () => '{}' }),
    ...deps,
  })
  return { a, notes, runDir }
}

test('start() only arms timers; nothing runs during JARVIS start-up', () => {
  const { a } = agent()
  assert.equal(a.start(), true)
  const d = a.diagnostics()
  assert.equal(d.runInProgress, false)
  assert.ok(d.nextRunAt)
  a.stop()
  const off = agent({ enabled: false }).a
  assert.equal(off.start(), false)
})

test('a search run adds and queues a role, then notifies once with batched counts', async () => {
  const { a, notes } = agent()
  const r = await a.search()
  assert.equal(r.run.inserted, 1)
  assert.equal(notes.length, 1)
  assert.equal(notes[0], 'Job search update. I found one new role. One matched your criteria.')
  assert.equal(a.diagnostics().tailoringQueueCount, 1)
  await a.search()
  assert.equal(notes.length, 1, 'nothing new: no second notification')
})

test('59. only verified APPLIED jobs count as submitted', async () => {
  const { a } = agent()
  a.store.upsertJob({ id: 'jb_a', title: 'A', company: 'X', status: 'APPLIED', appliedAt: NOW.toISOString(), submissionEvidence: { verified: true, kind: 'thank-you-page' } })
  a.store.upsertJob({ id: 'jb_b', title: 'B', company: 'Y', status: 'APPLYING' })
  a.store.upsertJob({ id: 'jb_c', title: 'C', company: 'Z', status: 'APPLIED', submissionEvidence: { verified: false } })
  assert.match(a.appliedCountText(), /submitted 1 application with verified confirmation/)
  assert.match(a.appliedTodayText(), /A at X/)
})

test('60. needs-input answers name the role and the reason', () => {
  const { a } = agent()
  a.store.upsertJob({ id: 'jb_n', title: 'Graduate AI Engineer', company: 'Acme', status: 'NEEDS_INPUT', needsInput: { reason: 'CAPTCHA on the application form' } })
  assert.match(a.needsInputText(), /1 role needs you: Graduate AI Engineer at Acme, CAPTCHA on the application form/)
  assert.equal(a.diagnostics().needsInput, 1)
})

test('pause keeps the queue, blocks runs, and resume carries on', async () => {
  const { a } = agent()
  await a.search()
  a.start()
  a.pause()
  assert.equal(a.diagnostics().paused, true)
  assert.equal(a.diagnostics().nextRunAt, null)
  assert.equal(a.diagnostics().tailoringQueueCount, 1, 'queue kept')
  assert.deepEqual(await a.runNow(), { skipped: 'paused' })
  a.resume()
  assert.equal(a.diagnostics().paused, false)
  assert.ok(a.diagnostics().nextRunAt)
  a.stop()
})

test('52-53. diagnostics carry no tokens, client secrets, profile or contact values, CV or JD text', async () => {
  const { a } = agent()
  await a.search()
  const text = JSON.stringify(a.diagnostics())
  for (const secret of ['GOCSPX-TOP-SECRET', 'CLIENT-ID-abc', 'refresh_token', 'access_token', 'Django REST APIs', '@', 'docs.google.com']) {
    assert.ok(!text.includes(secret), `diagnostics leak: ${secret}`)
  }
})

test('the morning line is short, and absent when there is nothing to say', async () => {
  const quiet = agent().a
  assert.equal(quiet.morningText(), '')
  const { a } = agent()
  await a.search()
  assert.match(a.morningText(), /^Your job agent found one new matching role and has one CV waiting for tailoring since the last update\.$/)
})

// --- voice ------------------------------------------------------------------

test('job phrases route to read-only job tools, and pause/resume', () => {
  const cases = {
    'How is the job search going?': 'job_status',
    'Jarvis, how many jobs have you applied to?': 'job_applied_count',
    'What jobs did you apply for today?': 'job_applied_today',
    'Which applications need me?': 'job_needs_input',
    "Show me today's jobs.": 'job_today',
    'Pause job searching.': 'job_pause',
    'Resume job searching.': 'job_resume',
  }
  for (const [said, tool] of Object.entries(cases)) assert.equal(route(said)?.tool, tool, said)
  // Existing routines are unaffected.
  assert.equal(route('Good morning')?.tool, 'good_morning')
  assert.equal(route('Stop Jarvis')?.tool, 'stop_jarvis')
  assert.equal(route('open Spotify')?.tool, 'open_application')
})

test('job tools answer from the agent, are router-only, and nothing withdraws', async () => {
  const { a } = agent()
  const tools = createTools({ catalogue: { resolve: async () => ({ status: 'not_found' }) }, jobs: a, now: () => NOW })
  assert.equal((await tools.execute('job_status', {}, { origin: 'model' })).rejected, true)
  const r = await tools.execute('job_status', {}, { origin: 'router' })
  assert.equal(r.ok, true)
  assert.match(r.say, /Automatic applications are in dry-run mode/)
  assert.ok(!tools.names().some((n) => /withdraw/.test(n)))
  const gm = await tools.execute('good_morning', {}, { origin: 'router' })
  assert.match(gm.say, /^Good morning\./)
})

// --- architecture boundary ----------------------------------------------------

function sources(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(mjs|js|ts|tsx|ps1)$/.test(e)) out.push(p)
  }
  return out
}
const code = () => ['bridge', 'scripts', 'src'].flatMap((d) => sources(join(ROOT, d)))

test('42. nothing automates ChatGPT, reuses its session, or runs Codex for tailoring', () => {
  for (const f of code()) {
    const c = readFileSync(f, 'utf8')
    assert.ok(!/chatgpt\.com|chat\.openai\.com|api\.openai\.com|__Secure-next-auth|\bcodex\b/i.test(c), `${relative(ROOT, f)} references ChatGPT/Codex`)
  }
})

test('54/56. the job agent adds no shell: only two fixed PowerShell scripts, shell:false, data via stdin/env', () => {
  const jobs = sources(join(ROOT, 'bridge', 'jobs'))
  const spawners = jobs.filter((f) => /\bspawn\(|execFile|execSync|child_process/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(spawners.map((f) => relative(join(ROOT, 'bridge', 'jobs'), f).replace(/\\/g, '/')).sort(), ['google/dpapi.mjs', 'toast.mjs'])
  for (const f of spawners) {
    const c = readFileSync(f, 'utf8')
    assert.ok(/shell: false/.test(c), `${f} must not use a shell`)
    assert.ok(!/\bexec\(|eval\(|new Function/.test(c))
  }
  for (const f of jobs) assert.ok(!/\beval\(|new Function\(/.test(readFileSync(f, 'utf8')), `${f} evaluates code`)
})
