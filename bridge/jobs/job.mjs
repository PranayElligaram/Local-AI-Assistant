/**
 * The normalised job record every source adapter produces, and the
 * deduplication keys derived from it.
 *
 * @typedef {object} Job
 * @property {string} id                  stable JARVIS id, derived from the strongest identity signal
 * @property {string} title
 * @property {string} company
 * @property {string} location
 * @property {'onsite'|'hybrid'|'remote'|''} workplaceType
 * @property {{min:number,max:number,currency:string}|null} salary
 * @property {string|null} currency
 * @property {string} source              e.g. "greenhouse:monzo"
 * @property {string} sourceJobId         the ATS's own id
 * @property {string} sourceUrl
 * @property {string} canonicalUrl        the employer/ATS posting, tracking parameters removed
 * @property {string} applicationUrl
 * @property {string|null} postedDate     ISO
 * @property {string} discoveredAt        ISO
 * @property {string} lastVerifiedAt      ISO
 * @property {string} description         full plain-text JD
 * @property {string[]} requirements
 * @property {number|null} experienceRequired
 * @property {string|null} roleFamily
 * @property {number|null} fitScore
 * @property {string[]} fitReasons
 * @property {string[]} exclusionReasons
 * @property {'EASY'|'MEDIUM'|'HARD'|'UNKNOWN'} applicationDifficulty
 * @property {'LIGHT'|'MODERATE'|'HEAVY'|'UNKNOWN'} interviewDifficulty
 * @property {string} status              see state.mjs
 */

import { fnv1a, normalizeKey } from './text.mjs'
import { safeUrl } from '../tools.mjs'

// gh_jid is NOT here: on employer-hosted Greenhouse pages it is the job's id.
const TRACKING = /^(utm_[a-z]+|gh_src|source|src|ref|referrer|lever-source(?:\[\])?|lever-origin|trk|trackingid|refid|mc_[a-z]+|fbclid|gclid|_hs[a-z]+|jobsource|ashby_jid)$/i

/** http(s) URL with tracking parameters and fragments removed; null if unsafe. */
export function canonicalUrl(raw) {
  const href = safeUrl(raw)
  if (!href) return null
  const u = new URL(href)
  u.hash = ''
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key)
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '')
  return u.toString()
}

/** ATS job id from a known URL shape, when the adapter didn't supply one. */
export function atsIdFromUrl(raw) {
  const href = safeUrl(raw)
  if (!href) return null
  const u = new URL(href)
  const h = u.hostname.toLowerCase()
  const p = u.pathname
  let m
  if (/greenhouse\.io$/.test(h) && (m = /\/jobs\/(\d+)/.exec(p))) return `greenhouse:${m[1]}`
  if (u.searchParams.get('gh_jid')) return `greenhouse:${u.searchParams.get('gh_jid')}`
  if (/lever\.co$/.test(h) && (m = /\/([0-9a-f-]{36})/.exec(p))) return `lever:${m[1]}`
  if (/ashbyhq\.com$/.test(h) && (m = /\/([0-9a-f-]{36})/.exec(p))) return `ashby:${m[1]}`
  if (/workable\.com$/.test(h) && (m = /\/j\/([0-9A-F]{6,})/i.exec(p))) return `workable:${m[1].toUpperCase()}`
  if (/teamtailor\.com$/.test(h) && (m = /\/jobs\/(\d+)/.exec(p))) return `teamtailor:${m[1]}`
  return null
}

const COMPANY_SUFFIX = /\b(ltd|limited|plc|llp|inc|incorporated|llc|gmbh|group|holdings|uk|technologies|technology|labs?)\b/g
export const companyKey = (c) => normalizeKey(c).replace(COMPANY_SUFFIX, ' ').replace(/\s+/g, ' ').trim()
export const titleKey = (t) =>
  normalizeKey(t)
    .replace(/\b(m f d|f m d|all genders|hybrid|remote|london|uk|2026|2027|intake|programme|program|scheme)\b/g, ' ')
    .replace(/\bjr\b/g, 'junior')
    .replace(/\bgrad\b/g, 'graduate')
    .replace(/\bsr\b/g, 'senior')
    .replace(/\s+/g, ' ')
    .trim()
export const locationKey = (l) => (/\blondon\b/i.test(String(l)) ? 'london' : normalizeKey(l).split(' ').slice(0, 2).join(' '))

/** A description fingerprint that survives whitespace and markup differences. */
export const descriptionFingerprint = (d) => {
  // The WHOLE description: employers share long boilerplate, and hashing only
  // the opening would make every role at one company look the same.
  const words = normalizeKey(d).split(' ').filter((w) => w.length > 3)
  return words.length < 40 ? null : fnv1a(words.slice(0, 6000).join(' '))
}

