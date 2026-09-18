#!/usr/bin/env node
/**
 * `npm run setup` / `npm run diagnostics` - what is ready, what is running,
 * what is missing.
 *
 * A voice assistant has too many silent halves for "it doesn't work" to be
 * actionable: the microphone, the wake detector, the transcriber, the local
 * model, the voice, the socket between them. This prints one line per
 * question, and a line is either a fact or plainly marked as unknown.
 *
 * It changes nothing, installs nothing, reads nothing outside this repository
 * (plus localhost: the bridge port and Ollama), and never prints a secret.
 * Claude is not checked because JARVIS does not use it.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOW_WRITES,
  BRAIN,
  ENV_FILES_LOADED,
  MIN_NODE_MAJOR,
  PORT,
  describeElevenSource,
  nodeTooOld,
} from '../bridge/config.mjs'
import { createBrain } from '../bridge/brain/index.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ok = (m) => console.log(`[  ok  ] ${m}`)
const note = (m) => console.log(`[ note ] ${m}`)
const info = (m) => console.log(`[  ·   ] ${m}`)
const bad = (m) => console.log(`[ FAIL ] ${m}`)

let problems = 0
const fail = (m) => {
  problems++
  bad(m)
}

console.log('')
console.log('JARVIS diagnostics - nothing is changed')
console.log('--------------------------------------')

// --- the machine -----------------------------------------------------------
if (nodeTooOld()) {
  fail(
    `Node ${process.versions.node} is too old (need ${MIN_NODE_MAJOR}.19+ or 22.12+). Start JARVIS with scripts\\jarvis.ps1, which finds a newer one.`,
  )
} else {
  ok(`Node ${process.versions.node}`)
}

if (existsSync(join(ROOT, 'node_modules'))) ok('dependencies installed')
else fail('node_modules is missing - run `npm ci`')

// --- the local brain -------------------------------------------------------
const brain = createBrain(BRAIN)
const health = await brain.health()
const describe = (label, model, h) => {
  if (!h) return
  if (h.ok) ok(`${label} ${model} installed${h.loaded ? ' and loaded' : ''}`)
  else if (!h.reachable) fail(`Ollama is not reachable at ${BRAIN.ollamaUrl} - start Ollama (https://ollama.com)`)
  else fail(`${label} ${model} is not installed - run: ollama pull ${model}`)
}
if (health.primary.reachable) ok(`Ollama reachable at ${BRAIN.ollamaUrl}`)
describe('primary model', BRAIN.model, health.primary)
if (health.primary.reachable) describe('fallback model', brain.fallback?.model, health.fallback)
info(`keep_alive ${BRAIN.keepAlive} · max ${BRAIN.maxTokens} tokens per answer · cloud required: no · Claude runtime: none`)
info(`mode ${ALLOW_WRITES ? 'WRITES enabled' : 'safe (read-only)'}`)

// --- speech ---------------------------------------------------------------
// Presence only. The key itself is never read out, logged, or echoed.
info(describeElevenSource())
for (const { file, keys } of ENV_FILES_LOADED) {
  info(`${file} supplied ${keys.length} setting(s): ${keys.join(', ') || '(none new)'}`)
}
if (!ENV_FILES_LOADED.length) {
  info('no .env.local or .env in the project - every setting is at its default')
}

// --- is it running? --------------------------------------------------------
const base = `http://127.0.0.1:${PORT}`
try {
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
  const body = await res.json()
  ok(
    `bridge answering on ${base} · transcription ${body.stt ? 'ElevenLabs Scribe' : 'browser'} · voice ${
      body.tts ? 'ElevenLabs' : 'browser'
    }`,
  )
  const d = await (await fetch(`${base}/diagnostics`, { signal: AbortSignal.timeout(8000) })).json()
  info(
    `uptime ${d.bridge.uptimeSeconds}s · clients ${d.bridge.clients} · AI turns ${d.brain.aiTurns} · router turns ${d.brain.routerTurns} · brain unavailable ${d.brain.unavailableTurns}`,
  )
  info(`last model ${d.brain.lastModel ?? '-'} · last latency ${d.brain.lastLatencyMs ?? '-'} ms`)
  info(`applications ${d.apps.count} (${d.apps.status}) · last requested ${d.apps.lastRequested || '-'} -> ${d.apps.lastResolved || '-'} (${d.apps.lastLaunch || '-'})`)
  info(`tools executed ${d.tools.executed} · rejected ${d.tools.rejected} · last ${d.tools.last || '-'} (${d.tools.lastResult || '-'})`)
  info(`speech out ${d.speech.ttsRequests}/${d.speech.ttsFailures} failed · speech in ${d.speech.sttRequests}/${d.speech.sttFailures} failed`)
  if (d.speech.elevenlabsSttDenied) note('ElevenLabs STT was refused; browser recognition is the active fallback.')
  if (d.brain.lastError) note(`last brain error: ${d.brain.lastError}`)
  if (d.speech.lastTtsError) note(`last voice error: ${d.speech.lastTtsError}`)
  if (d.speech.lastSttError) note(`last transcription error: ${d.speech.lastSttError}`)
} catch {
  info(`bridge not answering on ${base} - that is expected if JARVIS is not running`)
}

console.log('')
console.log('The rest of the pipeline lives in the browser, where the microphone is:')
console.log('  open http://localhost:5173 in Chrome or Edge (a real window, not an editor')
console.log('  preview), click INITIALISE, allow the microphone, then press D for the live')
console.log('  panel and T for a one-line audio self-test.')
console.log('')
console.log(problems === 0 ? 'No blocking problems found.' : `${problems} problem(s) above need attention.`)
console.log('')

process.exit(problems === 0 ? 0 : 1)
