/**
 * Job source adapters. Public, documented, unauthenticated job-board APIs
 * only, plus schema.org JobPosting data that employers publish on their own
 * career pages for search engines. No LinkedIn, no logged-in pages, no
 * CAPTCHA handling, no private APIs.
 *
 * Each adapter:
 *   discover(http)          -> raw job objects (see job.mjs normalizeJob)
 *   fetchJob(http, job)     -> the job with its full description (if the
 *                              listing did not already carry it)
 *   verifyOpen(http, job)   -> { open: boolean }
 *
 * Board names are validated and URLs are built from fixed templates, so the
 * sources file can name a board but never supply an arbitrary endpoint (the
 * JSON-LD adapter takes https career-page URLs, checked by safeUrl).
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { htmlToText } from './text.mjs'
import { safeUrl } from '../tools.mjs'

const BOARD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const enc = encodeURIComponent

const iso = (v) => {
  if (v == null || v === '') return null
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// --- Greenhouse (boards-api.greenhouse.io) ----------------------------------

const formQuestions = (j) => {
  const questions = Array.isArray(j.questions) ? j.questions : []
  const freeTextRequired = questions.filter((q) => q.required && (q.fields ?? []).some((f) => f.type === 'textarea') && !/cover letter|resume|cv/i.test(q.label ?? '')).length
  return { total: questions.length, freeTextRequired }
}

export function greenhouse(board, { company: named } = {}) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${enc(board)}`
  const toJob = (j, company) => ({
    title: j.title,
    company: named || company || j.company_name || board,
    location: j.location?.name ?? '',
    source: `greenhouse:${board}`,
    sourceJobId: String(j.id),
    sourceUrl: j.absolute_url,
    applicationUrl: j.absolute_url,
    postedDate: iso(j.first_published ?? j.updated_at),
    description: j.content ? htmlToText(j.content) : '',
  })
  return {
    kind: 'greenhouse',
    id: `greenhouse:${board}`,
    async discover(http) {
      const [meta, data] = [await http.json(base).catch(() => ({})), await http.json(`${base}/jobs?content=true`)]
      if (data.notFound) throw Object.assign(new Error('board not found'), { category: 'NOT_FOUND' })
      return (data.jobs ?? []).map((j) => toJob(j, meta?.name))
    },
    async fetchJob(http, job) {
      if (job.description) return job
      const j = await http.json(`${base}/jobs/${enc(job.sourceJobId)}?questions=true`)
      if (j.notFound) return { ...job, open: false }
      return { ...job, description: htmlToText(j.content ?? ''), formQuestions: formQuestions(j) }
    },
    /** One request answers both "still open?" and "how long is the form?". */
    async verifyOpen(http, job) {
      const j = await http.json(`${base}/jobs/${enc(job.sourceJobId)}?questions=true`)
      return j.notFound || !j.id ? { open: false } : { open: true, formQuestions: formQuestions(j) }
    },
  }
}

// --- Lever (api.lever.co postings API) --------------------------------------

