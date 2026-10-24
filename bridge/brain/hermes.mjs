/**
 * Hermes Agent adapter for JARVIS. Talks only to a loopback Hermes gateway
 * (the API server platform, `hermes gateway`), never to a remote host.
 *
 * Hermes performs its OWN tool loop; this adapter never forwards JARVIS tool
 * schemas to it. Before every turn the live api_server tool inventory
 * (GET /v1/toolsets) is checked, and the turn is refused if Hermes could run
 * anything beyond the reviewed allowlist - so widening Hermes' config can never
 * silently widen what a spoken request can do on this machine.
 *
 * Conversation state: Hermes owns it. Each JARVIS conversation is a Hermes
 * session addressed by X-Hermes-Session-Id, whose history Hermes loads from its
 * own state.db; JARVIS sends only its system prompt and the new user message,
 * so history is never sent twice. JARVIS' short in-memory transcript is used
 * only by the local Ollama fallback. A session rotates after an idle period or
 * a number of turns (which also bounds prompt size, and so latency), and is
 * persisted so a JARVIS restart resumes the same conversation.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BrainError } from './provider.mjs'

/** Read-only retrieval. Anything else enabled for api_server blocks the turn. */
export const HERMES_SAFE_TOOLS = Object.freeze(['web_search', 'web_extract'])
const WEB_TOOLS = new Set(['web_search', 'web_extract'])

/**
 * How long a PASSING tool-policy check stands. GET /v1/toolsets costs Hermes
 * ~0.45 s (measured 2026-10-16), and it used to run in series before every
 * answer. The check is still made before the first turn, refreshed on every
 * wake word (while the question is still being spoken) and by health checks;
 * a failing verdict is never reused. The inventory only changes when the
 * Hermes config does, so this bounds the exposure to a config change at
 * POLICY_MAX_AGE_MS.
 */
export const POLICY_MAX_AGE_MS = 30_000
/** /api/model/options is informational and costs ~0.9 s of gateway time. */
const REPORTED_MAX_AGE_MS = 10 * 60_000

/** Appended to the JARVIS system prompt, describing what is actually possible. */
export function hermesSystemAddendum({ web = false } = {}) {
  return [
    'You are the reasoning brain behind the JARVIS voice assistant.',
    'Desktop actions such as opening applications or websites, the clock and system controls are handled by JARVIS itself before a request reaches you. You cannot operate this computer: never say you sent, changed, saved or deleted anything, or opened a website or file.',
    'One exception: when the user asks you to open or start an installed application, reply with exactly "Opening <application name>." and nothing else; JARVIS checks the name against the installed applications and opens it, or tells the user it could not.',
    web
      ? [
        'Your own knowledge is out of date. You MUST call web_search before answering any question about something that changes over time - the latest or newest version, release or model of anything, recent events, news, sports results, prices, weather, or who currently holds a role - and answer only from what it returns. Never answer such a question from memory.',
        'Answer timeless general knowledge and explanations directly, without searching.',
        'Only when you actually used a tool for this answer, mention where the information came from in a few words; never claim a source or a search otherwise. If a search fails or finds nothing, say so plainly.',
      ].join('\n')
      : 'You have no web access right now. For live information such as news, prices or recent developments, say you cannot look it up at the moment instead of guessing.',
  ].join('\n')
}

/**
 * The newest user turn only: Hermes holds the history for its own session.
 * With a `persona`, the caller's system messages (written for the local
 * Ollama brain and its JARVIS tool schemas) are replaced, not appended to.
 */
export function hermesMessages(messages = [], { persona = '', addendum = '', web = false } = {}) {
  const system = persona
    ? [persona]
    : messages.filter((m) => m?.role === 'system' && typeof m.content === 'string' && m.content.trim()).map((m) => m.content)
  if (addendum) system.push(addendum)
  const user = [...messages].reverse().find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim())
  return [
    ...(system.length ? [{ role: 'system', content: system.join('\n\n') }] : []),
    ...(user ? [{ role: 'user', content: web && needsCurrentFacts(user.content) ? `${user.content}\n${SEARCH_NUDGE}` : user.content }] : []),
  ]
}

/**
 * Questions whose answer changes over time. The local 4B model ignores the
 * system prompt's "search first" rule about half the time (measured
 * 2026-10-16: 3/8 current-fact questions searched with Hermes' own guidance,
 * 4/8 with JARVIS's) and then says "according to the search" anyway. A line
 * at the END of the user turn is obeyed far more reliably, and unlike a
 * per-turn system prompt it leaves the cached prompt prefix intact. A false
 * positive costs one unnecessary search, never a made-up answer.
 */
