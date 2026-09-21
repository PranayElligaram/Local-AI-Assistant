/**
 * Bounded HTTP for job sources. Every run gets a request budget; every request
 * has a timeout and a size cap; https only; at most one retry, and only for a
 * network error or 5xx/429. A blocked source (401/403, a CAPTCHA page) is
 * reported as blocked and left alone: no evasion, no retries against it.
 */

export class BudgetExceeded extends Error {
  constructor() {
    super('source request budget for this run is spent')
    this.category = 'BUDGET'
  }
}

export class SourceBlocked extends Error {
  constructor(status) {
    super(`source refused automated access (${status})`)
    this.category = 'BLOCKED'
  }
}

const UA = 'JARVIS-job-agent/1.0 (personal job search; low volume)'

/**
 * @param {{ maxRequests: number, fetchFn?: typeof fetch, timeoutMs?: number, maxBytes?: number, sleep?: (ms:number)=>Promise<void> }} o
 */
export function createHttp({ maxRequests, fetchFn = fetch, timeoutMs = 15_000, maxBytes = 4 * 1024 * 1024, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let used = 0
  // One run never fetches the same URL twice (a board listed at discovery is
  // reused to verify its jobs moments later).
  const cache = new Map()

  async function once(url, accept) {
    if (used >= maxRequests) throw new BudgetExceeded()
    used++
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetchFn(url, { headers: { 'user-agent': UA, accept }, signal: ctl.signal, redirect: 'follow' })
      const len = Number(res.headers?.get?.('content-length') ?? 0)
      if (len > maxBytes) throw Object.assign(new Error('response too large'), { category: 'TOO_LARGE' })
      const text = await res.text()
      if (text.length > maxBytes) throw Object.assign(new Error('response too large'), { category: 'TOO_LARGE' })
      return { status: res.status, text }
    } finally {
      clearTimeout(timer)
    }
  }

  async function get(url, { accept = 'application/json' } = {}) {
    if (!/^https:\/\//i.test(url)) throw new Error('job sources must be https')
    let r
    try {
      r = await once(url, accept)
    } catch (err) {
      if (err instanceof BudgetExceeded || err.category === 'TOO_LARGE') throw err
      await sleep(1500)
      r = await once(url, accept)
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(3000)
      r = await once(url, accept)
    }
    if (r.status === 401 || r.status === 403) throw new SourceBlocked(r.status)
    if (/captcha|cf-chl|are you a robot|access denied/i.test(r.text.slice(0, 3000)) && accept.includes('html')) throw new SourceBlocked('challenge page')
    return r
  }

  return {
    get,
    async json(url) {
      if (!cache.has(url)) cache.set(url, get(url))
      let r
      try {
        r = await cache.get(url)
      } catch (err) {
        cache.delete(url)
        throw err
      }
      if (r.status === 404) return { notFound: true }
      if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { category: 'HTTP' })
      try {
        return JSON.parse(r.text)
      } catch {
        throw Object.assign(new Error('malformed JSON'), { category: 'PARSE' })
      }
    },
    async html(url) {
      const r = await get(url, { accept: 'text/html' })
      return r
    },
    get used() {
      return used
    },
    get remaining() {
      return Math.max(0, maxRequests - used)
    },
  }
}
