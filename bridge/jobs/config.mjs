/**
 * Job agent settings. Same mechanism as the rest of JARVIS: the environment,
 * then the project's git-ignored `.env.local` / `.env` (loaded by
 * ../config.mjs). Every value has a conservative default, and live
 * applications are never the default.
 */

import { flag, num } from '../config.mjs'

const str = (raw) => {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

export const APPLICATION_MODES = ['off', 'dry-run', 'live']

/** Google Drive/Sheets file ids: letters, digits, - and _. Nothing else is ever sent to Google as an id. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/

export const DEFAULT_TRACKER_NAME = 'Pranay — AI & Software Job Application Tracker'

export function jobsConfig(env = process.env) {
  const n = (name, min, max, fallback) => num(name, env[name], { min, max, fallback })
  const hour = (name) => {
    const v = str(env[name])
    return v === undefined ? null : n(name, 0, 23, null)
  }
  let mode = (str(env.JOBS_APPLICATION_MODE) ?? 'dry-run').toLowerCase()
  if (!APPLICATION_MODES.includes(mode)) {
    console.warn(`[jarvis] JOBS_APPLICATION_MODE="${mode}" is not off, dry-run or live — using dry-run.`)
    mode = 'dry-run'
  }
  const id = (name) => {
    const v = str(env[name])
    if (v === undefined) return null
    if (!DRIVE_ID.test(v)) {
      console.warn(`[jarvis] ${name} is not a valid Google file id — ignored.`)
      return null
    }
    return v
  }
  return {
    enabled: flag('JOBS_AGENT_ENABLED', env.JOBS_AGENT_ENABLED, false),
    intervalMinutes: n('JOBS_SEARCH_INTERVAL_MINUTES', 30, 24 * 60, 240),
    tailoringWatchMinutes: n('JOBS_TAILORING_WATCH_MINUTES', 5, 24 * 60, 30),
    activeStartHour: hour('JOBS_ACTIVE_START_HOUR'),
    activeEndHour: hour('JOBS_ACTIVE_END_HOUR'),
    // Discovery writes rows to the tracker only when this is on. Off, a run
    // discovers and evaluates and reports, and changes nothing.
    trackerWrites: flag('JOBS_TRACKER_WRITES', env.JOBS_TRACKER_WRITES, false),
    applicationMode: mode,
    maxApplicationsPerDay: n('JOBS_MAX_APPLICATIONS_PER_DAY', 0, 20, 3),
    maxNewQualifiedPerRun: n('JOBS_MAX_NEW_QUALIFIED_PER_RUN', 0, 25, 3),
    maxTailorQueuedPerRun: n('JOBS_MAX_TAILOR_QUEUED_PER_RUN', 0, 10, 2),
    // Roles waiting on the ChatGPT workflow at once; more are held as QUALIFIED.
    maxTailorBacklog: n('JOBS_MAX_TAILOR_BACKLOG', 0, 20, 4),
    mainTab: str(env.JOBS_TRACKER_MAIN_TAB) ?? null,
    maxSourceRequestsPerRun: n('JOBS_MAX_SOURCE_REQUESTS_PER_RUN', 1, 500, 60),
    minFitScore: n('JOBS_MIN_FIT_SCORE', 50, 100, 70),
    maxJobAgeDays: n('JOBS_MAX_JOB_AGE_DAYS', 1, 365, 90),
    trackerName: str(env.JOBS_TRACKER_NAME) ?? DEFAULT_TRACKER_NAME,
    trackerSpreadsheetId: id('JOBS_TRACKER_SPREADSHEET_ID'),
    masterCvFileId: id('JOBS_MASTER_CV_FILE_ID'),
    outputFolderId: id('JOBS_OUTPUT_FOLDER_ID'),
    googleClientId: str(env.JOBS_GOOGLE_CLIENT_ID) ?? null,
    // A desktop OAuth client's "secret" is not confidential by Google's own
    // definition, but it is still kept out of logs and diagnostics.
    googleClientSecret: str(env.JOBS_GOOGLE_CLIENT_SECRET) ?? null,
    sourcesFile: str(env.JOBS_SOURCES_FILE) ?? 'jarvis.jobs.sources.json',
    profileFile: str(env.JOBS_PROFILE_FILE) ?? 'jarvis.jobs.profile.json',
    notifyToast: flag('JOBS_NOTIFY_TOAST', env.JOBS_NOTIFY_TOAST, true),
    // The application browser: a separate, JARVIS-only Chrome profile, headless by default.
    browserHeadless: flag('JOBS_BROWSER_HEADLESS', env.JOBS_BROWSER_HEADLESS, true),
  }
}

/** Is `date` inside the configured active hours? No hours configured = always. */
export function withinActiveHours(cfg, date = new Date()) {
  const { activeStartHour: s, activeEndHour: e } = cfg
  if (s == null || e == null || s === e) return true
  const h = date.getHours()
  return s < e ? h >= s && h < e : h >= s || h < e
}