/** Every identity signal a job carries. */
export function dedupeKeys(job) {
  const ats = job.sourceJobId && job.source ? `${String(job.source).split(':')[0]}:${job.sourceJobId}` : atsIdFromUrl(job.applicationUrl) ?? atsIdFromUrl(job.canonicalUrl)
  const urls = [job.canonicalUrl, job.applicationUrl, job.sourceUrl].map(canonicalUrl).filter(Boolean)
  const ctl = job.company && job.title ? `${companyKey(job.company)}|${titleKey(job.title)}|${locationKey(job.location)}` : null
  return { ats, urls: [...new Set(urls)], ctl, fingerprint: job.description ? descriptionFingerprint(job.description) : null }
}

/** Stable id: the ATS id if there is one, else company/title/location. */
export function jobId(job) {
  const k = dedupeKeys(job)
  return `jb_${fnv1a(k.ats ?? k.ctl ?? k.urls[0] ?? JSON.stringify([job.company, job.title]))}`
}

/**
 * An index over known jobs (tracker rows, meta rows, the local store) that
 * answers "have we seen this vacancy?". Any one strong signal is enough:
 * the ATS id, a canonical URL, company+title+location, or the same full
 * description at the same company.
 */
export class DedupeIndex {
  constructor() {
    this.ats = new Map()
    this.urls = new Map()
    this.ctl = new Map()
    this.ctNoLocation = new Map()
    this.fp = new Map()
  }

  add(job, ref = job.id) {
    const k = dedupeKeys(job)
    if (k.ats) this.ats.set(k.ats, ref)
    for (const u of k.urls) this.urls.set(u, ref)
    if (k.ctl) this.ctl.set(k.ctl, ref)
    // A tracker row with no location (some tabs have no location column)
    // matches on company and title alone.
    if (job.company && job.title && !String(job.location ?? '').trim()) this.ctNoLocation.set(`${companyKey(job.company)}|${titleKey(job.title)}`, ref)
    if (k.fingerprint && job.company) this.fp.set(`${companyKey(job.company)}|${k.fingerprint}`, ref)
    return this
  }

  /** { ref, by } of the known job this duplicates, or null. */
  match(job) {
    const k = dedupeKeys(job)
    if (k.ats && this.ats.has(k.ats)) return { ref: this.ats.get(k.ats), by: 'ats-id' }
    for (const u of k.urls) if (this.urls.has(u)) return { ref: this.urls.get(u), by: 'url' }
    if (k.ctl && this.ctl.has(k.ctl)) return { ref: this.ctl.get(k.ctl), by: 'company-title-location' }
    const ct = job.company && job.title ? `${companyKey(job.company)}|${titleKey(job.title)}` : null
    if (ct && this.ctNoLocation.has(ct)) return { ref: this.ctNoLocation.get(ct), by: 'company-title' }
    if (k.fingerprint && job.company) {
      const key = `${companyKey(job.company)}|${k.fingerprint}`
      if (this.fp.has(key)) return { ref: this.fp.get(key), by: 'description' }
    }
    return null
  }
}

/** Fill the defaults and derived fields every downstream step relies on. */
export function normalizeJob(raw, now = new Date()) {
  const at = now.toISOString()
  const job = {
    title: String(raw.title ?? '').trim().slice(0, 200),
    company: String(raw.company ?? '').trim().slice(0, 120),
    location: String(raw.location ?? '').trim().slice(0, 200),
    workplaceType: ['onsite', 'hybrid', 'remote'].includes(raw.workplaceType) ? raw.workplaceType : '',
    salary: raw.salary ?? null,
    currency: raw.currency ?? raw.salary?.currency ?? null,
    source: String(raw.source ?? 'unknown'),
    sourceJobId: raw.sourceJobId ? String(raw.sourceJobId) : '',
    sourceUrl: canonicalUrl(raw.sourceUrl) ?? '',
    canonicalUrl: canonicalUrl(raw.canonicalUrl ?? raw.sourceUrl) ?? '',
    applicationUrl: canonicalUrl(raw.applicationUrl ?? raw.canonicalUrl ?? raw.sourceUrl) ?? '',
    postedDate: raw.postedDate && !Number.isNaN(Date.parse(raw.postedDate)) ? new Date(raw.postedDate).toISOString() : null,
    discoveredAt: raw.discoveredAt ?? at,
    lastVerifiedAt: raw.lastVerifiedAt ?? at,
    description: String(raw.description ?? ''),
    requirements: Array.isArray(raw.requirements) ? raw.requirements.slice(0, 40) : [],
    formQuestions: raw.formQuestions ?? null,
    experienceRequired: null,
    roleFamily: null,
    fitScore: null,
    rankScore: null,
    fitReasons: [],
    exclusionReasons: [],
    applicationDifficulty: 'UNKNOWN',
    interviewDifficulty: 'UNKNOWN',
    status: 'DISCOVERED',
    open: raw.open !== false,
  }
  job.id = raw.id ?? jobId(job)
  return job
}
