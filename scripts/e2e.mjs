#!/usr/bin/env node
/**
 * End-to-end checks against REAL bridges, without a microphone.
 *
 *   npm run e2e              all scenarios (needs Ollama with granite4:3b and qwen3.5:4b)
 *   npm run e2e:offline      deterministic + offline only (needs nothing)
 *
 * Each scenario starts its own bridge on a spare port with an isolated run
 * directory, so a running JARVIS is never touched, and with application
 * launches in DRY RUN, so nothing actually opens on the desktop.
 *
 * A turn only counts as an AI answer when the bridge says the local model
 * produced it (source "ollama") and the text is real. An "unavailable"
 * sentence, a provider error, a quota message, a connection failure or a
 * malformed reply is never a pass.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE_ONLY = process.argv.includes('--offline')
const TURN_TIMEOUT_MS = Number(process.env.JARVIS_E2E_TIMEOUT_MS ?? 150_000)
const ORIGIN = 'http://localhost:5173'
const NOT_AN_ANSWER = /unavailable|error|quota|limit|rate.?limit|unauthori[sz]ed|forbidden|session|failed|ECONN/i

let failures = 0
const results = []
const pass = (name, detail) => {
  results.push(['PASS', name, detail])
  console.log(`PASS  ${name}  ${detail}`)
}
const fail = (name, detail) => {
  failures++
  results.push(['FAIL', name, detail])
  console.log(`FAIL  ${name}  ${detail}`)
}
/** Record one scenario: `detail` on a pass, `evidence` (the raw frame) on a failure. */
const check = (ok, name, detail, evidence) => (ok ? pass(name, detail) : fail(name, evidence))

async function startBridge(port, env) {
  const runDir = mkdtempSync(join(tmpdir(), 'jarvis-e2e-'))
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: String(port),
      JARVIS_RUN_DIR: runDir,
      JARVIS_LAUNCH_DRY_RUN: '1',
      JARVIS_WARM_MODEL: '0',
      JARVIS_UNLOAD_ON_EXIT: '0',
      JARVIS_APPS_FILE: join(runDir, 'apps.json'),
      ELEVENLABS_API_KEY: '',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`bridge exited: ${log}`)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { origin: ORIGIN } })
  await new Promise((res, rej) => {
    socket.once('open', res)
    socket.once('error', rej)
  })
  let seq = 0
  const ask = (text) =>
    new Promise((res) => {
      const id = `e2e${++seq}`
      let streamed = ''
      let frames = 0
      const timer = setTimeout(() => {
        socket.off('message', on)
        res({ timeout: true, streamed, frames })
      }, TURN_TIMEOUT_MS)
      const on = (raw) => {
        const m = JSON.parse(raw.toString())
        if (m.ask !== id) return
        if (m.type === 'text') {
          streamed += m.delta
          frames++
        }
        if (m.type === 'done' || m.type === 'error') {
          clearTimeout(timer)
          socket.off('message', on)
          res({ ...m, streamed, frames })
        }
      }
      socket.on('message', on)
      socket.send(JSON.stringify({ type: 'ask', id, text }))
    })
  const diagnostics = async () => (await fetch(`http://127.0.0.1:${port}/diagnostics`)).json()
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok
  const stop = async () => {
    socket.close()
    child.stdin.end()
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)))
    rmSync(runDir, { recursive: true, force: true })
  }
  return { ask, diagnostics, health, stop, log: () => log }
}

const aiAnswer = (r, model) =>
  !r.timeout &&
  r.type === 'done' &&
  r.source === 'ollama' &&
  (!model || r.model === model) &&
  Boolean(r.text?.trim()) &&
  !NOT_AN_ANSWER.test(r.text)


// --- deterministic + offline: Ollama deliberately unreachable -------------
{
  const b = await startBridge(8781, { JARVIS_OLLAMA_URL: 'http://127.0.0.1:9' })
  try {
    const time = await b.ask('What time is it?')
    check(time.source === 'router' && time.tool === 'get_time' && /^It's \d/.test(time.text), 'deterministic: time', time.text, JSON.stringify(time))

    const date = await b.ask("What's today's date?")
    check(date.source === 'router' && date.tool === 'get_date' && /^Today is /.test(date.text), 'deterministic: date', date.text, JSON.stringify(date))

    const open = await b.ask('Open Calculator')
    check(open.source === 'router' && open.tool === 'open_application' && open.ok, 'deterministic: open application', open.text, JSON.stringify(open))

    const d = await b.diagnostics()
    check(
      d.brain.aiTurns === 0 && !d.brain.primary.reachable,
      'deterministic: Ollama not needed',
      `AI turns ${d.brain.aiTurns}, Ollama reachable ${d.brain.primary.reachable}`,
      JSON.stringify(d.brain),
    )

    const chat = await b.ask('Tell me something interesting about the moon.')
    check(chat.source === 'unavailable' && /unavailable/i.test(chat.text), 'offline: conversation degrades honestly', chat.text, JSON.stringify(chat))

    const again = await b.ask('What time is it?')
    check(
      (await b.health()) && again.source === 'router' && again.ok,
      'offline: JARVIS stays alive',
      'health 200 and the next command still works',
      JSON.stringify(again),
    )
  } catch (err) {
    fail('offline bridge', err.message)
  } finally {
    await b.stop()
  }
}

if (!OFFLINE_ONLY) {
  // --- local brain + tool: granite4:3b ------------------------------------
  const b = await startBridge(8782, {})
  try {
    const answer = await b.ask('In one short sentence, what does a CPU do?')
    check(aiAnswer(answer, 'granite4:3b') && answer.frames > 0, 'local brain: granite answers', `${answer.model}: ${answer.text}`, JSON.stringify(answer))

    const tool = await b.ask("I'd like to do some sums, could you get the calculator going?")
    const d = await b.diagnostics()
    check(
      aiAnswer(tool, 'granite4:3b') &&
        tool.tools?.includes('open_application') &&
        d.apps.lastResolved === 'Calculator' &&
        d.apps.lastLaunch === 'ok (dry run)',
      'tool: natural request -> open_application',
      `${tool.text} (resolved ${d.apps.lastResolved}, ${d.apps.lastLaunch})`,
      `${JSON.stringify(tool)} apps=${JSON.stringify(d.apps)}`,
    )
    check(
      d.brain.lastModel === 'granite4:3b' && d.brain.cloudRequired === false && d.brain.claudeRuntime === 'none',
      'diagnostics: local-only brain',
      `last model ${d.brain.lastModel}, ${d.brain.lastLatencyMs} ms`,
      JSON.stringify(d.brain),
    )
  } catch (err) {
    fail('local brain bridge', err.message)
  } finally {
    await b.stop()
  }

  // --- fallback: the primary model is missing, qwen answers ---------------
  const f = await startBridge(8783, { JARVIS_LOCAL_MODEL: 'jarvis-missing-model:0b', JARVIS_MODEL_KEEP_ALIVE: '2m' })
  try {
    const answer = await f.ask('In one short sentence, what is a keyboard for?')
    check(
      aiAnswer(answer, 'qwen3.5:4b') && answer.fallbackUsed === true,
      'fallback: primary failure -> qwen3.5:4b',
      answer.text,
      JSON.stringify(answer),
    )
  } catch (err) {
    fail('fallback bridge', err.message)
  } finally {
    await f.stop()
  }
}

console.log(`\n${results.length - failures} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
