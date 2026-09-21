/**
 * The job agent's durable local state: schedule, pause flag, per-job status,
 * bounded run history and since-last-update counters.
 *
 * Lives in the run directory (git-ignored). The Google Sheet stays the source
 * of truth for the user's applications; this file is what lets JARVIS survive
 * a restart without re-running a search or re-notifying. It holds no tokens,
 * no profile values, no CV text and no full job descriptions.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_RUNS = 30
const MAX_JOBS = 1500

export const EMPTY_COUNTERS = () => ({
  discovered: 0,
  qualified: 0,
  rejected: 0,
  queued: 0,
  tailored: 0,
  attempted: 0,
  submitted: 0,
  needsInput: 0,
})

const fresh = () => ({
  version: 1,
  paused: false,
  lastRunAt: null,
  nextRunAt: null,
  lastWatchAt: null,
  nextWatchAt: null,
  tracker: { spreadsheetId: null, resolvedAt: null },
  jobs: {},
  runs: [],
  sinceLastUpdate: EMPTY_COUNTERS(),
  lastUpdateAt: null,
  daily: {},
  sourceHealth: {},
  lastErrorCategory: null,
})

/** The fields of a job worth keeping locally. No description, no personal data. */
export function slimJob(job) {
  const keep = [
    'id', 'title', 'company', 'location', 'workplaceType', 'source', 'sourceJobId', 'canonicalUrl', 'applicationUrl',
    'postedDate', 'discoveredAt', 'lastVerifiedAt', 'roleFamily', 'fitScore', 'rankScore', 'fitReasons', 'exclusionReasons',
    'applicationDifficulty', 'interviewDifficulty', 'status', 'resumeState', 'needsInput', 'tailoredCvUrl', 'tailoredPdfUrl',
    'tailoredAt', 'appliedAt', 'submissionEvidence', 'history', 'updatedAt', 'trackerRow', 'descriptionFingerprint', 'dryRun',
    'trackerTab', 'closedReason', 'lastApplyError', 'dryRunInspectedAt', 'dryRunPlan',
  ]
  return Object.fromEntries(keep.filter((k) => job[k] !== undefined).map((k) => [k, job[k]]))
}

export function createStore(file) {
  let data = fresh()
  if (file && existsSync(file)) {
    try {
      data = { ...fresh(), ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch (err) {
      console.warn(`[jarvis] job agent state unreadable (${err.message}) — starting fresh.`)
    }
  }

  const save = () => {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 1))
    renameSync(tmp, file)
  }

  const today = (now = new Date()) => now.toISOString().slice(0, 10)

  return {
    get data() {
      return data
    },
    save,
    update(fn) {
      fn(data)
      save()
    },
    upsertJob(job) {
      data.jobs[job.id] = { ...(data.jobs[job.id] ?? {}), ...slimJob(job) }
      const ids = Object.keys(data.jobs)
      if (ids.length > MAX_JOBS) {
        // Drop the oldest rejected first; never an active or applied job.
        const drop = ids
          .filter((id) => ['REJECTED', 'CLOSED'].includes(data.jobs[id].status))
          .sort((a, b) => String(data.jobs[a].updatedAt ?? '').localeCompare(String(data.jobs[b].updatedAt ?? '')))
          .slice(0, ids.length - MAX_JOBS)
        for (const id of drop) delete data.jobs[id]
      }
      return data.jobs[job.id]
    },
    job: (id) => data.jobs[id] ?? null,
    jobs: () => Object.values(data.jobs),
    count(field, n = 1, now = new Date()) {
      data.sinceLastUpdate[field] = (data.sinceLastUpdate[field] ?? 0) + n
      const d = today(now)
      data.daily[d] ??= EMPTY_COUNTERS()
      data.daily[d][field] = (data.daily[d][field] ?? 0) + n
      // Keep two weeks of daily counters.
      for (const k of Object.keys(data.daily).sort().slice(0, -14)) delete data.daily[k]
    },
    day: (now = new Date()) => data.daily[today(now)] ?? EMPTY_COUNTERS(),
    addRun(run) {
      data.runs = [...data.runs, run].slice(-MAX_RUNS)
    },
    resetSinceLastUpdate(now = new Date()) {
      data.sinceLastUpdate = EMPTY_COUNTERS()
      data.lastUpdateAt = now.toISOString()
    },
  }
}

/**
 * A cross-process lock (the bridge's scheduler and `npm run jobs` must not run
 * at once). Stale after `staleMs` or when the owner process is gone.
 */
export function acquireLock(file, { staleMs = 2 * 60 * 60 * 1000, pid = process.pid } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8'))
      const alive = (() => {
        try {
          process.kill(held.pid, 0)
          return true
        } catch {
          return false
        }
      })()
      if (alive && held.pid !== pid && Date.now() - held.at < staleMs) return null
    } catch {
      /* unreadable lock: treat as stale */
    }
    rmSync(file, { force: true })
  }
  try {
    // 'wx': exclusive create, so two processes racing here cannot both win.
    writeFileSync(file, JSON.stringify({ pid, at: Date.now() }), { flag: 'wx' })
  } catch {
    return null
  }
  return { release: () => rmSync(file, { force: true }) }
}

export const stateFile = (runDir) => join(runDir, 'jobs', 'state.json')
export const lockFile = (runDir) => join(runDir, 'jobs', 'run.lock')
