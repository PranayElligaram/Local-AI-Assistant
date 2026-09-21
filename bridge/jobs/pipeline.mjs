/**
 * One search run and one watch pass.
 *
 * search:  sources -> normalise -> dedupe (tracker + JARVIS_META + local)
 *          -> cheap title/location pre-filter -> full JD -> evaluate
 *          -> rank -> re-verify open -> insert (bounded) -> queue for tailoring
 * watch:   read the tracker -> notice what the ChatGPT tailoring workflow (or
 *          the user) changed -> advance states -> hand TAILORED jobs to the
 *          application step -> keep the tailoring backlog topped up
 *
 * With tracker writes off (the default) a search run changes nothing
 * anywhere: it reports what it would have added and why.
 */

import { randomUUID } from 'node:crypto'
import { DedupeIndex, descriptionFingerprint, normalizeJob } from './job.mjs'
import { classifyLocation, classifyTitle, evaluate, rankJobs } from './criteria.mjs'
import { ACTIVE_STATES, transition } from './state.mjs'
import {
  ensureMetaRequests,
  insertRequests,
  mappingProblems,
  metaRecords,
  metaUpsertRequests,
  parseSpreadsheet,
  planInsert,
  planRowUpdate,
  recoverMarkers,
  trackerRecords,
} from './tracker.mjs'

const category = (err) => err?.category ?? (err?.name === 'AbortError' ? 'TIMEOUT' : 'ERROR')

export async function loadTracker(ctx) {
  if (!ctx.google || !ctx.trackerId) return null
  const ss = await ctx.google.getSpreadsheet(ctx.trackerId)
  return parseSpreadsheet(ss, { mainTab: ctx.cfg.mainTab ?? null })
}

function buildIndex(parsed, store) {
  const idx = new DedupeIndex()
  if (parsed) {
    for (const r of trackerRecords(parsed)) idx.add(r, r.jobId ?? `${r.tab}!${r.row + 1}`)
    for (const m of metaRecords(parsed)) idx.add({ ...m, sourceJobId: m.atsJobId, source: m.source }, m.jobId)
  }
  for (const j of store.jobs()) idx.add(j, j.id)
  return idx
}

/** Apply `to`, via the paused state's resume state when NEEDS_INPUT is in the way. */
function advance(job, to, meta = {}) {
  if (job.status === to) return job
  if (job.status === 'NEEDS_INPUT' && job.resumeState && job.resumeState !== to && to !== 'CLOSED') {
    job = transition(job, job.resumeState, meta)
  }
  return transition(job, to, meta)
}