export function lever(site, { region = 'global', company } = {}) {
  const host = region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co'
  const base = `${host}/v0/postings/${enc(site)}`
  const toJob = (p) => {
    const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content ?? '')}`).join('\n\n')
    const salary = p.salaryRange && Number.isFinite(p.salaryRange.min) && /year|annual/i.test(p.salaryRange.interval ?? 'per-year')
      ? { min: p.salaryRange.min, max: p.salaryRange.max, currency: p.salaryRange.currency }
      : null
    return {
      title: p.text,
      company: company || site,
      location: [p.categories?.location, ...(p.categories?.allLocations ?? [])].filter(Boolean).join(' / '),
      workplaceType: { onsite: 'onsite', hybrid: 'hybrid', remote: 'remote' }[p.workplaceType] ?? '',
      source: `lever:${site}`,
      sourceJobId: p.id,
      sourceUrl: p.hostedUrl,
      applicationUrl: p.applyUrl ?? p.hostedUrl,
      postedDate: iso(p.createdAt),
      salary: salary?.currency === 'GBP' ? salary : null,
      description: [p.descriptionPlain ?? htmlToText(p.description ?? ''), lists, p.additionalPlain ?? ''].filter(Boolean).join('\n\n'),
    }
  }
  return {
    kind: 'lever',
    id: `lever:${site}`,
    async discover(http) {
      const data = await http.json(`${base}?mode=json`)
      if (data.notFound) throw Object.assign(new Error('site not found'), { category: 'NOT_FOUND' })
      return (Array.isArray(data) ? data : []).map(toJob)
    },
    fetchJob: async (_http, job) => job,
    async verifyOpen(http, job) {
      const p = await http.json(`${base}/${enc(job.sourceJobId)}?mode=json`)
      return { open: !p.notFound && Boolean(p.id) }
    },
  }
}

// --- Ashby (posting-api job board) ------------------------------------------

export function ashby(board, { company } = {}) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${enc(board)}?includeCompensation=true`
  const toJob = (j) => {
    const comp = j.compensation?.summaryComponents?.find?.((c) => c.compensationType === 'Salary' && c.currencyCode === 'GBP' && /year/i.test(c.interval ?? ''))
    return {
      title: j.title,
      company: company || board,
      location: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean).join(' / '),
      workplaceType: j.isRemote ? 'remote' : { OnSite: 'onsite', Hybrid: 'hybrid', Remote: 'remote' }[j.workplaceType] ?? '',
      source: `ashby:${board}`,
      sourceJobId: j.id,
      sourceUrl: j.jobUrl,
      applicationUrl: j.applyUrl ?? j.jobUrl,
      postedDate: iso(j.publishedAt),
      salary: comp && Number.isFinite(comp.minValue) ? { min: comp.minValue, max: comp.maxValue ?? comp.minValue, currency: 'GBP' } : null,
      description: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ''),
    }
  }
  return {
    kind: 'ashby',
    id: `ashby:${board}`,
    async discover(http) {
      const data = await http.json(url)
      if (data.notFound) throw Object.assign(new Error('board not found'), { category: 'NOT_FOUND' })
      return (data.jobs ?? []).filter((j) => j.isListed !== false).map(toJob)
    },
    fetchJob: async (_http, job) => job,
    async verifyOpen(http, job) {
      // No public per-job endpoint: a listed job is an open job.
      const data = await http.json(url)
      return { open: !data.notFound && (data.jobs ?? []).some((j) => j.id === job.sourceJobId && j.isListed !== false) }
    },
  }
}

// --- Workable (public widget API) -------------------------------------------

