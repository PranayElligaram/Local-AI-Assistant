/**
 * The application step: TAILORED -> APPLYING -> APPLIED | NEEDS_INPUT |
 * APPLICATION_FAILED | CLOSED.
 *
 *   off      nothing happens.
 *   dry-run  (default) open the real form, read its questions, plan answers
 *            from the approved profile, report blockers. Nothing is typed,
 *            nothing is uploaded, nothing is submitted.
 *   live     only with JOBS_APPLICATION_MODE=live AND a complete profile audit:
 *            fill approved answers, upload the tailored CV, submit when nothing
 *            is unresolved, and record APPLIED only on positive evidence.
 *
 * Once submit has been triggered the employer may have the application, so
 * anything short of positive evidence (an unreadable page, a browser error, no
 * confirmation text) is an UNKNOWN outcome, not a failure: the job is parked
 * in NEEDS_INPUT with submissionOutcome UNKNOWN and is never retried
 * automatically. Errors before submit are ordinary APPLICATION_FAILED.
 *
 * Any unresolved question stops the application (NEEDS_INPUT) — no guessing.
 * Every run is capped by JOBS_MAX_APPLICATIONS_PER_DAY.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { markSubmissionUnknown, transition } from '../state.mjs'
import { planRowUpdate } from '../tracker.mjs'
import { driveIdFromUrl } from '../google/api.mjs'
import { auditProfile } from '../profile.mjs'
import { planAnswers } from './questions.mjs'
import { blockers, evidence } from './verify.mjs'
import { safeUrl } from '../../tools.mjs'

/** Hosts an application may be submitted on: public ATSs, or the employer's own career site the job came from. */
const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|teamtailor\.com|smartrecruiters\.com|recruitee\.com|personio\.(de|com)|bamboohr\.com)$/i

/**
 * The only URLs the browser automation will open: https, no credentials, a
 * sane length, and an ATS host or the job's own employer host. Aggregators
 * and anything read out of a spreadsheet cell that fails this are refused.
 */