export async function runSearch(ctx) {
  const { cfg, store, sources, http, now = () => new Date(), log = () => {} } = ctx
  const at = now()
  const run = {
    runId: randomUUID().slice(0, 8),
    kind: 'search',
    startedAt: at.toISOString(),
    finishedAt: null,
    mode: cfg.trackerWrites ? 'write' : 'dry-run',
    sourceCounts: {},
    discovered: 0,
    duplicates: 0,
    prefiltered: 0,
    qualified: 0,
    rejected: 0,
    queued: 0,
    inserted: 0,
    closed: 0,
    errorCategories: [],
  }
  const report = { run, candidates: [] }
  const err = (c) => !run.errorCategories.includes(c) && run.errorCategories.push(c)

  let parsed = null
  try {
    parsed = await loadTracker(ctx)
  } catch (e) {
    err(category(e))
    log(`[jobs] tracker unavailable: ${e.message}`)
  }
  const writable = Boolean(parsed && cfg.trackerWrites && !mappingProblems(parsed).length)
  if (parsed && cfg.trackerWrites && !writable) err('TRACKER_MAPPING')
  const index = buildIndex(parsed, store)

  // 1. discover
  const fresh = []
  for (const source of sources) {
    if (http.remaining <= 0) {
      err('BUDGET')
      break
    }
    try {
      const raw = await source.discover(http)
      let fresh1 = 0
      for (const r of raw) {
        const job = normalizeJob(r, at)
        if (!job.title || !job.company) continue
        if (index.match(job)) {
          run.duplicates++
          continue
        }
        index.add(job) // also dedupes within this run across sources
        fresh.push({ job, source })
        fresh1++
      }
      run.sourceCounts[source.id] = { listed: raw.length, new: fresh1 }
      store.data.sourceHealth[source.id] = { ok: true, at: at.toISOString(), listed: raw.length }
    } catch (e) {
      const c = category(e)
      run.sourceCounts[source.id] = { error: c }
      store.data.sourceHealth[source.id] = { ok: false, at: at.toISOString(), category: c }
      err(c === 'BUDGET' ? 'BUDGET' : `SOURCE_${c}`)
      log(`[jobs] source ${source.id} failed: ${e.message}`)
    }
  }
  run.discovered = fresh.length

  // 2. cheap pre-filter on title and location (no extra requests)
  const evaluated = []
  const reject = (job, ev) => {
    run.rejected++
    const j = { ...job, ...pick(ev), status: 'REJECTED', updatedAt: at.toISOString() }
    report.candidates.push(summarise(j))
    if (cfg.trackerWrites) store.upsertJob(j)
  }
  for (const { job, source } of fresh) {
    const t = classifyTitle(job.title)
    const loc = classifyLocation(job.location, job.workplaceType, '')
    if (t.excluded.length || !t.family || loc.fit === 'elsewhere') {
      run.prefiltered++
      reject(job, { exclusionReasons: [...t.excluded, ...(t.family ? [] : ['not a target engineering role family']), ...(loc.fit === 'elsewhere' ? [`location outside London (${loc.label})`] : [])], fitScore: null })
      continue
    }
    // 3. full JD where the listing lacked it (bounded by the request budget)
    let full = job
    try {
      if (http.remaining > 0) full = normalizeJob({ ...(await source.fetchJob(http, job)), id: job.id, discoveredAt: job.discoveredAt }, at)
    } catch (e) {
      err(`SOURCE_${category(e)}`)
    }
    const ev = evaluate(full, { minFitScore: cfg.minFitScore, maxJobAgeDays: cfg.maxJobAgeDays, now: at, skills: ctx.skills })
    if (ev.decision === 'REJECTED') reject(full, ev)
    else evaluated.push({ job: { ...full, ...pick(ev), evaluation: ev, descriptionFingerprint: descriptionFingerprint(full.description) }, source })
  }

  // 4. rank, then re-verify and add the best few
  const ranked = rankJobs(evaluated.map((e) => ({ ...e.job, _source: e.source })))
  const take = ranked.slice(0, cfg.maxNewQualifiedPerRun)
  const readyBacklog = store.jobs().filter((j) => ['READY_TO_TAILOR', 'TAILORING'].includes(j.status)).length
  let queueRoom = Math.max(0, Math.min(cfg.maxTailorQueuedPerRun, (cfg.maxTailorBacklog ?? 4) - readyBacklog))
  let metaSheetId = parsed?.meta?.sheetId ?? null

  for (const candidate of take) {
    const { _source: source, ...raw } = candidate
    let job = raw
    try {
      const v = await source.verifyOpen(http, job)
      job.lastVerifiedAt = at.toISOString()
      if (!v.open) {
        run.closed++
        report.candidates.push({ ...summarise(job), status: 'CLOSED' })
        continue
      }
      if (v.formQuestions) {
        // The form is known now: application ease (and so rank) may change.
        const ev = evaluate({ ...job, formQuestions: v.formQuestions }, { minFitScore: cfg.minFitScore, maxJobAgeDays: cfg.maxJobAgeDays, now: at, skills: ctx.skills })
        job = { ...job, formQuestions: v.formQuestions, ...pick(ev), evaluation: ev }
      }
    } catch (e) {
      err(`VERIFY_${category(e)}`)
      report.candidates.push({ ...summarise(job), status: 'UNVERIFIED' })
      continue // never add what could not be verified open
    }
    job = transition(job, 'QUALIFIED', { at: at.toISOString() })
    run.qualified++
    const queue = queueRoom > 0 && Boolean(job.description) && Boolean(job.applicationUrl)
    if (writable) {
      try {
        const plan = planInsert(parsed, job, { queue, now: at })
        if (!plan.ok) throw Object.assign(new Error(plan.reason), { category: 'TRACKER_MAPPING' })
        if (queue) job = transition(job, 'READY_TO_TAILOR', { at: at.toISOString() })
        job.trackerTab = parsed.main.title
        const meta = ensureMetaRequests(parsed, metaSheetId ?? undefined)
        metaSheetId = meta.sheetId
        const requests = [...(parsed.meta ? [] : meta.requests), ...insertRequests(plan), ...metaUpsertRequests(parsed, metaSheetId, job, cfg.applicationMode)]
        await ctx.google.batchUpdate(ctx.trackerId, requests)
        run.inserted++
        if (queue) {
          run.queued++
          queueRoom--
        }
        store.upsertJob({ ...job, trackerRow: plan.row + 1 })
        parsed = await loadTracker(ctx) // row positions moved; plan the next insert on fresh state
      } catch (e) {
        err(category(e))
        log(`[jobs] could not add ${job.company} — ${job.title}: ${e.message}`)
        job = { ...job, status: 'QUALIFIED' }
      }
    } else if (queue) {
      queueRoom--
      run.queued++ // would be queued
    }
    report.candidates.push({ ...summarise(job), wouldQueue: queue, rankNotes: job.evaluation?.rankNotes })
  }
  for (const rest of ranked.slice(cfg.maxNewQualifiedPerRun)) report.candidates.push({ ...summarise(rest), status: 'QUALIFIED_NOT_TAKEN', note: 'over the per-run limit' })

  if (cfg.trackerWrites) {
    store.count('discovered', run.discovered, at)
    store.count('rejected', run.rejected, at)
    store.count('qualified', run.qualified, at)
    store.count('queued', run.queued, at)
  }
  run.finishedAt = now().toISOString()
  run.requests = http.used
  return report
}

