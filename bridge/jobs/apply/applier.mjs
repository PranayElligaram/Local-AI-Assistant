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
 * Any unresolved question stops the application (NEEDS_INPUT) — no guessing.
 * Every run is capped by JOBS_MAX_APPLICATIONS_PER_DAY.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { transition } from '../state.mjs'
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
    try {
      session = await (await getDriver()).open(target.url)
      const page = await session.snapshot()
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

      for (const p of plan) {
        if (p.action === 'fill') await session.fill(p.field.id, p.value)
        else if (p.action === 'choose') await session.choose(p.field.id, p.option)
        else if (p.action === 'check') await session.check(p.field.id)
        else if (p.action === 'upload') await session.upload(p.field.id, cv.path)
      }
      const before = blockers(await session.snapshot())
      if (before.length) return needs(before[0].reason)

      submittedClick = true
      store.count('attempted', 1, now())
      await session.submit()
      const after = await session.snapshot()
      const ev = evidence(after)
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
      // 48: a click without proof is not an application.
      const late = blockers(after)
      if (late.length) return needs(late[0].reason)
      job = { ...transition(job, 'APPLICATION_FAILED', { at: iso }), lastApplyError: ev.detail }
      note(`Submission could not be verified (${ev.detail}); not marked applied.`)
      return { job, outcome: 'APPLICATION_FAILED', requests }
    } catch (err) {
      log(`[jobs] application ${job.id}: ${err.message}`)
      if (submittedClick) {
        job = { ...transition(job, 'APPLICATION_FAILED', { at: iso }), lastApplyError: 'browser error after submit' }
        return { job, outcome: 'APPLICATION_FAILED', requests, error: 'BROWSER' }
      }
      job = { ...transition(job, 'TAILORED', { at: iso }), lastApplyError: String(err.message).slice(0, 160) }
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
        .filter((j) => j.status === 'TAILORED' && !(mode !== 'live' && j.dryRunInspectedAt))
        .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
        .slice(0, room)
      for (const job of queue) {
        const out = await applyOne(job, { rec: byId?.get(job.id), parsed, mode })
        if (mode !== 'live') store.count('inspected', 1, at)
        store.upsertJob(out.job)
        r.changed.push(out.job)
        r.requests.push(...out.requests)
        if (out.error && !r.errorCategories.includes(out.error)) r.errorCategories.push(out.error)
        if (out.outcome === 'NEEDS_INPUT') {
          r.needsInput++
          store.count('needsInput', 1, at)
        }
        if (['APPLIED', 'APPLICATION_FAILED'].includes(out.outcome)) r.attempted++
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
