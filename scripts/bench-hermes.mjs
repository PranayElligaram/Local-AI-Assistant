#!/usr/bin/env node
/**
 * Hermes latency benchmark: drives Hermes exactly as the bridge does (same
 * HermesBrain, persona and addendum) on a throwaway session, and reports
 * priming time, time to first words and total time per question.
 *
 *   npm run bench:hermes            # 3 short questions + 1 research question
 *   npm run bench:hermes -- --quick # short questions only
 *   npm run bench:hermes -- --json  # machine-readable
 *
 * It uses its own session key, so JARVIS' conversation history is untouched,
 * but it shares the one local model: JARVIS' next turn may re-read its session.
 */
import { BRAIN } from '../bridge/config.mjs'
import { HermesBrain, HERMES_PERSONA } from '../bridge/brain/index.mjs'

const args = new Set(process.argv.slice(2))
const QUESTIONS = [
  'What is the capital of France?',
  'Explain the difference between a CPU and a GPU.',
  'Give me one tip for sleeping better.',
  ...(args.has('--quick') ? [] : ['What is the latest version of Node.js?']),
]

if (!BRAIN.hermesKey) {
  console.error('JARVIS_HERMES_KEY is not set (.env.local); nothing to benchmark.')
  process.exit(2)
}

const brain = new HermesBrain({
  url: BRAIN.hermesUrl, key: BRAIN.hermesKey, model: BRAIN.hermesModel,
  sessionKey: 'jarvis:bench', connectTimeoutMs: BRAIN.hermesConnectTimeoutMs,
  responseTimeoutMs: BRAIN.hermesResponseTimeoutMs, maxTokens: BRAIN.maxTokens,
  sessionFile: null, persona: HERMES_PERSONA, prime: true,
})

const now = () => performance.now()
const results = { prime: null, turns: [] }

// --cold: first give the model an unrelated prompt, as any other use of it
// would (a test, `hermes chat`, another app), so the opening exchange has to
// re-read Hermes' whole prompt instead of resuming the cached one.
if (args.has('--cold') && BRAIN.hermesBackendModel) {
  const res = await fetch(`${BRAIN.ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: BRAIN.hermesBackendModel, messages: [{ role: 'user', content: `cache reset ${Date.now()}` }], stream: false, think: false, options: { num_predict: 1 } }),
  })
  await res.body?.cancel?.()
  results.cold = true
}

const t0 = now()
const primed = await brain.prepare()
results.prime = { ok: primed, ms: Math.round(now() - t0), error: brain.lastPrime?.error }

for (const q of QUESTIONS) {
  const start = now()
  let first = null
  let tool = null
  let text = ''
  let error = null
  try {
    for await (const ev of brain.stream({ messages: [{ role: 'user', content: q }] })) {
      if (ev.type === 'tool') tool ??= now() - start
      if (ev.type === 'text') {
        first ??= now() - start
        text += ev.delta
      }
    }
  } catch (err) {
    error = `${err.code}: ${err.message}`
  }
  results.turns.push({ q, toolMs: tool == null ? null : Math.round(tool), firstMs: first == null ? null : Math.round(first), totalMs: Math.round(now() - start), chars: text.length, text: text.slice(0, 160), error })
}

if (args.has('--json')) {
  console.log(JSON.stringify(results, null, 2))
} else {
  console.log(`prime: ${results.prime.ok ? 'ok' : 'FAILED'} ${(results.prime.ms / 1000).toFixed(2)} s${results.prime.error ? ` (${results.prime.error})` : ''}`)
  for (const t of results.turns) {
    const f = t.firstMs == null ? '   -  ' : `${(t.firstMs / 1000).toFixed(2)} s`
    const searched = t.toolMs == null ? '' : `  (searching from ${(t.toolMs / 1000).toFixed(2)} s)`
    console.log(`first ${f}  total ${(t.totalMs / 1000).toFixed(2)} s  ${t.q}${searched}${t.error ? `  ERROR ${t.error}` : ''}`)
    if (t.text) console.log(`    -> ${t.text.replace(/\s+/g, ' ')}`)
  }
}
process.exit(results.turns.every((t) => !t.error) && results.prime.ok ? 0 : 1)
