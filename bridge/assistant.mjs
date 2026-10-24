/**
 * One conversation: what happens between "the user said X" and the frames the
 * browser speaks.
 *
 *   utterance -> pending "which one?" answer?  -> open the chosen app
 *             -> deterministic router          -> JARVIS tool -> spoken result
 *             -> local brain (granite, then qwen)
 *                  -> streamed text             -> spoken as it arrives
 *                  -> structured tool calls     -> validated + executed by JARVIS
 *                  -> failure                   -> one honest sentence
 *
 * Frames sent (all tagged with the ask id, so a superseded turn's tail is
 * ignored by the browser):
 *   { type: 'text', delta }
 *   { type: 'done', text, source: 'router'|'ollama'|'unavailable'|'empty', model, tool, ok }
 */

import { pickChoice, route, routeSoftApp } from './router.mjs'

export const UNAVAILABLE = 'My local AI brain is unavailable right now.'
const NO_ANSWER = "I don't have an answer for that."
const MAX_TOOL_CALLS = 3
const CHOICE_TTL_MS = 90_000

/**
 * A small model sometimes SAYS it did something instead of calling the tool
 * ("Opening Visual Studio Code." with no tool call). That sentence must never
 * be spoken: nothing was opened. The opening of every answer is held back
 * until its first sentence is known, and an action claim with no tool call is
 * replaced - by the real, validated action when the claim names one JARVIS
 * can route, otherwise by an honest sentence.
 */
