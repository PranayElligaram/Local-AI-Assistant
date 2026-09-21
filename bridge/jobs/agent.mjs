/**
 * The autonomous job agent: two timers (search every few hours, a cheap
 * tracker watch more often), a cross-process run lock, batched notifications,
 * spoken status answers and non-sensitive diagnostics.
 *
 * Start-up never waits for it: start() only arms timers, and the first run
 * happens a minute or two after JARVIS is up.
 */

import { join } from 'node:path'
import { createScheduler } from './scheduler.mjs'
import { EMPTY_COUNTERS, acquireLock, createStore, lockFile, stateFile } from './store.mjs'
import { createHttp } from './http.mjs'
import { loadSourcesFile } from './sources.mjs'
import { runSearch, runWatch } from './pipeline.mjs'
import { withinActiveHours } from './config.mjs'
import { morningLine, noteworthy, summaryText } from './notify.mjs'
import { createAuth, createTokenStore } from './google/oauth.mjs'
import { createGoogle } from './google/api.mjs'
import { resolveTracker } from './tracker.mjs'

const MIN_NOTIFY_GAP_MS = 3 * 60 * 60 * 1000

export const tokenFile = (runDir) => join(runDir, 'jobs', 'google-token.dpapi')

/**
 * @param {object} d
 * @param {ReturnType<import('./config.mjs').jobsConfig>} d.cfg
 * @param {string} d.root
 * @param {string} d.runDir
 * @param {(text: string) => void} [d.notify]
 * @param {() => Date} [d.now]
 * @param {object|null} [d.google]           injected client (tests); otherwise built from OAuth config
 * @param {() => object[]} [d.loadSources]   injected sources (tests)
 * @param {(ctx: object) => object} [d.createApplier]
 * @param {typeof fetch} [d.fetchFn]
 */
