/**
 * Job agent foundations: deduplication, the state machine, the scheduler,
 * the local store and the batched summary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DedupeIndex, canonicalUrl, normalizeJob } from '../bridge/jobs/job.mjs'
import { canTransition, transition } from '../bridge/jobs/state.mjs'
import { createScheduler } from '../bridge/jobs/scheduler.mjs'
import { acquireLock, createStore } from '../bridge/jobs/store.mjs'
import { morningLine, summaryText } from '../bridge/jobs/notify.mjs'
import { withinActiveHours } from '../bridge/jobs/config.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-jobs-'))
const base = (over = {}) =>
  normalizeJob({
    title: 'Graduate Software Engineer',
    company: 'Monzo',
    location: 'London',
    source: 'greenhouse:monzo',
    sourceJobId: '555',
    sourceUrl: 'https://boards.greenhouse.io/monzo/jobs/555?gh_src=abc&utm_source=linkedin',
    description: 'x',
    ...over,
  })

// --- deduplication ----------------------------------------------------------

test('19. the same ATS id is a duplicate', () => {
  const idx = new DedupeIndex().add(base())
  const again = base({ sourceUrl: 'https://job-boards.greenhouse.io/monzo/jobs/555', title: 'Graduate Software Engineer (2026)' })
  assert.equal(idx.match(again)?.by, 'ats-id')
})

test('20. the same canonical URL is a duplicate despite tracking parameters', () => {
  const known = { company: 'X', title: 'Y', applicationUrl: 'https://jobs.lever.co/acme/1111?lever-source=LinkedIn', location: 'London' }
  const idx = new DedupeIndex().add(known, 'row-7')
  const r = idx.match({ company: 'Other', title: 'Other', applicationUrl: 'https://jobs.lever.co/acme/1111?utm_campaign=z#apply', location: 'Paris' })
  assert.deepEqual(r, { ref: 'row-7', by: 'url' })
  assert.equal(canonicalUrl('https://www.Example.com/job/1/?utm_source=a&id=2#x'), 'https://example.com/job/1?id=2')
})

test('21. same company/title/location is a duplicate despite a different URL', () => {
  const idx = new DedupeIndex().add({ company: 'Monzo Ltd', title: 'Graduate Software Engineer', location: 'London, UK', applicationUrl: 'https://monzo.com/careers/a' })
  const r = idx.match({ company: 'Monzo', title: 'Graduate Software Engineer - London', location: 'London', applicationUrl: 'https://aggregator.example/redirect?id=9' })
  assert.equal(r?.by, 'company-title-location')
})

test('22. genuinely separate roles are not collapsed', () => {
  const idx = new DedupeIndex().add(base())
  assert.equal(idx.match(base({ sourceJobId: '556', title: 'Graduate AI Engineer', sourceUrl: 'https://boards.greenhouse.io/monzo/jobs/556' })), null)
  assert.equal(idx.match(base({ sourceJobId: '557', company: 'Wise', sourceUrl: 'https://boards.greenhouse.io/wise/jobs/557' })), null)
})

test('employer-hosted Greenhouse URLs keep their job id (gh_jid is identity, not tracking)', () => {
  const a = base({ company: 'Wayve', title: 'ADAS Feature Engineer', sourceJobId: '1', sourceUrl: 'https://wayve.firststage.co/jobs?gh_jid=8578569002' })
  const b = base({ company: 'Wayve', title: 'Application Software Engineer', sourceJobId: '2', sourceUrl: 'https://wayve.firststage.co/jobs?gh_jid=8749219002' })
  assert.equal(new DedupeIndex().add(a).match(b), null)
})

test('roles sharing long company boilerplate are not collapsed by the description fingerprint', () => {
  const boiler = 'Our mission is to build embodied intelligence for every vehicle on every road. '.repeat(30)
  const a = base({ sourceJobId: '1', title: 'Graduate AI Engineer', sourceUrl: 'https://x.example/1', description: `${boiler} You will train perception models in Python.` })
  const b = base({ sourceJobId: '2', title: 'Data Platform Engineer', sourceUrl: 'https://x.example/2', description: `${boiler} You will run Kafka and Spark pipelines at scale.` })
  assert.equal(new DedupeIndex().add(a).match(b), null)
})

// --- state machine ----------------------------------------------------------

const walk = (job, ...steps) => steps.reduce((j, [to, meta]) => transition(j, to, meta), job)

test('23. the normal autonomous path is valid', () => {
  const j = walk(
    base(),
    ['QUALIFIED'],
    ['READY_TO_TAILOR'],
    ['TAILORING'],
    ['TAILORED', { cvUrl: 'https://docs.google.com/document/d/abc' }],
    ['APPLYING'],
    ['APPLIED', { evidence: { verified: true, kind: 'thank-you-page', detail: 'Thank you for applying' } }],
  )
  assert.equal(j.status, 'APPLIED')
  assert.equal(j.submissionEvidence.kind, 'thank-you-page')
  assert.deepEqual(j.history.map((h) => h.to), ['QUALIFIED', 'READY_TO_TAILOR', 'TAILORING', 'TAILORED', 'APPLYING', 'APPLIED'])
})

test('24. invalid transitions are rejected', () => {
  assert.throws(() => transition(base(), 'TAILORED'), /invalid transition/)
  assert.throws(() => transition({ ...base(), status: 'REJECTED' }, 'QUALIFIED'), /invalid transition/)
  assert.throws(() => transition(base(), 'WITHDRAWN'), /not something this agent does/)
  assert.equal(canTransition('CLOSED', 'APPLYING'), false)
})

test('25. APPLIED cannot be reached from DISCOVERED', () => {
  assert.throws(() => transition(base(), 'APPLIED', { evidence: { verified: true } }), /invalid transition/)
})

test('26. applying needs a TAILORED job with a CV', () => {
  const qualified = walk(base(), ['QUALIFIED'], ['READY_TO_TAILOR'])
  assert.throws(() => transition(qualified, 'APPLYING'), /invalid transition/)
  const tailoredNoCv = { ...qualified, status: 'TAILORED', tailoredCvUrl: '' }
  assert.throws(() => transition(tailoredNoCv, 'APPLYING'), /without a tailored CV/)
  const applying = transition({ ...tailoredNoCv, tailoredCvUrl: 'https://docs.google.com/document/d/x' }, 'APPLYING')
  assert.throws(() => transition(applying, 'APPLIED', { evidence: { verified: false } }), /verified submission evidence/)
})

test('27. NEEDS_INPUT remembers where the job was and returns there', () => {
  const tailored = walk(base(), ['QUALIFIED'], ['READY_TO_TAILOR'], ['TAILORED', { cvUrl: 'https://docs.google.com/document/d/x' }], ['APPLYING'])
  const paused = transition(tailored, 'NEEDS_INPUT', { reason: 'CAPTCHA', question: 'I am not a robot' })
  assert.equal(paused.resumeState, 'APPLYING')
  assert.equal(paused.tailoredCvUrl, 'https://docs.google.com/document/d/x')
  assert.throws(() => transition(paused, 'READY_TO_TAILOR'), /resumes to APPLYING/)
  const resumed = transition(paused, 'APPLYING')
  assert.equal(resumed.needsInput, null)
  assert.throws(() => transition(tailored, 'NEEDS_INPUT'), /requires a reason/)
})

// --- scheduler --------------------------------------------------------------

function fakeClock(start = Date.parse('2026-09-21T09:00:00Z')) {
  let t = start
  const timers = []
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, at: t + ms, cleared: false }
      timers.push(h)
      return h
    },
    clearTimer: (h) => h && (h.cleared = true),
    pending: () => timers.filter((h) => !h.cleared && !h.fired),
    async advance(ms) {
      t += ms
      for (const h of timers.filter((x) => !x.cleared && !x.fired && x.at <= t)) {
        h.fired = true
        await h.fn()
      }
      await new Promise((r) => setImmediate(r))
    },
  }
}

function durable(initial = {}) {
  const d = { next: null, last: null, paused: false, ...initial }
  return { d, clock: { get: () => d.next, set: (v) => (d.next = v), lastRun: (v) => (d.last = v), paused: () => d.paused } }
}

test('34. the first start schedules a run shortly after start-up, then every interval', async () => {
  const c = fakeClock()
  const { d, clock } = durable()
  let runs = 0
  const s = createScheduler({ name: 'search', intervalMs: 4 * 3600_000, startupDelayMs: 60_000, task: async () => ++runs, clock, ...c })
  s.start()
  assert.equal(runs, 0, 'start-up never runs synchronously')
  await c.advance(60_000)
  assert.equal(runs, 1)
  assert.equal(Date.parse(d.next), c.now() + 4 * 3600_000)
  await c.advance(4 * 3600_000)
  assert.equal(runs, 2)
  assert.equal(c.pending().length, 1, 'one timer, not a polling loop')
})

test('35. runs never overlap', async () => {
  const c = fakeClock()
  const { clock } = durable()
  let release
  let runs = 0
  const s = createScheduler({ name: 'search', intervalMs: 3600_000, task: () => (runs++, new Promise((r) => (release = r))), clock, ...c })
  s.start()
  const first = s.runNow()
  const second = await s.runNow()
  assert.deepEqual(second, { skipped: 'in-progress' })
  release('done')
  await first
  assert.equal(runs, 1)
})

test('36. a restart after missed runs performs exactly one catch-up', async () => {
  const c = fakeClock()
  const { clock } = durable({ next: new Date(c.now() - 3 * 24 * 3600_000).toISOString() })
  let runs = 0
  const s = createScheduler({ name: 'search', intervalMs: 4 * 3600_000, startupDelayMs: 90_000, task: async () => ++runs, clock, ...c })
  s.start()
  assert.equal(s.state.catchUps, 1)
  await c.advance(90_000)
  assert.equal(runs, 1)
  await c.advance(3600_000)
  assert.equal(runs, 1, 'no second catch-up')
})

test('37-38. pause disarms the timer; resume re-arms without losing the schedule', async () => {
  const c = fakeClock()
  const { d, clock } = durable()
  let runs = 0
  const s = createScheduler({ name: 'search', intervalMs: 3600_000, startupDelayMs: 1000, task: async () => ++runs, clock, ...c })
  s.start()
  d.paused = true
  s.refresh()
  assert.equal(s.armed, false)
  await c.advance(5 * 3600_000)
  assert.equal(runs, 0)
  assert.deepEqual(await s.runNow(), { skipped: 'paused' })
  d.paused = false
  s.refresh()
  assert.equal(s.armed, true)
  await c.advance(60_000)
  assert.equal(runs, 1)
})

test('a due run outside active hours waits for the window', async () => {
  const c = fakeClock(new Date(2026, 8, 21, 2, 0).getTime())
  const { d, clock } = durable()
  let runs = 0
  const active = (date) => withinActiveHours({ activeStartHour: 8, activeEndHour: 22 }, date)
  const s = createScheduler({ name: 'search', intervalMs: 3600_000, startupDelayMs: 1000, task: async () => ++runs, clock, active, ...c })
  s.start()
  await c.advance(1000)
  assert.equal(runs, 0)
  assert.equal(new Date(d.next).getHours(), 8)
})

// --- store ------------------------------------------------------------------

test('the store persists, counts per day, and keeps run history bounded', () => {
  const file = join(tmp(), 'state.json')
  const s = createStore(file)
  s.count('discovered', 3)
  s.count('submitted')
  for (let i = 0; i < 40; i++) s.addRun({ runId: i })
  s.upsertJob({ ...base(), description: 'SECRET FULL JD TEXT' })
  s.save()
  const again = createStore(file)
  assert.equal(again.data.sinceLastUpdate.discovered, 3)
  assert.equal(again.day().submitted, 1)
  assert.equal(again.data.runs.length, 30)
  assert.equal(Object.values(again.data.jobs)[0].description, undefined, 'no full descriptions stored locally')
})

test('the run lock is exclusive', () => {
  const file = join(tmp(), 'run.lock')
  const a = acquireLock(file)
  assert.ok(a)
  assert.equal(acquireLock(file, { pid: process.pid + 1 }), null)
  a.release()
  assert.ok(acquireLock(file))
})

// --- notifications ----------------------------------------------------------

test('58-60. the batched summary reports the counts it was given', () => {
  const text = summaryText({ discovered: 12, qualified: 4, rejected: 8, queued: 3, tailored: 3, attempted: 3, submitted: 2, needsInput: 1 })
  assert.equal(text, 'Job search update. I found twelve new roles. Four matched your criteria. Three CVs have been tailored and two applications were submitted. One application needs your input.')
  assert.equal(summaryText({ discovered: 0, qualified: 0, tailored: 0, submitted: 0, needsInput: 0 }), 'Job search update. Nothing new since the last update.')
  assert.equal(morningLine({ submitted: 0, qualified: 0 }), '')
  assert.match(morningLine({ submitted: 3, qualified: 0 }, { awaitingTailoring: 2 }), /submitted three applications and has two CVs waiting for tailoring/)
})