export function validateApplicationUrl(raw, job = {}) {
  const href = safeUrl(raw)
  if (!href || href.length > 600) return { ok: false, reason: 'not a valid http(s) URL' }
  const u = new URL(href)
  if (u.protocol !== 'https:') return { ok: false, reason: 'application URLs must be https' }
  if (/[\s"'<>`]/.test(raw)) return { ok: false, reason: 'URL contains characters that are not allowed' }
  const employerHost = String(job.source ?? '').startsWith('careers:') ? String(job.source).slice(8).toLowerCase().replace(/^www\./, '') : null
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const employerOk = employerHost && (host === employerHost || host.endsWith(`.${employerHost}`))
  const canonicalHost = safeUrl(job.canonicalUrl) ? new URL(safeUrl(job.canonicalUrl)).hostname.toLowerCase().replace(/^www\./, '') : null
  // A Greenhouse board embedded on the employer's own domain (e.g. helsing.ai/jobs/123?gh_jid=123).
  const embeddedGreenhouse = String(job.source ?? '').startsWith('greenhouse:') && canonicalHost === host && u.searchParams.has('gh_jid')
  if (!ATS_HOSTS.test(host) && !employerOk && !embeddedGreenhouse) return { ok: false, reason: `${host} is not a recognised ATS or the employer's own site` }
  return { ok: true, url: href }
}

/** One line of an exception, bounded, with URL queries, emails and known profile values removed. */
export function sanitizeError(err, profile) {
  let m = String(err?.message ?? err ?? '').split('\n')[0].replace(/\s+/g, ' ')
  m = m.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1')
  for (const v of Object.values(profile?.fields ?? {})) if (typeof v === 'string' && v.length >= 3) m = m.split(v).join('[redacted]')
  return m.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').slice(0, 200)
}

/** Origin + path only: confirmation pages can carry tokens in the query. */
function safeFinalUrl(u) {
  try {
    const x = new URL(String(u))
    return `${x.origin}${x.pathname}`.slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * @param {object} d
 * @param {object} d.cfg
 * @param {ReturnType<import('../store.mjs').createStore>} d.store
 * @param {object|null} d.google
 * @param {object} d.profile                 normalizeProfile() output
 * @param {object} [d.driver]                { open(url) -> session } (tests inject a fake)
 * @param {string} [d.cvDir]
 * @param {() => Date} [d.now]
 */
export function createApplier(d) {
  const { cfg, store, google, profile, log = () => {}, now = () => new Date() } = d
  const cvDir = d.cvDir ?? join(process.cwd(), '.jarvis', 'jobs', 'cv')
  let driver = d.driver ?? null
  const getDriver = async () => {
    if (!driver) {
      const { createPlaywrightDriver } = await import('./playwright.mjs')
      driver = createPlaywrightDriver({ profileDir: join(cvDir, '..', 'browser-profile'), headless: cfg.browserHeadless !== false })
    }
    return driver
  }

  async function fetchCv(job) {
    const id = driveIdFromUrl(job.tailoredPdfUrl) ?? driveIdFromUrl(job.tailoredCvUrl)
    if (!id) return { ok: false, reason: 'no tailored CV link is recorded for this job' }
    if (!google) return { ok: false, reason: 'Google is not connected, so the tailored CV cannot be fetched' }
    try {
      const file = await google.download(id)
      if (!file.bytes?.length) return { ok: false, reason: 'the tailored CV file is empty' }
      mkdirSync(cvDir, { recursive: true })
      const ext = file.mimeType === 'application/pdf' ? 'pdf' : /wordprocessingml/.test(file.mimeType) ? 'docx' : null
      if (!ext) return { ok: false, reason: `the tailored CV is a ${file.mimeType}, not a PDF or DOCX` }
      const path = join(cvDir, `${job.id}.${ext}`)
      writeFileSync(path, file.bytes)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, reason: `the tailored CV could not be downloaded (${err.category ?? err.message})` }
    }
  }

  const polls = Math.max(1, cfg.postSubmitPolls ?? 8)
  const pollMs = cfg.postSubmitPollMs ?? 2500

  /**
   * After submit: re-read whichever page/frame is current, a bounded number of
   * times, until positive evidence (or a blocker) appears. Reads that throw are
   * tolerated — navigation, a detached frame or an SPA rerender are expected.
   * Returns the last readable page and the last read error. A changed page is
   * never itself evidence; verify.mjs decides.
   */
  async function readOutcome(session) {
    let last = null
    let readError = null
    for (let i = 0; i < polls; i++) {
      if (i) await Promise.resolve(session.wait?.(pollMs)).catch(() => {})
      try {
        const snap = await session.snapshot()
        if (snap && snap.readable !== false) {
          last = snap
          if (evidence(snap).verified || blockers(snap).length) break
        }
      } catch (err) {
        readError = err
        if (err?.fatal) break // the browser itself is gone; nothing more to read
      }
    }
    return { after: last, readError }
  }

  /** One job. Returns { job, outcome, requests } and never throws. */
  async function applyOne(job0, { rec, parsed, mode }) {
    const iso = now().toISOString()
    let job = job0
    const requests = []
    const note = (text) => {
      if (rec && parsed && cfg.trackerWrites) {
        const u = planRowUpdate(parsed, rec, { note: `[JARVIS ${iso.slice(0, 10)}] ${text}` })
        if (u.ok) requests.push(...u.requests)
      }
    }
    const needs = (reason, question = '') => {
      job = transition(job, 'NEEDS_INPUT', { at: iso, reason, question })
      note(`Application needs your input: ${reason}${question ? ` — "${question}"` : ''}. ${job.applicationUrl}`)
      return { job, outcome: 'NEEDS_INPUT', requests }
    }

    const target = validateApplicationUrl(job.applicationUrl, job)
    if (!target.ok) return needs(`application URL refused: ${target.reason}`)
    const cv = await fetchCv(job)
    if (!cv.ok) return needs(cv.reason) // 47: no CV, no application

    job = transition(job, 'APPLYING', { at: iso })
    let session = null
    let submittedClick = false
    let stage = 'open'
    let lastUrl = ''
    // Bounded and non-sensitive: no field values, no page text.
    const diagnostic = ({ err, snap } = {}) => ({
      stage,
      errorClass: err ? String(err.name ?? 'Error').slice(0, 60) : '',
      errorMessage: err ? sanitizeError(err, profile) : '',
      finalUrl: safeFinalUrl(snap?.url ?? lastUrl),
      submitTriggered: submittedClick,
      formStillPresent: typeof snap?.formStillPresent === 'boolean' ? snap.formStillPresent : null,
      at: iso,
    })
    const unknown = (detail, diag) => {
      job = markSubmissionUnknown(job, { at: iso, error: detail, diagnostic: diag })
      note(`Submit was triggered but the submission could not be verified (${detail}). NOT marked applied and will not be retried — check the employer's ATS/email.`)
      return { job, outcome: 'SUBMISSION_UNKNOWN', requests }
    }
    try {
      session = await (await getDriver()).open(target.url)
      stage = 'read-form'
      const page = await session.snapshot()
      lastUrl = page.url ?? ''
      const stop = blockers(page)
      if (stop.some((b) => b.kind === 'closed')) {
        job = { ...transition(job, 'CLOSED', { at: iso }), closedReason: 'vacancy closed at application time' }
        note('Vacancy found closed when applying.')
        return { job, outcome: 'CLOSED', requests }
      }
      if (stop.length) return needs(stop[0].reason)
      const fields = await session.fields()
      if (!fields.length) return needs('no application form was found on the page')
      const { plan, unresolved, uploads } = planAnswers(fields, profile)
      if (!uploads.length) return needs('the form has no CV upload field JARVIS recognises')
      if (unresolved.length) return needs(unresolved[0].reason, unresolved[0].question)

      if (mode !== 'live') {
        // 50: dry-run reads and plans; it never types, uploads or submits.
        job = { ...transition(job, 'TAILORED', { at: iso }), dryRunInspectedAt: iso, dryRunPlan: { fields: fields.length, answered: plan.filter((p) => !['skip', 'needs-input'].includes(p.action)).length, skipped: plan.filter((p) => p.action === 'skip').length } }
        return { job, outcome: 'DRY_RUN_READY', requests }
      }

      stage = 'fill'
      for (const p of plan) {
        if (p.action === 'fill') await session.fill(p.field.id, p.value)
        else if (p.action === 'choose') await session.choose(p.field.id, p.option)
        else if (p.action === 'check') await session.check(p.field.id)
        else if (p.action === 'upload') await session.upload(p.field.id, cv.path)
      }
      stage = 'pre-submit-check'
      const before = blockers(await session.snapshot())
      if (before.length) return needs(before[0].reason)

      stage = 'submit'
      let submitError = null
      try {
        submittedClick = true
        store.count('attempted', 1, now())
        await session.submit()
      } catch (err) {
        // Only the driver's explicit "nothing was clicked" is pre-submit; any other error may have submitted.
        if (err?.submitNotTriggered) {
          submittedClick = false
          throw err
        }
        submitError = err
      }
      stage = 'post-submit-read'
      const { after, readError } = await readOutcome(session)
      const ev = after ? evidence(after) : { verified: false, kind: 'none', detail: 'the page could not be read after submit' }
      if (ev.verified) {
        job = transition(job, 'APPLIED', { at: iso, evidence: ev })
        store.count('submitted', 1, now())
        if (rec && parsed && cfg.trackerWrites) {
          const u = planRowUpdate(parsed, rec, { applied: true, evidence: ev, note: `[JARVIS ${iso.slice(0, 10)}] Applied automatically; evidence: ${ev.kind} (${ev.detail})${ev.confirmationId ? ` #${ev.confirmationId}` : ''}.` })
          if (u.ok) requests.push(...u.requests)
          else note(`Applied (evidence: ${ev.kind}); tracker status left for you: ${u.reason}.`)
        }
        return { job, outcome: 'APPLIED', requests }
      }
      // 48: a click without proof is not an application — nor, after a click, a failure: the outcome is unknown.
      const err = submitError ?? (after ? null : readError)
      if (err) log(`[jobs] application ${job.id} after submit (${stage}): ${sanitizeError(err, profile)}`)
      const late = after ? blockers(after) : []
      const detail = err ? sanitizeError(err, profile) : late.length ? `after submit: ${late[0].reason}` : ev.detail
      return { ...unknown(detail, diagnostic({ err, snap: after })), ...(err ? { error: 'BROWSER' } : {}) }
    } catch (err) {
      log(`[jobs] application ${job.id} (${stage}): ${sanitizeError(err, profile)}`)
      if (job.status === 'APPLIED') return { job, outcome: 'APPLIED', requests } // evidence already recorded
      if (submittedClick) return { ...unknown(sanitizeError(err, profile), diagnostic({ err })), error: 'BROWSER' }
      if (mode === 'live') {
        // Nothing was submitted. Not retried automatically either: fields may have been half-filled.
        job = { ...transition(job, 'APPLICATION_FAILED', { at: iso }), lastApplyError: sanitizeError(err, profile), postSubmitDiagnostic: diagnostic({ err }) }
        note(`Application failed before submit (${sanitizeError(err, profile)}); nothing was submitted.`)
        return { job, outcome: 'APPLICATION_FAILED', requests, error: 'BROWSER' }
      }
      job = { ...transition(job, 'TAILORED', { at: iso }), lastApplyError: sanitizeError(err, profile).slice(0, 160) }
      return { job, outcome: 'ERROR', requests, error: 'BROWSER' }
    } finally {
      await session?.close?.().catch?.(() => {})
      if (cv.path) rmSync(cv.path, { force: true })
    }
  }

  return {
    applyOne,
    /** Called by the watch pass. */
    async processQueue({ parsed, byId, at = now() }) {
      const r = { attempted: 0, submitted: 0, needsInput: 0, requests: [], changed: [], errorCategories: [] }
      const mode = cfg.applicationMode
      if (mode === 'off') return r
      if (mode === 'live') {
        const audit = auditProfile(profile, cfg)
        if (!audit.liveModeAllowed) {
          r.errorCategories.push('PROFILE_INCOMPLETE')
          return r
        }
      }
      const day = store.day(at)
      const used = mode === 'live' ? day.attempted ?? 0 : day.inspected ?? 0
      const room = Math.max(0, cfg.maxApplicationsPerDay - used)
      const queue = store
        .jobs()
        // An UNKNOWN submission is never re-applied automatically, whatever state it ends up in.
        .filter((j) => j.status === 'TAILORED' && j.submissionOutcome !== 'UNKNOWN' && !(mode !== 'live' && j.dryRunInspectedAt))
        .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
        .slice(0, room)
      for (const job of queue) {
        const out = await applyOne(job, { rec: byId?.get(job.id), parsed, mode })
        if (mode !== 'live') store.count('inspected', 1, at)
        store.upsertJob(out.job)
        r.changed.push(out.job)
        r.requests.push(...out.requests)
        if (out.error && !r.errorCategories.includes(out.error)) r.errorCategories.push(out.error)
        if (['NEEDS_INPUT', 'SUBMISSION_UNKNOWN'].includes(out.outcome)) {
          r.needsInput++
          store.count('needsInput', 1, at)
        }
        if (['APPLIED', 'APPLICATION_FAILED', 'SUBMISSION_UNKNOWN'].includes(out.outcome)) r.attempted++
        if (out.outcome === 'APPLIED') r.submitted++
      }
      return r
    },
    /** For `npm run jobs -- apply-check`: always dry-run, never changes state. */
    async inspect(job) {
      const out = await applyOne({ ...job, status: 'TAILORED' }, { mode: 'dry-run' })
      return { outcome: out.outcome, needsInput: out.job.needsInput ?? null, plan: out.job.dryRunPlan ?? null }
    },
  }
}