const CURRENT_FACTS = /\b(latest|newest|current(ly)?|recent(ly)?|today|tonight|tomorrow|yesterday|this (week|month|year|season)|right now|at the moment|news|headlines?|price|prices|cost of|stock|weather|forecast|temperature|score|scores|won|winner|standings|election|released?|release date|version|update)\b/i
export const needsCurrentFacts = (text) => CURRENT_FACTS.test(String(text ?? ''))
export const SEARCH_NUDGE = '(JARVIS: this depends on current information - call web_search first and answer only from its results.)'

/**
 * The opening exchange of every primed session. The local model's recurrent
 * layers can only resume from the end of a previous exchange, so a session
 * whose first exchange already happened answers its first REAL question
 * about 6x sooner (measured 13.5 s -> 2.1 s on this machine).
 */
export const PRIMING_MESSAGE = 'JARVIS voice session started. Reply with the single word: Ready.'

/** Hermes-side errors are already redacted; keep them short and single-line. */
const brief = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)

const newSessionId = () => `jarvis_${Date.now()}_${randomBytes(4).toString('hex')}`

export class HermesBrain {
  constructor({ url = 'http://127.0.0.1:8642/v1', key, model = 'hermes-agent',
    sessionKey = 'jarvis:desktop:primary', connectTimeoutMs = 3000,
    responseTimeoutMs = 180_000, maxTokens = 256,
    sessionFile = null, sessionIdleMs = 30 * 60_000, sessionMaxTurns = 24,
    persona = '', prime = true, policyMaxAgeMs = POLICY_MAX_AGE_MS,
    backend = null, fetch: transport = globalThis.fetch, now = Date.now,
  } = {}) {
    this.id = 'hermes'
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !/\/v1\/?$/.test(parsed.pathname)) {
      throw new Error('Hermes URL must be a local http://127.0.0.1:<port>/v1 endpoint')
    }
    this.url = parsed.href.replace(/\/+$/, '')
    this.baseUrl = this.url.slice(0, -3)
    this.key = key?.trim() ?? ''
    this.model = model
    this.sessionKey = sessionKey
    this.connectTimeoutMs = connectTimeoutMs
    this.responseTimeoutMs = responseTimeoutMs
    this.maxTokens = maxTokens
    this.fetch = transport
    this.now = now
    this.supportsTools = false  // Hermes runs its own agent tools, not JARVIS's tool schemas
    this.lastError = ''
    this.lastHealth = null
    this.lastTools = []
    this.webEnabled = false
    this.policyMaxAgeMs = policyMaxAgeMs
    this.policyCheckedAt = 0   // when the inventory last PASSED; 0 = must check
    this.reportedAt = 0
    // The inference server Hermes is configured with, for warm-up only. JARVIS
    // never sends conversation to it directly on Hermes' behalf.
    this.backend = backend?.model && backend?.url ? backend : null
    this.sessionFile = sessionFile
    this.sessionIdleMs = sessionIdleMs
    this.sessionMaxTurns = sessionMaxTurns
    this.session = this.#loadSession()
    this.persona = persona
    this.primeEnabled = prime
    this.priming = null       // the in-flight priming exchange, if any
    this.lastPrime = null     // { ok, ms, at, error } for diagnostics
  }

  // --- sessions ---------------------------------------------------------------

  #loadSession() {
    if (!this.sessionFile) return null
    try {
      const s = JSON.parse(readFileSync(this.sessionFile, 'utf8'))
      if (typeof s?.id === 'string' && /^jarvis_\d+_[0-9a-f]+$/.test(s.id)) {
        return { id: s.id, turns: Number(s.turns) || 0, lastUsedAt: Number(s.lastUsedAt) || 0, startedAt: Number(s.startedAt) || 0 }
      }
    } catch { /* none yet, or unreadable: start a new one */ }
    return null
  }

  #saveSession() {
    if (!this.sessionFile || !this.session) return
    try {
      mkdirSync(dirname(this.sessionFile), { recursive: true })
      const tmp = `${this.sessionFile}.tmp`
      writeFileSync(tmp, JSON.stringify(this.session))
      renameSync(tmp, this.sessionFile)
    } catch (err) {
      console.warn(`[jarvis] could not persist the Hermes session id (${err?.code ?? err})`)
    }
  }

  /** The session for the next turn: reused while fresh, otherwise a new one. */
  currentSession() {
    const t = this.now()
    const s = this.session
    if (!s || t - s.lastUsedAt > this.sessionIdleMs || s.turns >= this.sessionMaxTurns) {
      this.session = { id: newSessionId(), turns: 0, lastUsedAt: t, startedAt: t }
      this.#saveSession()
    }
    return this.session
  }

  /** Start a fresh Hermes conversation on the next turn. */
  resetSession() {
    this.session = null
    this.currentSession()
  }

  // --- transport --------------------------------------------------------------

  #headers(extra = {}) {
    return { authorization: `Bearer ${this.key}`, 'content-type': 'application/json', ...extra }
  }

  /** A response with the body still unread. `signal` stays attached to the body. */
  async #request(path, { signal, method = 'GET', body, headers = {}, headersTimeoutMs = this.connectTimeoutMs } = {}) {
    if (!this.key) throw new BrainError('provider_error', 'Hermes API key is not configured')
    // The connect deadline covers only "until response headers": a long answer
    // streamed afterwards is governed by the caller's own turn deadline.
    const ac = new AbortController()
    let headersLate = false
    const timer = setTimeout(() => { headersLate = true; ac.abort() }, headersTimeoutMs)
    const onAbort = () => ac.abort(signal.reason)
    if (signal?.aborted) onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method, headers: this.#headers(headers), body: body && JSON.stringify(body), signal: ac.signal,
      })
      if (res.status === 401 || res.status === 403) throw new BrainError('provider_error', 'Hermes authentication failed')
      if (res.status === 429) throw new BrainError('provider_error', 'Hermes is busy with other runs')
      if (!res.ok) {
        let detail = ''
        try { detail = brief((await res.json())?.error?.message) } catch { /* not JSON */ }
        throw new BrainError('provider_error', `Hermes returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      return res
    } catch (err) {
      signal?.removeEventListener('abort', onAbort)
      if (err instanceof BrainError) throw err
      if (signal?.aborted) throw new BrainError('aborted', 'cancelled')
      if (headersLate) throw new BrainError('timeout', 'Hermes did not respond in time')
      throw new BrainError('offline', 'Hermes gateway is unavailable')
    } finally {
      // The abort link stays while the body streams: barge-in must still cut it.
      clearTimeout(timer)
    }
  }

  async #json(path, opts) {
    const res = await this.#request(path, opts)
    try {
      return await res.json()
    } catch {
      throw new BrainError('bad_response', `Hermes ${path} response was not JSON`)
    }
  }

  /**
   * Fail closed unless every tool Hermes could run for the API server is on
   * the allowlist. Returns the enabled tool names. Before a turn the check is
   * skipped only when it PASSED within policyMaxAgeMs (see POLICY_MAX_AGE_MS);
   * any failure clears that, so the next turn checks again.
   */
  async #checkToolPolicy(signal, { reuse = false } = {}) {
    if (reuse && this.policyCheckedAt && this.now() - this.policyCheckedAt < this.policyMaxAgeMs) return this.lastTools
    this.policyCheckedAt = 0
    const json = await this.#json('/v1/toolsets', { signal })
    const sets = Array.isArray(json) ? json : json?.data
    if (!Array.isArray(sets) || !sets.every((s) => s && typeof s.name === 'string' && typeof s.enabled === 'boolean' && Array.isArray(s.tools))) {
      throw new BrainError('bad_response', 'Hermes toolset inventory unavailable; refusing agent execution')
    }
    const enabled = sets.filter((s) => s.enabled)
    const unsafe = enabled.filter((s) => s.tools.some((tool) => !HERMES_SAFE_TOOLS.includes(tool)))
    if (unsafe.length) {
      throw new BrainError('provider_error', `Hermes has unapproved tools enabled (${unsafe.map((s) => s.name).join(', ')}). Disable them for the api_server platform using hermes tools.`)
    }
    this.lastTools = [...new Set(enabled.flatMap((s) => s.tools))].sort()
    this.webEnabled = this.lastTools.some((t) => WEB_TOOLS.has(t))
    this.policyCheckedAt = this.now()
    return this.lastTools
  }

  /** Re-verify the tool inventory ahead of a turn (on the wake word). Never throws. */
  async refreshPolicy() {
    if (!this.key) return false
    try {
      await this.#checkToolPolicy()
      return true
    } catch {
      return false
    }
  }

  // --- provider interface -------------------------------------------------------

  async health() {
    const out = { ok: false, reachable: false, installed: false, loaded: false, error: '' }
    try {
      const json = await this.#json('/v1/models')
      if (!Array.isArray(json?.data)) throw new BrainError('bad_response', 'Hermes models response malformed')
      out.reachable = true
      out.installed = json.data.some((m) => m?.id === this.model)
      if (!out.installed) throw new BrainError('model_missing', `Hermes does not serve model "${this.model}"`)
      await this.#checkToolPolicy()
      out.loaded = true
      out.ok = true
      // What Hermes says it runs (provider slug + model). Informational: the
      // API does not expose the provider's base URL, so this proves nothing
      // about locality on its own - scripts/diagnostics.mjs checks that.
      // Refreshed rarely: each call costs the gateway ~0.9 s and sends Ollama
      // three more requests, and the diagnostics panel polls health.
      if (!this.reportedAt || this.now() - this.reportedAt >= REPORTED_MAX_AGE_MS) {
        this.reportedAt = this.now()
        try {
          const opts = await this.#json('/api/model/options')
          if (typeof opts?.model === 'string') this.reported = { provider: String(opts.provider ?? ''), model: opts.model }
        } catch { /* older gateway: leave as is */ }
      }
    } catch (err) {
      out.error = err instanceof BrainError ? err.message : 'Hermes health check failed'
    }
    out.tools = this.lastTools
    this.lastHealth = { ...out, at: this.now() }
    return out
  }

  async *stream({ messages = [], signal } = {}, { priming = false } = {}) {
    if (signal?.aborted) throw new BrainError('aborted', 'cancelled')
    // A priming exchange may be opening the session: running a real turn on
    // the same session alongside it would race Hermes' history. Ollama runs one
    // request at a time anyway, so waiting costs nothing.
    if (!priming && this.priming) {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(new BrainError('aborted', 'cancelled'))
        signal?.addEventListener('abort', onAbort, { once: true })
        this.priming.finally(() => { signal?.removeEventListener('abort', onAbort); resolve() })
      })
    }
    const ac = new AbortController()
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; ac.abort() }, this.responseTimeoutMs)
    const abort = () => ac.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    let gotText = false
    let finished = false
    let res = null
    const session = this.currentSession()
    try {
      await this.#checkToolPolicy(ac.signal, { reuse: true })
      res = await this.#request('/v1/chat/completions', {
        signal: ac.signal, method: 'POST',
        headers: { 'X-Hermes-Session-Key': this.sessionKey, 'X-Hermes-Session-Id': session.id },
        body: {
          model: this.model,
          messages: hermesMessages(messages, { persona: this.persona, addendum: hermesSystemAddendum({ web: this.webEnabled }), web: this.webEnabled }),
          stream: true,
          max_tokens: this.maxTokens,
        },
      })
      if (!res.body) throw new BrainError('bad_response', 'Hermes sent no response body')
      const decoder = new TextDecoder()
      let buffer = ''
      let eventLines = []
      const parseFrame = (lines) => {
        const type = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? ''
        // Progress and status are for screens, not for the speaker. One fact
        // is passed on: that an allowed tool has STARTED, by name only (its
        // label carries the search query), so JARVIS can say "Searching."
        // during a 10-20 s research turn instead of going silent.
        if (type === 'hermes.tool.progress') {
          let p = null
          try { p = JSON.parse(lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')) } catch { /* ignore */ }
          return p?.status === 'running' && HERMES_SAFE_TOOLS.includes(p.tool) ? [{ type: 'tool', name: p.tool }] : []
        }
        if (type === 'hermes.status') return []
        // No tool JARVIS allows needs an approval: a request for one means
        // Hermes is about to do something JARVIS never granted. Fail closed.
        if (type === 'approval.request') throw new BrainError('provider_error', 'Hermes asked for an approval JARVIS does not grant')
        const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
        if (!data) return []
        if (data === '[DONE]') { finished = true; return [] }
        let packet
        try { packet = JSON.parse(data) } catch { throw new BrainError('bad_response', 'Hermes returned malformed SSE data') }
        if (type && type !== 'message') return [] // other named events: ignore safely
        if (packet.error) {
          throw new BrainError('provider_error', `Hermes generation failed${packet.error.message ? `: ${brief(packet.error.message)}` : ''}`)
        }
        const choice = packet?.choices?.[0]
        if (choice?.finish_reason) finished = true
        // reasoning_content is ignored entirely: private reasoning is NEVER spoken.
        const delta = choice?.delta?.content
        if (typeof delta === 'string' && delta) { gotText = true; return [{ type: 'text', delta }] }
        return []
      }
      const consume = (line) => {
        if (line === '') { const events = parseFrame(eventLines); eventLines = []; return events }
        if (!line.startsWith(':')) eventLines.push(line) // ':' lines are keepalives
        return []
      }
      for await (const bytes of res.body) {
        buffer += decoder.decode(bytes, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '')
          buffer = buffer.slice(nl + 1)
          for (const ev of consume(line)) yield ev
        }
      }
      buffer += decoder.decode()
      if (buffer) for (const ev of consume(buffer.replace(/\r$/, ''))) yield ev
      if (eventLines.length) for (const ev of parseFrame(eventLines)) yield ev
      if (!finished) throw new BrainError('stream_failed', 'Hermes stream ended prematurely')
      if (!gotText) throw new BrainError('empty', 'Hermes returned an empty answer')
      session.turns++
      session.lastUsedAt = this.now()
      this.#saveSession()
      this.lastError = ''
      // That was the session's last turn: open and prime the next one now,
      // while the answer is being spoken, rather than on the next question.
      if (!priming && session.turns >= this.sessionMaxTurns) setTimeout(() => void this.prepare(), 0)
      yield { type: 'done', stats: { session: session.id } }
    } catch (err) {
      let e
      if (signal?.aborted) e = new BrainError('aborted', 'cancelled')
      else if (timedOut) e = new BrainError('timeout', 'Hermes did not answer in time')
      else if (err instanceof BrainError) e = err
      else if (ac.signal.aborted) e = new BrainError('aborted', 'cancelled')
      else e = new BrainError('stream_failed', 'Hermes stream was interrupted')
      if (e.code !== 'aborted') this.lastError = `${e.code}: ${e.message}`
      throw e
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      // Closing the socket IS the cancellation: Hermes interrupts the agent when
      // the SSE client disconnects (measured). POST /v1/runs/{id}/stop answers
      // 409 run_not_active for chat completions in Hermes 0.21.6, so it is not used.
      ac.abort()
    }
  }

  /**
   * Make the next question fast. When the current session is stale or empty,
   * start a fresh one and run its opening exchange in the background. Called
   * at startup, on the wake word and after a session's last turn. A no-op for
   * a session already in use. Never throws; resolves true when it primed.
   */
  prepare() {
    if (!this.primeEnabled || !this.key) return Promise.resolve(false)
    if (this.priming) return this.priming
    const session = this.currentSession()
    // A live session needs no priming, but the question is seconds away: take
    // the tool-policy check off its critical path now.
    if (session.turns > 0) return this.refreshPolicy().then(() => false)
    const started = this.now()
    this.priming = (async () => {
      try {
        for await (const _ of this.stream({ messages: [{ role: 'user', content: PRIMING_MESSAGE }] }, { priming: true })) { /* discarded */ }
        this.lastPrime = { ok: true, ms: this.now() - started, at: this.now(), session: session.id }
        return true
      } catch (err) {
        this.lastPrime = { ok: false, ms: this.now() - started, at: this.now(), session: session.id, error: `${err?.code ?? 'error'}: ${err?.message ?? err}` }
        return false
      } finally {
        this.priming = null
      }
    })()
    return this.priming
  }

  async chat(req) {
    let text = ''
    let stats = null
    for await (const ev of this.stream(req)) {
      if (ev.type === 'text') text += ev.delta
      if (ev.type === 'done') stats = ev.stats
    }
    return { text, toolCalls: [], stats, model: this.model }
  }

  /**
   * Load Hermes' inference model ahead of the first question. Hermes owns the
   * model; this only asks the same local Ollama server to keep it resident, at
   * the context its Modelfile declares. Never throws.
   */
  async warm() {
    if (!this.backend) return false
    try {
      const res = await this.fetch(`${this.backend.url}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.backend.model, keep_alive: this.backend.keepAlive ?? '30m' }),
        signal: AbortSignal.timeout(this.backend.loadTimeoutMs ?? 120_000),
      })
      await res.body?.cancel?.()
      return res.ok
    } catch {
      return false
    }
  }

  async unload() {} // JARVIS must never shut down a shared gateway or its model

  diagnostics() {
    return {
      provider: this.id, model: this.model, endpoint: this.url,
      authenticated: Boolean(this.key),
      toolPolicy: `allowlist ${HERMES_SAFE_TOOLS.join('/')}`,
      enabledTools: this.lastTools,
      policyCheckedAt: this.policyCheckedAt || null,
      webEnabled: this.webEnabled,
      backendModel: this.backend?.model ?? null,
      reported: this.reported ?? null,
      session: this.session ? { id: this.session.id, turns: this.session.turns, lastUsedAt: this.session.lastUsedAt } : null,
      priming: { enabled: this.primeEnabled, inFlight: Boolean(this.priming), last: this.lastPrime },
      health: this.lastHealth, lastError: this.lastError,
    }
  }
}