/** Tracker observations -> state changes, then the application step. */
export async function runWatch(ctx) {
  const { cfg, store, now = () => new Date(), log = () => {} } = ctx
  const at = now()
  const iso = at.toISOString()
  const run = { runId: randomUUID().slice(0, 8), kind: 'watch', startedAt: iso, finishedAt: null, tailoredObserved: 0, applicationsAttempted: 0, applicationsSubmitted: 0, needsInput: 0, promoted: 0, errorCategories: [] }
  const err = (c) => !run.errorCategories.includes(c) && run.errorCategories.push(c)
  let parsed
  try {
    parsed = await loadTracker(ctx)
  } catch (e) {
    err(category(e))
    run.finishedAt = now().toISOString()
    return { run }
  }
  if (!parsed) {
    err('TRACKER_NOT_CONNECTED')
    run.finishedAt = now().toISOString()
    return { run }
  }
  const records = trackerRecords(parsed)
  const byId = new Map(records.filter((r) => r.jobId).map((r) => [r.jobId, r]))
  const metaList = metaRecords(parsed)
  const metas = new Map(metaList.map((m) => [m.jobId, m]))

  // A lost local store is rebuilt from JARVIS_META.
  for (const [id, m] of metas) if (!store.job(id) && m.state) store.upsertJob({ id, status: m.state, company: m.company, title: m.title, location: m.location, source: m.source, sourceJobId: m.atsJobId, applicationUrl: m.applicationUrl, canonicalUrl: m.canonicalUrl, fitScore: Number(m.fitScore) || null, tailoredCvUrl: m.tailoredCvUrl || undefined, updatedAt: m.updatedAt })

  // Rows whose marker was edited away are re-linked only on an exact, unique match.
  const requests = []
  const active = new Set(store.jobs().filter((j) => ACTIVE_STATES.has(j.status)).map((j) => j.id))
  const recovered = recoverMarkers(records, metaList, active)
  run.markersRecovered = recovered.matches.size
  run.reconcileProblems = recovered.problems
  if (recovered.problems.length) err('RECONCILE_UNMATCHED')
  for (const p of recovered.problems) log(`[jobs] ${p.jobId}: not re-linked — ${p.reason}`)
  for (const [id, rec] of recovered.matches) {
    byId.set(id, rec)
    log(`[jobs] ${id}: marker missing; re-linked to ${rec.tab}!${rec.row + 1} by ${rec.recoveredBy}`)
    if (cfg.trackerWrites) {
      const plan = planRowUpdate(parsed, rec, { note: `[JARVIS:${id}] Re-linked by JARVIS ${iso.slice(0, 10)} (marker was missing; matched by ${rec.recoveredBy}).` })
      if (plan.ok) requests.push(...plan.requests)
    }
  }

  const changed = []
  const set = (job, next) => {
    store.upsertJob(next)
    changed.push(next)
    return next
  }

  for (const job0 of store.jobs().filter((j) => ACTIVE_STATES.has(j.status))) {
    let job = job0
    const rec = byId.get(job.id)
    const meta = metas.get(job.id)
    if (!rec && !meta) continue
    try {
      // The user decided: applied or voided it themselves. JARVIS stops managing it.
      if (rec && ['applied', 'void', 'rejected'].includes(rec.applicationStatus) && job.status !== 'APPLIED') {
        job = set(job, { ...advance(job, 'CLOSED', { at: iso }), closedReason: `marked ${rec.applicationStatus} in the tracker` })
        continue
      }
      const q = rec?.tailorQueue ?? ''
      const cvUrl = rec?.cvDocx || meta?.tailoredCvUrl || rec?.cvPdf || ''
      const pdfUrl = rec?.cvPdf || meta?.tailoredPdfUrl || ''
      if (['READY_TO_TAILOR', 'TAILORING', 'NEEDS_INPUT'].includes(job.status) && (q === 'tailored' || meta?.state === 'TAILORED') && cvUrl) {
        job = set(job, { ...advance(job, 'TAILORED', { at: iso, cvUrl }), tailoredPdfUrl: pdfUrl, tailoredAt: meta?.tailoredAt || rec?.lastTailored || iso })
        run.tailoredObserved++
        store.count('tailored', 1, at)
      } else if (job.status === 'READY_TO_TAILOR' && q === 'processing') {
        job = set(job, transition(job, 'TAILORING', { at: iso }))
      } else if (['READY_TO_TAILOR', 'TAILORING'].includes(job.status) && (q === 'review' || ['NEEDS_INPUT', 'TAILORING_ERROR'].includes(meta?.state))) {
        job = set(job, transition(job, 'NEEDS_INPUT', { at: iso, reason: meta?.tailoringNotes || 'CV tailoring needs your review (Tailor Queue: Review)' }))
        run.needsInput++
        store.count('needsInput', 1, at)
      } else if (job.status !== 'CLOSED' && q === 'skip') {
        job = set(job, { ...advance(job, 'CLOSED', { at: iso }), closedReason: 'skipped in the tracker' })
      } else if (job.status === 'NEEDS_INPUT' && job.resumeState === 'READY_TO_TAILOR' && q === 'ready') {
        job = set(job, transition(job, 'READY_TO_TAILOR', { at: iso }))
      }
    } catch (e) {
      err('STATE')
      log(`[jobs] ${job.id}: ${e.message}`)
    }
  }

  // Keep the tailoring backlog topped up from roles already in the tracker.
  const backlog = store.jobs().filter((j) => ['READY_TO_TAILOR', 'TAILORING'].includes(j.status)).length
  let room = Math.max(0, (cfg.maxTailorBacklog ?? 4) - backlog)
  if (cfg.trackerWrites) {
    for (const job of store.jobs().filter((j) => j.status === 'QUALIFIED').sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))) {
      if (room <= 0) break
      const rec = byId.get(job.id)
      if (!rec) continue
      const plan = planRowUpdate(parsed, rec, { queue: true })
      if (!plan.ok) continue
      requests.push(...plan.requests)
      set(job, transition(job, 'READY_TO_TAILOR', { at: iso }))
      run.promoted++
      store.count('queued', 1, at)
      room--
    }
  }

  // Applications.
  if (ctx.applier && cfg.applicationMode !== 'off') {
    const r = await ctx.applier.processQueue({ parsed, byId, at })
    run.applicationsAttempted = r.attempted
    run.applicationsSubmitted = r.submitted
    run.needsInput += r.needsInput
    requests.push(...r.requests)
    changed.push(...r.changed)
    for (const c of r.errorCategories) err(c)
  }

  if (cfg.trackerWrites && (requests.length || changed.length)) {
    try {
      const metaSheet = ensureMetaRequests(parsed)
      const metaReqs = parsed.meta ? [] : metaSheet.requests
      const uniq = new Map(changed.map((j) => [j.id, j]))
      for (const j of uniq.values()) metaReqs.push(...metaUpsertRequests(parsed, metaSheet.sheetId, j, cfg.applicationMode))
      await ctx.google.batchUpdate(ctx.trackerId, [...requests, ...metaReqs])
    } catch (e) {
      err(category(e))
      log(`[jobs] tracker update failed: ${e.message}`)
    }
  }
  run.finishedAt = now().toISOString()
  return { run }
}

function pick(ev) {
  return {
    fitScore: ev.fitScore ?? null,
    rankScore: ev.rankScore ?? null,
    fitReasons: ev.fitReasons ?? [],
    exclusionReasons: ev.exclusionReasons ?? [],
    experienceRequired: ev.experience?.requiredYears ?? null,
    roleFamily: ev.roleFamily ?? null,
    applicationDifficulty: ev.applicationDifficulty ?? 'UNKNOWN',
    interviewDifficulty: ev.interviewDifficulty ?? 'UNKNOWN',
  }
}

/** A report line: why a role passed or failed. No JD text. */
export function summarise(j) {
  return {
    id: j.id,
    company: j.company,
    title: j.title,
    location: j.location,
    source: j.source,
    url: j.applicationUrl,
    postedDate: j.postedDate,
    status: j.status,
    fitScore: j.fitScore,
    rankScore: j.rankScore,
    applicationDifficulty: j.applicationDifficulty,
    interviewDifficulty: j.interviewDifficulty,
    fitReasons: j.fitReasons,
    exclusionReasons: j.exclusionReasons,
  }
}
