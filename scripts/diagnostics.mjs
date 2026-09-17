#!/usr/bin/env node
/**
 * `npm run diagnostics` — what is ready, what is running, what is missing.
 *
 * The previous implementation's most useful habit was that every failure had a
 * name. A voice assistant has too many silent halves for "it doesn't work" to
 * be actionable: the microphone, the wake detector, the transcriber, the model,
 * the voice, the socket between them. This prints one line per question, and a
 * line is either a fact or plainly marked as unknown.
 *
 * It changes nothing, installs nothing, reads nothing outside this repository
 * (and one localhost port), and never prints a secret.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOW_WRITES,
  EFFORT,
  ENABLE_CAMERA,
  ENABLE_CHROME,
  ENV_FILES_LOADED,
  MIN_NODE_MAJOR,
  MODEL,
  PORT,
  WORKSPACE,
  describeElevenSource,
  mcpConfigPath,
  nodeTooOld,
  projectServers,
} from '../bridge/config.mjs'

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
console.log('JARVIS diagnostics — nothing is changed')
console.log('--------------------------------------')

// --- the machine -----------------------------------------------------------
if (nodeTooOld()) {
  fail(
    `Node ${process.versions.node} is older than ${MIN_NODE_MAJOR}. Start JARVIS with scripts\\jarvis.ps1, which finds a newer one.`,
  )
} else {
  ok(`Node ${process.versions.node}`)
}

if (existsSync(join(ROOT, 'node_modules'))) ok('dependencies installed')
else fail('node_modules is missing — run `npm ci`')

// --- the brain's authentication -------------------------------------------
// The bridge authenticates off the Claude Code login, so the question is
// whether the CLI is installed and logged in, not whether an API key exists.
const claude = spawnSync('claude', ['--version'], {
  encoding: 'utf8',
  timeout: 15000,
  shell: process.platform === 'win32',
})
if (claude.status === 0 && claude.stdout) {
  ok(`Claude Code CLI ${claude.stdout.trim()} (the bridge uses this login — no API key)`)
} else {
  note('Claude Code CLI not found on PATH. Install it and run `claude` once to log in.')
}

// --- speech ---------------------------------------------------------------
// Presence only. The key itself is never read out, logged, or echoed.
info(describeElevenSource())
for (const { file, keys } of ENV_FILES_LOADED) {
  info(`${file} supplied ${keys.length} setting(s): ${keys.join(', ') || '(none new)'}`)
}
if (!ENV_FILES_LOADED.length) {
  info('no .env.local or .env in the project — every setting is at its default')
}

// --- capabilities ----------------------------------------------------------
const servers = Object.keys(projectServers())
info(
  servers.length
    ? `MCP servers (project-local, opt-in): ${servers.join(', ')}`
    : `no external MCP servers — ${mcpConfigPath()} is absent, and the global ~/.claude.json is deliberately never read`,
)
info(`browser control ${ENABLE_CHROME ? 'enabled' : 'off (JARVIS_ENABLE_CHROME=1 to enable)'}`)
info(`camera ${ENABLE_CAMERA ? 'enabled' : 'off'}`)
info(`model ${MODEL} · effort ${EFFORT} · writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}`)
info(`workspace ${WORKSPACE}`)

// --- is it running? --------------------------------------------------------
const base = `http://127.0.0.1:${PORT}`
try {
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
  const body = await health.json()
  ok(
    `bridge answering on ${base} · transcription ${body.stt ? 'ElevenLabs Scribe' : 'browser'} · voice ${
      body.tts ? 'ElevenLabs' : 'browser'
    }`,
  )
  const diag = await fetch(`${base}/diagnostics`, { signal: AbortSignal.timeout(2500) })
  const d = await diag.json()
  info(
    `uptime ${d.bridge.uptimeSeconds}s · clients ${d.bridge.clients} · turns ${d.agent.turns} (${d.agent.turnErrors} failed)`,
  )
  info(
    `tools allowed ${d.agent.toolsAllowed} · denied ${d.agent.toolsDenied} · speech out ${d.speech.ttsRequests}/${d.speech.ttsFailures} failed · speech in ${d.speech.sttRequests}/${d.speech.sttFailures} failed`,
  )
  if (d.agent.lastTurnError) note(`last turn error: ${d.agent.lastTurnError}`)
  if (d.speech.lastTtsError) note(`last voice error: ${d.speech.lastTtsError}`)
  if (d.speech.lastSttError) note(`last transcription error: ${d.speech.lastSttError}`)
} catch {
  info(`bridge not answering on ${base} — that is expected if JARVIS is not running`)
}

console.log('')
console.log('The rest of the pipeline lives in the browser, where the microphone is:')
console.log('  open the interface, press D for the live panel (microphone, wake word,')
console.log('  transcription, speech) and T for a one-line audio self-test.')
console.log('')
console.log(
  problems === 0
    ? 'No blocking problems found.'
    : `${problems} problem(s) above need attention.`,
)
console.log('')

process.exit(0)