export const ACTION_CLAIM = {
  /** Unmistakable: "I've opened Word", "The calculator is now open". */
  strong:
    /^["'“]?(?:(?:ok(?:ay)?|sure|certainly|done|alright|all right)[,.!]?\s+)?(?:i(?:'ve| have) (?:opened|launched|started)\b|i(?:'ve| have) got (?:the |your )?[\w .+#&'-]{1,40}? (?:ready|running|open|going|up)\b|.*\b(?:is|are) now (?:open|running|launched)\b|.*\bhas been (?:opened|launched|started)\b)/i,
  /** Probable: "Opening Visual Studio Code." - but "Starting points vary" is not. */
  lead: /^(?:(?:ok(?:ay)?|sure|certainly)[,.!]?\s+)?(?:i'?m |now )?(?:opening|launching|starting|opened|launched|started)\s/i,
}
const HOLD_CHARS = 80

/** Markdown that would be read aloud as punctuation. */
const speakable = (s) => s.replace(/[*#`]+/g, '')

/** "Opening Visual Studio Code." -> "open Visual Studio Code", for the router. */
const claimAsCommand = (text) => {
  const m = /\b(?:opening|launching|starting|opened|launched|started)\s+(?:up\s+)?(.+?)[.!]?$/i.exec(text.trim())
  if (m) return `open ${m[1]}`
  const n = /^(?:the\s+)?(.+?)\s+(?:is|are|has been)\s+(?:now\s+)?(?:open|opened|running|launched|started)\b/i.exec(text.trim())
  return n ? `open ${n[1]}` : null
}

export function createMetrics() {
  return {
    routerTurns: 0,
    aiTurns: 0,
    unavailableTurns: 0,
    cancelledTurns: 0,
    lastSource: '',
    lastError: '',
    lastTurnAt: 0,
  }
}

/**
 * @param {object} o
 * @param {import('./brain/provider.mjs').BrainChain} o.brain
 * @param {ReturnType<import('./tools.mjs').createTools>} o.tools
 * @param {string} o.systemPrompt
 * @param {(frame: object) => void} o.send
 * @param {ReturnType<typeof createMetrics>} [o.metrics]
 */
export function createConversation({ brain, tools, systemPrompt, send, metrics = createMetrics(), maxHistory = 16 }) {
  let history = []
  let current = null
  let pendingChoice = null

  /**
   * History keeps tool turns in their real shape - the call, its result, then
   * what was said - so the model learns that actions are tool calls, not
   * sentences. A plain "Opening Spotify." in history teaches it to reply
   * "Opening Visual Studio Code." next time without opening anything.
   */
  const remember = (user, assistant, toolCalls = []) => {
    history.push({ role: 'user', content: user })
    if (toolCalls.length) {
      history.push({
        role: 'assistant',
        content: '',
        tool_calls: toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } })),
      })
      for (const c of toolCalls) {
        history.push({ role: 'tool', content: JSON.stringify({ ok: c.ok, result: c.say }) })
      }
    }
    history.push({ role: 'assistant', content: assistant || '...' })
    // Trim from the front at a user message, so a tool result never loses its call.
    while (history.length > maxHistory) {
      const next = history.findIndex((m, i) => i > 0 && m.role === 'user')
      history = next > 0 ? history.slice(next) : history.slice(-maxHistory)
    }
  }

  async function ask(text, id = null) {
    current?.controller.abort()
    const controller = new AbortController()
    const turn = { id, controller }
    current = turn
    const live = () => current === turn && !controller.signal.aborted
    const emit = (msg) => {
      if (live()) send({ ...msg, ask: id })
    }
    const finish = (say, extra) => {
      emit({ type: 'text', delta: say })
      emit({ type: 'done', text: say, ...extra })
      metrics.lastSource = extra.source
      metrics.lastTurnAt = Date.now()
    }

    try {
      const said = String(text ?? '').trim()
      if (!said) return finish(NO_ANSWER, { source: 'router', ok: false })

      // A reply to "which one should I open?"
      if (pendingChoice && Date.now() - pendingChoice.at < CHOICE_TTL_MS) {
        const pick = pickChoice(said, pendingChoice.candidates)
        pendingChoice = null
        if (pick === false) {
          metrics.routerTurns++
          remember(said, 'Very well.')
          return finish('Very well.', { source: 'router', ok: true })
        }
        if (pick) return await runTool('open_application', { name: pick }, said, 'router')
      }
      pendingChoice = null

      const intent = route(said)
      if (intent) return await runTool(intent.tool, intent.args, said, 'router')

      // A brain that cannot call JARVIS's tools (Hermes) cannot open an app it
      // is asked for in looser words, so JARVIS recognises those itself - but
      // only for an application that is actually installed.
      if (brain.primary?.supportsTools === false) {
        const soft = routeSoftApp(said)
        if (soft && (await tools.canOpen(soft.args.name))) return await runTool(soft.tool, soft.args, said, 'router')
        if (!live()) return
      }

      return await think(said)
    } finally {
      if (current === turn) current = null
    }

    async function runTool(name, args, said, origin) {
      const r = await tools.execute(name, args, { origin })
      if (!live()) return
      if (r.needsChoice?.length) pendingChoice = { candidates: r.needsChoice, at: Date.now() }
      metrics.routerTurns++
      remember(said, r.say, [{ name, args, ok: r.ok, say: r.say }])
      finish(r.say, { source: 'router', tool: name, ok: r.ok })
    }

    async function think(said) {
      const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: said }]
      let spoken = ''
      let held = ''
      let holding = true
      let claim = null
      let model = null
      const calls = []
      // Release the held opening once its first sentence is known - unless it
      // is an action claim, which is swallowed and dealt with after the stream.
      const release = (final) => {
        if (!holding) return
        const sentenceDone = /[.!?](\s|$)/.test(held)
        if (!final && !sentenceDone && held.length < HOLD_CHARS) return
        holding = false
        const t = held.trim()
        if (ACTION_CLAIM.strong.test(t) || ACTION_CLAIM.lead.test(t)) {
          claim = t
          return
        }
        if (held) {
          spoken += held
          emit({ type: 'text', delta: held })
        }
      }
      try {
        for await (const ev of brain.stream({ messages, tools: tools.modelSchemas(), signal: controller.signal })) {
          if (!live()) return
          if (ev.type === 'model') model = ev
          else if (ev.type === 'text') {
            const delta = speakable(ev.delta)
            if (!delta) continue
            if (holding) {
              held += delta
              release(false)
            } else if (claim === null) {
              spoken += delta
              emit({ type: 'text', delta })
            } else {
              claim += delta
            }
          } else if (ev.type === 'tool_calls') calls.push(...ev.calls)
          // A brain's own tool starting (Hermes' web_search): the interface
          // says "Searching." now rather than staying silent until the answer.
          else if (ev.type === 'tool' && !spoken && !held) emit({ type: 'tool', name: ev.name })
        }
        release(true)
      } catch (err) {
        if (controller.signal.aborted || err?.code === 'aborted') {
          metrics.cancelledTurns++
          return
        }
        metrics.unavailableTurns++
        metrics.lastError = `${err?.code ?? 'error'}: ${err?.message ?? err}`
        console.warn(`[jarvis] local brain unavailable (${metrics.lastError})`)
        // Whatever was already said stays said; the apology follows it.
        const say = spoken ? ` ${UNAVAILABLE}` : UNAVAILABLE
        emit({ type: 'text', delta: say })
        emit({ type: 'done', text: (spoken + say).trim(), source: 'unavailable', error: err?.code ?? 'error' })
        metrics.lastSource = 'unavailable'
        metrics.lastTurnAt = Date.now()
        return
      }
      if (!live()) return

      // An action claimed but not called: do the real thing if it is one JARVIS
      // can route (still validated like any model request), or say so.
      //
      // A brain without JARVIS's tool schemas (Hermes, which also reads web
      // pages) may REQUEST only an installed application this way - resolved
      // against the catalogue, no arguments. A web address it names is never
      // opened: that would let a page it read choose what the browser loads.
      if (claim !== null && !calls.length) {
        const intent = route(claimAsCommand(claim) ?? '')
        const urlClaims = model?.supportsTools !== false
        // Hermes' one action request (hermesSystemAddendum): an answer that is
        // exactly "Opening <application>." goes to the open_application tool,
        // which validates and resolves the name and says what really happened.
        const asked = !urlClaims ? /^opening\s+([^.!?]+?)[.!]?$/i.exec(claim.trim()) : null
        const real = asked
          ? { tool: 'open_application', args: { name: asked[1].trim() } }
          : intent?.tool === 'open_application'
            ? (await tools.canOpen(intent.args.name)) && intent
            : intent?.tool === 'open_url' && urlClaims
              ? intent
              : null
        if (!live()) return
        let say
        if (real) {
          console.log(`[jarvis] model claimed ${real.tool} without calling it; running it for real`)
          calls.push({ name: real.tool, arguments: real.args })
        } else if (ACTION_CLAIM.strong.test(claim) || (intent?.tool === 'open_url' && !urlClaims)) {
          if (intent?.tool === 'open_url' && !urlClaims) console.log(`[jarvis] ${model?.provider} named a web address to open; not opened`)
          say = "I couldn't carry that out."
        } else {
          say = claim // not an action after all ("Starting points vary...")
        }
        if (say) {
          spoken += say
          emit({ type: 'text', delta: say })
        }
      }

      const used = []
      const executed = []
      if (calls.length) {
        const results = []
        for (const [i, call] of calls.entries()) {
          results.push(
            i < MAX_TOOL_CALLS
              ? await tools.execute(call?.name, call?.arguments, { origin: 'model' })
              : { ok: false, say: '', tool: call?.name },
          )
          if (!live()) return
        }
        for (const [i, r] of results.entries()) {
          used.push(r.tool)
          if (!r.rejected && r.tool) {
            let args = calls[i]?.arguments ?? {}
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args)
              } catch {
                args = {}
              }
            }
            executed.push({ name: r.tool, args, ok: r.ok, say: r.say })
          }
          if (r.needsChoice?.length) pendingChoice = { candidates: r.needsChoice, at: Date.now() }
        }
        const say = results.map((r) => r.say).filter(Boolean).join(' ')
        if (say) {
          const delta = spoken ? ` ${say}` : say
          spoken += delta
          emit({ type: 'text', delta })
        }
      }

      const answer = spoken.trim()
      metrics.aiTurns++
      if (!answer) {
        remember(said, NO_ANSWER)
        return finish(NO_ANSWER, { source: 'empty', model: model?.model ?? null })
      }
      remember(said, answer, executed)
      emit({
        type: 'done',
        text: answer,
        source: model?.provider ?? 'ollama',
        model: model?.model ?? null,
        fallbackUsed: Boolean(model?.fallbackUsed),
        tools: used,
        ok: true,
      })
      metrics.lastSource = model?.provider ?? 'ollama'
      metrics.lastTurnAt = Date.now()
    }
  }

  return {
    ask,
    interrupt() {
      current?.controller.abort()
      current = null
    },
    close() {
      current?.controller.abort()
      current = null
      history = []
    },
    get busy() {
      return current !== null
    },
  }
}
