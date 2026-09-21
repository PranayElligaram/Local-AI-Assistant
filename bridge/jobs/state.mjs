/**
 * The job lifecycle, as an explicit state machine.
 *
 * Every change of state goes through `transition()`. The normal autonomous
 * path is DISCOVERED -> QUALIFIED -> READY_TO_TAILOR -> TAILORING -> TAILORED
 * -> APPLYING -> APPLIED, and there is no shortcut: a job cannot become APPLIED
 * without first being TAILORED and then APPLYING, and APPLYING -> APPLIED
 * additionally requires submission evidence (see apply/verify.mjs).
 *
 * NEEDS_INPUT is a pause, not a destination: it remembers the state it paused
 * from (`resumeState`) so answering the question puts the job back where it was
 * instead of losing its place in the queue.
 */

export const STATES = Object.freeze([
  'DISCOVERED',
  'REJECTED',
  'QUALIFIED',
  'READY_TO_TAILOR',
  'TAILORING',
  'TAILORED',
  'APPLYING',
  'APPLIED',
  'NEEDS_INPUT',
  'APPLICATION_FAILED',
  'CLOSED',
  'WITHDRAWN',
])

/** Allowed moves. WITHDRAWN is reachable only by the user, never by this agent. */
const NEXT = {
  DISCOVERED: ['QUALIFIED', 'REJECTED', 'CLOSED'],
  REJECTED: [],
  QUALIFIED: ['READY_TO_TAILOR', 'CLOSED', 'REJECTED'],
  READY_TO_TAILOR: ['TAILORING', 'TAILORED', 'NEEDS_INPUT', 'CLOSED'],
  TAILORING: ['TAILORED', 'NEEDS_INPUT', 'READY_TO_TAILOR', 'CLOSED'],
  TAILORED: ['APPLYING', 'NEEDS_INPUT', 'CLOSED'],
  APPLYING: ['APPLIED', 'NEEDS_INPUT', 'APPLICATION_FAILED', 'TAILORED', 'CLOSED'],
  APPLIED: ['CLOSED'],
  NEEDS_INPUT: ['READY_TO_TAILOR', 'TAILORING', 'TAILORED', 'APPLYING', 'CLOSED'],
  APPLICATION_FAILED: ['TAILORED', 'NEEDS_INPUT', 'CLOSED'],
  CLOSED: [],
  WITHDRAWN: [],
}

export function canTransition(from, to) {
  return Boolean(NEXT[from]?.includes(to))
}

/**
 * Returns a new job object in state `to`, or throws. `meta` carries the
 * evidence a guarded transition needs.
 *
 * @param {object} job
 * @param {string} to
 * @param {{ at?: string, reason?: string, evidence?: object, cvUrl?: string }} [meta]
 */
export function transition(job, to, meta = {}) {
  const from = job.status
  if (!STATES.includes(to)) throw new Error(`unknown state ${to}`)
  if (to === 'WITHDRAWN') throw new Error('withdrawing is not something this agent does')
  if (!canTransition(from, to)) throw new Error(`invalid transition ${from} -> ${to}`)
  // NEEDS_INPUT may only resume to the state it paused from (or close).
  if (from === 'NEEDS_INPUT' && to !== 'CLOSED' && job.resumeState && to !== job.resumeState) {
    throw new Error(`NEEDS_INPUT resumes to ${job.resumeState}, not ${to}`)
  }
  if (to === 'APPLYING' && !(job.tailoredCvUrl || meta.cvUrl)) throw new Error('cannot apply without a tailored CV')
  if (to === 'APPLIED' && !meta.evidence?.verified) throw new Error('APPLIED requires verified submission evidence')
  if (to === 'NEEDS_INPUT' && !meta.reason) throw new Error('NEEDS_INPUT requires a reason')

  const at = meta.at ?? new Date().toISOString()
  const next = { ...job, status: to, updatedAt: at, history: [...(job.history ?? []), { from, to, at }].slice(-20) }
  if (to === 'NEEDS_INPUT') {
    next.resumeState = from
    next.needsInput = { reason: String(meta.reason).slice(0, 300), question: meta.question ? String(meta.question).slice(0, 300) : '', at }
  } else if (from === 'NEEDS_INPUT') {
    next.resumeState = null
    next.needsInput = null
  }
  if (to === 'APPLIED') {
    next.appliedAt = at
    next.submissionEvidence = sanitizeEvidence(meta.evidence)
  }
  if (meta.cvUrl) next.tailoredCvUrl = meta.cvUrl
  return next
}

/** A small, non-sensitive record: what proved the submission, never page HTML. */
export function sanitizeEvidence(e = {}) {
  return {
    verified: Boolean(e.verified),
    kind: String(e.kind ?? '').slice(0, 40),
    detail: String(e.detail ?? '').replace(/\s+/g, ' ').slice(0, 160),
    confirmationId: e.confirmationId ? String(e.confirmationId).slice(0, 60) : '',
    url: e.url ? String(e.url).slice(0, 300) : '',
    at: e.at ?? new Date().toISOString(),
  }
}

/** Queues the watcher cares about, by state. */
export const ACTIVE_STATES = new Set(['QUALIFIED', 'READY_TO_TAILOR', 'TAILORING', 'TAILORED', 'APPLYING', 'NEEDS_INPUT', 'APPLICATION_FAILED'])
