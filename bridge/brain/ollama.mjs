/**
 * OllamaBrain - one local model behind Ollama's HTTP API.
 *
 * This is the only file in JARVIS that knows what an Ollama request looks
 * like. Everything above it (the fallback chain, the assistant, the voice)
 * speaks the provider-neutral shape documented in provider.mjs.
 *
 * Failure is the normal case to design for here: Ollama not running, a model
 * not pulled, a cold load that takes several seconds, a stream that stops
 * half way. Every one of those becomes a BrainError with a stable `code`, and
 * none of them is ever reported as an answer.
 */

import { BrainError } from './provider.mjs'

/** "30m" / "90s" / "1h" / "0" -> milliseconds, for the warm-model estimate. */
export function parseKeepAlive(value) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value ?? '').trim())
  if (!m) return 0
  const n = Number(m[1])
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's']
}

/** fetch() failures carry the socket error in `cause`. */
function classifyNetworkError(err) {
  const code = err?.cause?.code ?? err?.code ?? ''
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return new BrainError('offline', 'Ollama is not reachable', { cause: err })
  }
  return new BrainError('offline', `Ollama request failed: ${err?.message ?? err}`, { cause: err })
}

export class OllamaBrain {
  /**
   * @param {object} o
   * @param {string} o.url            e.g. http://127.0.0.1:11434
   * @param {string} o.model          e.g. granite4:3b
   * @param {string} [o.keepAlive]    Ollama keep_alive, default 30m
   * @param {boolean} [o.think]       sent as `think`; false keeps reasoning off
   * @param {number} [o.connectTimeoutMs]   health checks
   * @param {number} [o.responseTimeoutMs]  first token when warm, and any gap between chunks
   * @param {number} [o.loadTimeoutMs]      first token when the model may need loading
   * @param {number} [o.maxTokens]          num_predict
   * @param {typeof fetch} [o.fetch]
   */
  constructor(o) {
    this.id = 'ollama'
    this.url = String(o.url).replace(/\/+$/, '')
    this.model = o.model
    this.keepAlive = o.keepAlive ?? '30m'
    this.think = o.think ?? false
    this.connectTimeoutMs = o.connectTimeoutMs ?? 3000
    this.responseTimeoutMs = o.responseTimeoutMs ?? 20_000
    this.loadTimeoutMs = o.loadTimeoutMs ?? 60_000
    this.maxTokens = o.maxTokens ?? 256
    this.fetch = o.fetch ?? globalThis.fetch
    this.supportsTools = true
    this.lastSuccessAt = 0
    this.lastError = ''
    this.lastHealth = null
  }

  /** True while the model has answered within its keep_alive window. */
  likelyLoaded(now = Date.now()) {
    return this.lastSuccessAt > 0 && now - this.lastSuccessAt < parseKeepAlive(this.keepAlive)
  }

