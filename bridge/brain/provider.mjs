/**
 * The provider-neutral brain.
 *
 * A BrainProvider is any object with this shape:
 *
 *   id              'ollama', 'openai-compatible', ...
 *   model           the model name it runs
 *   supportsTools   whether it can return structured tool calls
 *   health()        -> { ok, reachable, installed, loaded, error }   never throws
 *   stream(req)     async iterator of { type: 'text', delta }
 *                                      { type: 'tool_calls', calls: [{ name, arguments }] }
 *                                      { type: 'done', stats }
 *                   and throws BrainError on anything that is not an answer
 *   chat(req)       the same, collected: { text, toolCalls, stats, model }
 *   warm()/unload() optional; keep a local model resident, or release it
 *   diagnostics()   plain data for GET /diagnostics
 *
 * where req = { messages: [{ role, content }], tools: [JSON-schema tools], signal }.
 *
 * Only OllamaBrain exists today. A future provider (another local engine, an
 * OpenAI-compatible endpoint, an optional cloud router) implements the same
 * shape and is added to createBrain() - nothing in the voice, router, tools or
 * application resolver changes.
 */

/** Every way a provider can fail to produce an answer. */
export class BrainError extends Error {
  /**
   * @param {'offline'|'timeout'|'model_missing'|'bad_response'|'provider_error'|'stream_failed'|'empty'|'aborted'} code
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'BrainError'
    this.code = code
  }
}

/**
 * Whether trying the next model could help. An unreachable server will not be
 * reachable for the fallback either (same Ollama), and a cancelled turn was
 * cancelled on purpose.
 */
export const worthFallingBack = (err) =>
  err instanceof BrainError && !['offline', 'aborted'].includes(err.code)

/**
 * Primary, then fallback, never at random.
 *
 * The fallback is tried only when the primary fails BEFORE saying anything -
 * once words have been streamed to the speaker, switching models mid-sentence
 * would produce a sentence nobody wrote. One attempt per model per turn: no
 * retry loops.
 */
export class BrainChain {
  constructor(providers) {
    this.providers = providers.filter(Boolean)
    this.last = null
    this.turns = 0
    this.failures = 0
  }

  get primary() {
    return this.providers[0]
  }

  get fallback() {
    return this.providers[1] ?? null
  }

  /**
   * Yields provider events plus one leading { type: 'model', provider, model,
   * fallbackUsed } so callers know who is answering.
   */
  async *stream(request, { prefer } = {}) {
    const order = prefer
      ? [...this.providers].sort((a, b) => (a.model === prefer ? -1 : b.model === prefer ? 1 : 0))
      : this.providers
    const started = Date.now()
    let lastErr = null
    this.turns++
    for (let i = 0; i < order.length; i++) {
      const provider = order[i]
      let said = false
      let firstTokenMs = null
      try {
        for await (const ev of provider.stream(request)) {
          // First WORDS, not first event: a tool starting is not an answer.
          if (firstTokenMs === null && ev.type === 'text') firstTokenMs = Date.now() - started
          if (!said) {
            said = true
            yield {
              type: 'model', provider: provider.id, model: provider.model, fallbackUsed: i > 0,
              // false: this brain never sees JARVIS's tool schemas (Hermes), see assistant.mjs
              ...(provider.supportsTools === false ? { supportsTools: false } : {}),
            }
          }
          yield ev
        }
        this.last = {
          provider: provider.id,
          model: provider.model,
          fallbackUsed: i > 0,
          latencyMs: Date.now() - started,
          firstTokenMs,
          at: Date.now(),
          error: lastErr ? `${lastErr.code}: ${lastErr.message}` : '',
        }
        return
      } catch (err) {
        lastErr = err instanceof BrainError ? err : new BrainError('provider_error', String(err?.message ?? err))
        if (lastErr.code === 'aborted') throw lastErr
        if (said || lastErr.code === 'aborted' || i === order.length - 1) break
        // A dead Ollama server is not fixed by a second model on that same
        // server. A different provider (Hermes -> Ollama) CAN recover.
        if (lastErr.code === 'offline' && order[i + 1]?.url === provider.url) break
      }
    }
    this.failures++
    this.last = {
      provider: null,
      model: null,
      fallbackUsed: false,
      latencyMs: Date.now() - started,
      firstTokenMs: null,
      at: Date.now(),
      error: `${lastErr.code}: ${lastErr.message}`,
    }
    throw lastErr
  }

  async health() {
    const [primary, fallback] = await Promise.all([
      this.primary.health(),
      this.fallback ? this.fallback.health() : Promise.resolve(null),
    ])
    return { primary, fallback }
  }

  async warm() {
    return this.primary.warm?.() ?? false
  }

  /** Get the primary ready for an imminent question (Hermes: prime a fresh session). */
  async prepare() {
    return this.primary.prepare?.() ?? false
  }

  async unload() {
    await Promise.all(this.providers.map((p) => p.unload?.()))
  }

  diagnostics() {
    return {
      mode: this.primary.id === 'hermes' ? 'agent' : 'local',
      provider: this.primary.id,
      endpoint: this.primary.url ?? null,
      primary: this.primary.diagnostics(),
      fallback: this.fallback?.diagnostics() ?? null,
      last: this.last,
      turns: this.turns,
      failures: this.failures,
      // Hermes may use a cloud OR local model: do not misrepresent its privacy.
      cloudRequired: this.primary.id === 'hermes' ? null : false,
      claudeRuntime: 'none',
    }
  }
}