export function workable(account, { company: named } = {}) {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${enc(account)}?details=true`
  const toJob = (j, company) => ({
    title: j.title,
    company: named || company || account,
    location: [j.city, j.state, j.country].filter(Boolean).join(', ') + (j.telecommuting ? ' (remote)' : ''),
    workplaceType: j.telecommuting ? 'remote' : '',
    source: `workable:${account}`,
    sourceJobId: j.shortcode,
    sourceUrl: j.url ?? j.shortlink,
    applicationUrl: j.application_url ?? j.url,
    postedDate: iso(j.published_on ?? j.created_at),
    description: htmlToText(j.description ?? ''),
  })
  return {
    kind: 'workable',
    id: `workable:${account}`,
    async discover(http) {
      const data = await http.json(url)
      if (data.notFound) throw Object.assign(new Error('account not found'), { category: 'NOT_FOUND' })
      return (data.jobs ?? []).map((j) => toJob(j, data.name))
    },
    fetchJob: async (_http, job) => job,
    async verifyOpen(http, job) {
      const data = await http.json(url)
      return { open: !data.notFound && (data.jobs ?? []).some((j) => j.shortcode === job.sourceJobId) }
    },
  }
}

// --- schema.org JobPosting on an employer's own career page ----------------

/** Every JobPosting object in a page's JSON-LD blocks. */
export function jobPostingsFromHtml(html) {
  const out = []
  for (const m of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data
    try {
      data = JSON.parse(m[1].trim())
    } catch {
      continue
    }
    const stack = [data]
    while (stack.length) {
      const x = stack.pop()
      if (Array.isArray(x)) stack.push(...x)
      else if (x && typeof x === 'object') {
        if (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))) out.push(x)
        if (x['@graph']) stack.push(x['@graph'])
      }
    }
  }
  return out
}

export function careerPage(pageUrl) {
  const href = safeUrl(pageUrl)
  if (!href || !href.startsWith('https://')) throw new Error(`career page must be an https URL: ${String(pageUrl).slice(0, 80)}`)
  const host = new URL(href).hostname
  const toJob = (p, fallbackUrl) => {
    const addr = [].concat(p.jobLocation ?? []).map((l) => l?.address ?? {})
    const location = addr.map((a) => [a.addressLocality, a.addressRegion, a.addressCountry?.name ?? a.addressCountry].filter(Boolean).join(', ')).join(' / ')
    const pay = p.baseSalary?.value
    const salary = p.baseSalary?.currency === 'GBP' && pay && /year/i.test(pay.unitText ?? 'YEAR') && Number.isFinite(Number(pay.minValue ?? pay.value))
      ? { min: Number(pay.minValue ?? pay.value), max: Number(pay.maxValue ?? pay.minValue ?? pay.value), currency: 'GBP' }
      : null
    const url = safeUrl(p.url) ?? fallbackUrl
    return {
      title: htmlToText(p.title ?? ''),
      company: p.hiringOrganization?.name ?? host,
      location: location || (p.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''),
      workplaceType: p.jobLocationType === 'TELECOMMUTE' ? 'remote' : '',
      source: `careers:${host}`,
      sourceJobId: String(p.identifier?.value ?? p.identifier ?? '') || '',
      sourceUrl: url,
      applicationUrl: url,
      postedDate: iso(p.datePosted),
      salary,
      description: htmlToText(p.description ?? ''),
      open: p.validThrough ? Date.parse(p.validThrough) > Date.now() : true,
    }
  }
  return {
    kind: 'careers',
    id: `careers:${host}`,
    async discover(http) {
      const r = await http.html(href)
      if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { category: 'HTTP' })
      return jobPostingsFromHtml(r.text).map((p) => toJob(p, href))
    },
    fetchJob: async (_http, job) => job,
    async verifyOpen(http, job) {
      const r = await http.html(job.applicationUrl || href)
      if (r.status === 404 || r.status === 410) return { open: false }
      const postings = jobPostingsFromHtml(r.text)
      if (!postings.length) return { open: r.status === 200 && !/no longer (?:available|accepting)|position (?:has been )?filled|job (?:has )?(?:closed|expired)/i.test(r.text) }
      return { open: postings.some((p) => !p.validThrough || Date.parse(p.validThrough) > Date.now()) }
    },
  }
}

// --- configuration ----------------------------------------------------------

/**
 * jarvis.jobs.sources.json:
 * { "greenhouse": ["monzo"], "lever": ["palantir"], "leverEu": [], "ashby": ["elevenlabs"],
 *   "workable": ["homey"], "careers": ["https://example.com/careers"] }
 */
export function buildSources(config) {
  const out = []
  const errors = []
  // An entry is a board name, or { "board": "relay", "company": "Relay Technologies" }.
  const boards = (key, make) => {
    for (const entry of [].concat(config?.[key] ?? [])) {
      const b = typeof entry === 'string' ? entry : entry?.board
      const company = typeof entry?.company === 'string' ? entry.company.trim().slice(0, 80) : undefined
      if (typeof b === 'string' && BOARD.test(b)) out.push(make(b, { company }))
      else errors.push(`${key}: "${String(b).slice(0, 40)}" is not a valid board name`)
    }
  }
  boards('greenhouse', greenhouse)
  boards('lever', (b, o) => lever(b, o))
  boards('leverEu', (b, o) => lever(b, { ...o, region: 'eu' }))
  boards('ashby', ashby)
  boards('workable', workable)
  for (const u of [].concat(config?.careers ?? [])) {
    try {
      out.push(careerPage(u))
    } catch (err) {
      errors.push(err.message)
    }
  }
  return { sources: out, errors }
}

export function loadSourcesFile(root, file) {
  const path = isAbsolute(file) ? file : join(root, file)
  if (!existsSync(path)) return { sources: [], errors: [], missing: true, path }
  try {
    return { ...buildSources(JSON.parse(readFileSync(path, 'utf8'))), path }
  } catch (err) {
    return { sources: [], errors: [`${file}: ${err.message}`], path }
  }
}