  async #get(path, timeoutMs = this.connectTimeoutMs) {
    let res
    try {
      res = await this.fetch(`${this.url}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new BrainError('timeout', 'Ollama did not answer in time')
      throw classifyNetworkError(err)
    }
    if (!res.ok) throw new BrainError('provider_error', `Ollama returned HTTP ${res.status}`)
    try {
      return await res.json()
    } catch {
      throw new BrainError('bad_response', 'Ollama returned malformed JSON')
    }
  }

  /** Reachable? Installed? Loaded? Never throws. */
  async health() {
    const out = { ok: false, reachable: false, installed: false, loaded: false, error: '' }
    try {
      const tags = await this.#get('/api/tags')
      out.reachable = true
      const names = (tags?.models ?? []).map((m) => m.name ?? m.model)
      out.installed = names.some((n) => n === this.model || n === `${this.model}:latest`)
      if (!out.installed) out.error = `model ${this.model} is not installed (ollama pull ${this.model})`
      try {
        const ps = await this.#get('/api/ps')
        out.loaded = (ps?.models ?? []).some((m) => (m.name ?? m.model) === this.model)
      } catch {
        /* /api/ps is informational only */
      }
      out.ok = out.installed
    } catch (err) {
      out.error = err.message
    }
    this.lastHealth = { ...out, at: Date.now() }
    return out
  }

  /**
   * Streamed chat. Yields provider-neutral events:
   *   { type: 'text', delta }
   *   { type: 'tool_calls', calls: [{ name, arguments }] }
   *   { type: 'done', stats: { promptTokens, outputTokens } }
   * and throws BrainError for anything that is not a real answer.
   */
  async *stream({ messages, tools, signal } = {}) {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) throw new BrainError('aborted', 'cancelled')
    signal?.addEventListener('abort', abort, { once: true })

    let timer = null
    let timedOut = false
    const arm = (ms) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, ms)
    }
    arm(this.likelyLoaded() ? this.responseTimeoutMs : this.loadTimeoutMs)

    const body = {
      model: this.model,
      messages,
      stream: true,
      keep_alive: this.keepAlive,
      think: this.think,
      options: { num_predict: this.maxTokens, temperature: 0.4 },
    }
    if (tools?.length) body.tools = tools

    const fail = (err) => {
      if (signal?.aborted) return new BrainError('aborted', 'cancelled')
      if (timedOut) return new BrainError('timeout', `${this.model} did not respond in time`)
      return err
    }

    try {
      let res
      try {
        res = await this.fetch(`${this.url}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (err) {
        throw fail(classifyNetworkError(err))
      }

      if (!res.ok) {
        let detail = ''
        try {
          detail = (await res.json())?.error ?? ''
        } catch {
          /* body is not JSON; the status is enough */
        }
        if (res.status === 404 || /not found/i.test(detail)) {
          throw new BrainError('model_missing', `model ${this.model} is not installed`)
        }
        throw new BrainError('provider_error', `Ollama returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      if (!res.body) throw new BrainError('bad_response', 'Ollama returned no body')

      const decoder = new TextDecoder()
      let buffered = ''
      let finished = false
      let produced = false

      const handleLine = (line) => {
        if (!line.trim()) return []
        let chunk
        try {
          chunk = JSON.parse(line)
        } catch {
          throw new BrainError('bad_response', 'Ollama sent a malformed stream chunk')
        }
        if (chunk.error) {
          if (/not found/i.test(chunk.error)) {
            throw new BrainError('model_missing', `model ${this.model} is not installed`)
          }
          throw new BrainError('provider_error', String(chunk.error))
        }
        const events = []
        const msg = chunk.message ?? {}
        // `thinking` is deliberately ignored: private reasoning is never spoken.
        if (typeof msg.content === 'string' && msg.content) {
          produced = true
          events.push({ type: 'text', delta: msg.content })
        }
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          produced = true
          events.push({
            type: 'tool_calls',
            calls: msg.tool_calls.map((c) => ({
              name: c?.function?.name,
              arguments: c?.function?.arguments,
            })),
          })
        }
        if (chunk.done) {
          finished = true
          events.push({
            type: 'done',
            stats: {
              promptTokens: chunk.prompt_eval_count ?? 0,
              outputTokens: chunk.eval_count ?? 0,
              doneReason: chunk.done_reason ?? '',
            },
          })
        }
        return events
      }

      try {
        for await (const bytes of res.body) {
          arm(this.responseTimeoutMs)
          buffered += decoder.decode(bytes, { stream: true })
          let nl
          while ((nl = buffered.indexOf('\n')) !== -1) {
            const line = buffered.slice(0, nl)
            buffered = buffered.slice(nl + 1)
            for (const ev of handleLine(line)) yield ev
          }
        }
        for (const ev of handleLine(buffered)) yield ev
      } catch (err) {
        if (err instanceof BrainError) throw fail(err)
        throw fail(new BrainError('stream_failed', `the ${this.model} stream failed: ${err?.message ?? err}`))
      }

      if (!finished) throw fail(new BrainError('stream_failed', `the ${this.model} stream ended early`))
      if (!produced) throw new BrainError('empty', `${this.model} returned an empty answer`)
      this.lastSuccessAt = Date.now()
      this.lastError = ''
    } catch (err) {
      const e = err instanceof BrainError ? err : fail(new BrainError('provider_error', String(err?.message ?? err)))
      if (e.code !== 'aborted') {
        this.lastError = `${e.code}: ${e.message}`
        this.lastSuccessAt = 0
      }
      throw e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  /** Non-streamed convenience: the whole answer at once. */
  async chat(request) {
    let text = ''
    const toolCalls = []
    let stats = null
    for await (const ev of this.stream(request)) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'tool_calls') toolCalls.push(...ev.calls)
      else if (ev.type === 'done') stats = ev.stats
    }
    return { text, toolCalls, stats, model: this.model }
  }

  /** Load the model now so the first spoken question is not a cold start. */
  async warm() {
    try {
      const res = await this.fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: [], keep_alive: this.keepAlive }),
        signal: AbortSignal.timeout(this.loadTimeoutMs),
      })
      if (res.ok) this.lastSuccessAt = Date.now()
      return res.ok
    } catch {
      return false
    }
  }

  /** Release the model's memory. Called when JARVIS itself stops. */
  async unload() {
    try {
      await this.fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: [], keep_alive: 0 }),
        signal: AbortSignal.timeout(this.connectTimeoutMs),
      })
    } catch {
      /* Ollama gone already; nothing is held */
    }
    this.lastSuccessAt = 0
  }

  diagnostics() {
    return {
      provider: this.id,
      model: this.model,
      endpoint: this.url,
      keepAlive: this.keepAlive,
      health: this.lastHealth,
      likelyLoaded: this.likelyLoaded(),
      lastError: this.lastError,
    }
  }
}