export function createJobAgent(d) {
  const { cfg, root, runDir, notify = () => {}, now = () => new Date(), log = (m) => console.log(m), fetchFn = fetch } = d
  const store = createStore(d.storeFile ?? stateFile(runDir))
  const lockPath = d.lockFile ?? lockFile(runDir)
  const state = { lastErrorCategory: store.data.lastErrorCategory, trackerConnected: false, sourceErrors: [], lastReport: null }

  let google = d.google ?? null
  if (!google && cfg.googleClientId && cfg.googleClientSecret) {
    const auth = createAuth({ clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, tokens: createTokenStore(tokenFile(runDir)), fetchFn })
    if (auth.authorised()) google = createGoogle({ accessToken: () => auth.accessToken(), fetchFn })
  }

  const loadSources = d.loadSources ?? (() => {
    const r = loadSourcesFile(root, cfg.sourcesFile)
    state.sourceErrors = r.errors
    return r.sources
  })

  async function trackerId() {
    if (!google) return null
    const r = await resolveTracker({ google, configuredId: cfg.trackerSpreadsheetId, storedId: store.data.tracker.spreadsheetId, name: cfg.trackerName })
    if (!r.ok) throw Object.assign(new Error(r.message), { category: r.category })
    if (r.persist) store.update((s) => (s.tracker = { spreadsheetId: r.id, resolvedAt: now().toISOString() }))
    return r.id
  }

  const setupCategory = () => (!cfg.googleClientId || !cfg.googleClientSecret ? 'GOOGLE_NOT_CONFIGURED' : !google ? 'GOOGLE_NOT_AUTHORISED' : null)

  async function withRun(kind, fn) {
    const lock = acquireLock(lockPath)
    if (!lock) return { skipped: 'another run holds the lock' }
    try {
      const ctx = { cfg, store, google, now, log, skills: d.skills }
      try {
        ctx.trackerId = await trackerId()
        state.trackerConnected = Boolean(ctx.trackerId)
      } catch (e) {
        state.trackerConnected = false
        state.lastErrorCategory = e.category ?? 'TRACKER'
        log(`[jobs] tracker: ${e.message}`)
      }
      if (d.createApplier) ctx.applier = d.createApplier(ctx)
      const result = await fn(ctx)
      const run = result.run
      const setup = setupCategory()
      if (setup && !run.errorCategories.includes(setup)) run.errorCategories.push(setup)
      state.lastErrorCategory = run.errorCategories[0] ?? null
      store.update((s) => {
        s.lastErrorCategory = state.lastErrorCategory
        s.runs = [...s.runs, run].slice(-30)
      })
      maybeNotify()
      return result
    } finally {
      lock.release()
    }
  }

  const search = (opts = {}) =>
    withRun('search', (ctx) => runSearch({ ...ctx, sources: loadSources(), http: createHttp({ maxRequests: cfg.maxSourceRequestsPerRun, fetchFn }), ...opts })).then((r) => {
      if (r.run) state.lastReport = r
      return r
    })
  const watch = () => withRun('watch', (ctx) => runWatch(ctx))

  const active = (date) => withinActiveHours(cfg, date)
  const clock = (next, last) => ({
    get: () => store.data[next],
    set: (v) => store.update((s) => (s[next] = v)),
    lastRun: (v) => store.update((s) => (s[last] = v)),
    paused: () => store.data.paused,
  })
  const searchTimer = createScheduler({ name: 'search', intervalMs: cfg.intervalMinutes * 60_000, task: () => search(), clock: clock('nextRunAt', 'lastRunAt'), active, startupDelayMs: 2 * 60_000 })
  const watchTimer = createScheduler({ name: 'watch', intervalMs: cfg.tailoringWatchMinutes * 60_000, task: () => watch(), clock: clock('nextWatchAt', 'lastWatchAt'), active, startupDelayMs: 4 * 60_000 })

  function maybeNotify(force = false) {
    const c = store.data.sinceLastUpdate
    const last = store.data.lastUpdateAt ? Date.parse(store.data.lastUpdateAt) : 0
    if (!noteworthy(c)) return null
    if (!force && now().getTime() - last < MIN_NOTIFY_GAP_MS && !c.needsInput) return null
    const text = summaryText(c, { needsInputOpen: jobsIn('NEEDS_INPUT').length })
    try {
      notify(text)
    } catch {
      /* a notification failure never breaks a run */
    }
    store.update(() => store.resetSinceLastUpdate(now()))
    return text
  }

  const jobsIn = (...states) => store.jobs().filter((j) => states.includes(j.status))
  const verifiedApplied = () => store.jobs().filter((j) => j.status === 'APPLIED' && j.submissionEvidence?.verified)
  const today = () => now().toISOString().slice(0, 10)
  const list = (jobs, max = 4) => {
    const names = jobs.slice(0, max).map((j) => `${j.title} at ${j.company}`)
    const more = jobs.length > max ? `, and ${jobs.length - max} more` : ''
    return names.length <= 1 ? names.join('') + more : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}${more}`
  }
  const lastTwoDays = () => {
    const d = new Date(now())
    const keys = [today(), new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10)]
    const sum = EMPTY_COUNTERS()
    for (const k of keys) for (const f of Object.keys(sum)) sum[f] += store.data.daily[k]?.[f] ?? 0
    return sum
  }

  return {
    store,
    start() {
      if (!cfg.enabled) return false
      searchTimer.start()
      watchTimer.start()
      return true
    },
    stop() {
      searchTimer.stop()
      watchTimer.stop()
    },
    search,
    watch,
    runNow: () => searchTimer.runNow('manual'),
    pause() {
      store.update((s) => (s.paused = true))
      searchTimer.refresh()
      watchTimer.refresh()
    },
    resume() {
      store.update((s) => (s.paused = false))
      searchTimer.refresh()
      watchTimer.refresh()
    },
    maybeNotify,

    // --- spoken answers ---
    statusText() {
      if (!cfg.enabled) return 'The job agent is switched off. Set JOBS_AGENT_ENABLED to true to turn it on.'
      const setup = setupCategory()
      const day = store.day(now())
      const parts = []
      if (store.data.paused) parts.push('Job searching is paused.')
      if (setup === 'GOOGLE_NOT_CONFIGURED') parts.push("I can search, but I'm not connected to your Google tracker yet.")
      else if (setup === 'GOOGLE_NOT_AUTHORISED') parts.push("I'm waiting for Google authorisation before I can use your tracker.")
      parts.push(day.discovered || day.qualified ? `Today I found ${day.discovered} new roles and ${day.qualified} matched your criteria.` : 'No new matching roles today so far.')
      const waiting = jobsIn('READY_TO_TAILOR', 'TAILORING').length
      const ready = jobsIn('TAILORED').length
      if (waiting) parts.push(`${waiting} ${waiting === 1 ? 'CV is' : 'CVs are'} waiting for tailoring.`)
      if (ready) parts.push(`${ready} tailored ${ready === 1 ? 'role is' : 'roles are'} ready to apply.`)
      const applied = verifiedApplied().length
      parts.push(applied ? `${applied} verified ${applied === 1 ? 'application' : 'applications'} submitted in total.` : cfg.applicationMode === 'live' ? 'No applications submitted yet.' : `Automatic applications are in ${cfg.applicationMode} mode, so nothing has been submitted.`)
      const needs = jobsIn('NEEDS_INPUT').length
      if (needs) parts.push(`${needs} ${needs === 1 ? 'needs' : 'need'} your input.`)
      return parts.join(' ')
    },
    appliedCountText() {
      const n = verifiedApplied().length
      const mode = cfg.applicationMode === 'live' ? '' : ` Live applications are off; the agent is in ${cfg.applicationMode} mode.`
      return `I've submitted ${n} ${n === 1 ? 'application' : 'applications'} with verified confirmation.${mode}`
    },
    appliedTodayText() {
      const jobs = verifiedApplied().filter((j) => String(j.appliedAt).startsWith(today()))
      return jobs.length ? `Today I applied for ${list(jobs)}.` : 'I have not submitted any applications today.'
    },
    needsInputText() {
      const jobs = jobsIn('NEEDS_INPUT')
      if (!jobs.length) return 'Nothing needs you right now.'
      return `${jobs.length} ${jobs.length === 1 ? 'role needs' : 'roles need'} you: ${jobs.slice(0, 4).map((j) => `${j.title} at ${j.company}, ${j.needsInput?.reason ?? 'input needed'}`).join('; ')}.`
    },
    todaysJobsText() {
      const jobs = store.jobs().filter((j) => String(j.discoveredAt).startsWith(today()) && !['REJECTED', 'CLOSED'].includes(j.status))
      return jobs.length ? `Today's roles: ${list(jobs, 5)}.` : "I haven't added any roles today."
    },
    morningText() {
      if (!cfg.enabled) return ''
      return morningLine(lastTwoDays(), { awaitingTailoring: jobsIn('READY_TO_TAILOR', 'TAILORING').length, needsInputOpen: jobsIn('NEEDS_INPUT').length })
    },
    lastReport: () => state.lastReport,

    /** Counts and health only: no tokens, profile values, CV text, JD text or contact details. */
    diagnostics() {
      const day = store.day(now())
      return {
        enabled: cfg.enabled,
        paused: store.data.paused,
        applicationMode: cfg.applicationMode,
        trackerWrites: cfg.trackerWrites,
        lastRunAt: store.data.lastRunAt,
        nextRunAt: cfg.enabled && !store.data.paused ? store.data.nextRunAt : null,
        lastWatchAt: store.data.lastWatchAt,
        nextWatchAt: cfg.enabled && !store.data.paused ? store.data.nextWatchAt : null,
        runInProgress: searchTimer.running || watchTimer.running,
        intervalMinutes: cfg.intervalMinutes,
        discoveredToday: day.discovered,
        qualifiedToday: day.qualified,
        tailoredToday: day.tailored,
        appliedToday: day.submitted,
        needsInput: jobsIn('NEEDS_INPUT').length,
        tailoringQueueCount: jobsIn('READY_TO_TAILOR', 'TAILORING').length,
        applicationQueueCount: jobsIn('TAILORED').length,
        sourceHealth: Object.fromEntries(Object.entries(store.data.sourceHealth).map(([k, v]) => [k, { ok: v.ok, at: v.at, ...(v.category ? { category: v.category } : {}) }])),
        sourceConfigErrors: state.sourceErrors.length,
        googleConfigured: Boolean(cfg.googleClientId && cfg.googleClientSecret),
        googleAuthorised: Boolean(google),
        trackerConnected: state.trackerConnected,
        trackerResolved: Boolean(cfg.trackerSpreadsheetId || store.data.tracker.spreadsheetId),
        lastErrorCategory: state.lastErrorCategory ?? setupCategory(),
        runsRecorded: store.data.runs.length,
      }
    },
  }
}
