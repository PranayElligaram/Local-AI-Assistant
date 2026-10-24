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
const HERMES_ONLY = process.argv.includes('--hermes')
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
  /** Ask, interrupt on the first streamed words, report what leaked after. */
  const askAndInterrupt = (text) =>
    new Promise((res) => {
      const id = `e2e${++seq}`
      let interruptedAt = 0
      let lateFrames = 0
      const on = (raw) => {
        const m = JSON.parse(raw.toString())
        if (m.ask !== id) return
        if (interruptedAt) lateFrames++
        else if (m.type === 'text') {
          interruptedAt = Date.now()
          socket.send(JSON.stringify({ type: 'interrupt' }))
          setTimeout(() => {
            socket.off('message', on)
            res({ interrupted: true, lateFrames })
          }, 1500)
        }
      }
      socket.on('message', on)
      socket.send(JSON.stringify({ type: 'ask', id, text }))
      setTimeout(() => {
        if (interruptedAt) return
        socket.off('message', on)
        res({ interrupted: false, lateFrames })
      }, TURN_TIMEOUT_MS)
    })
  const diagnostics = async () => (await fetch(`http://127.0.0.1:${port}/diagnostics`)).json()
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok
  const stop = async () => {
    socket.close()
    child.stdin.end()
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)))
    rmSync(runDir, { recursive: true, force: true })
  }
  return { ask, askAndInterrupt, diagnostics, health, stop, log: () => log }
}

const aiAnswer = (r, model) =>
  !r.timeout &&
  r.type === 'done' &&
  r.source === 'ollama' &&
  (!model || r.model === model) &&
  Boolean(r.text?.trim()) &&
  !NOT_AN_ANSWER.test(r.text)


// The Ollama scenarios pin the provider: .env.local may select Hermes.
const OLLAMA = { JARVIS_BRAIN_PROVIDER: 'ollama' }

// --- deterministic + offline: Ollama deliberately unreachable -------------
if (!HERMES_ONLY) {
  const b = await startBridge(8781, { ...OLLAMA, JARVIS_OLLAMA_URL: 'http://127.0.0.1:9' })
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

if (!OFFLINE_ONLY && !HERMES_ONLY) {
  // --- local brain + tool: granite4:3b ------------------------------------
  const b = await startBridge(8782, { ...OLLAMA })
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
  const f = await startBridge(8783, { ...OLLAMA, JARVIS_LOCAL_MODEL: 'jarvis-missing-model:0b', JARVIS_MODEL_KEEP_ALIVE: '2m' })
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

// --- Hermes Agent: the real loopback gateway --------------------------------
// Needs `hermes gateway` with the API server enabled and JARVIS_HERMES_KEY in
// .env.local. Without them this is reported as SKIPPED - never as a pass.
let skipped = 0
if (!OFFLINE_ONLY) {
  const { BRAIN } = await import('../bridge/config.mjs')
  let gateway = false
  try {
    gateway = (await fetch(`${BRAIN.hermesUrl.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(3000) })).ok
  } catch {
    /* not running */
  }
  if (!BRAIN.hermesKey || !gateway) {
    skipped++
    console.log(`SKIP  hermes  ${BRAIN.hermesKey ? 'gateway not answering at ' + BRAIN.hermesUrl : 'JARVIS_HERMES_KEY not configured'}`)
  } else {
    const HERMES = { JARVIS_BRAIN_PROVIDER: 'hermes', JARVIS_HERMES_FALLBACK: 'ollama' }
    const hermesAnswer = (r) =>
      !r.timeout && r.type === 'done' && r.source === 'hermes' && Boolean(r.text?.trim()) && !NOT_AN_ANSWER.test(r.text)
    const h = await startBridge(8784, HERMES)
    try {
      const before = await h.diagnostics()
      const allowed = ['web_search', 'web_extract'] // HERMES_SAFE_TOOLS
      check(
        before.brain.provider === 'hermes' && before.brain.primary.ok && before.brain.primary.tools.every((t) => allowed.includes(t)),
        'hermes: gateway healthy, only allowlisted tools enabled',
        `tools [${before.brain.primary.tools}]`,
        JSON.stringify(before.brain),
      )
      const answer = await h.ask('Explain the difference between a CPU and a GPU.')
      check(hermesAnswer(answer) && answer.frames > 1, 'hermes: conversational answer streamed', `${answer.frames} frames: ${answer.text}`, JSON.stringify(answer))

      const time = await h.ask('What time is it?')
      const open = await h.ask('Open Spotify')
      const mid = await h.diagnostics()
      check(
        time.source === 'router' && open.source === 'router' && open.tool === 'open_application' && mid.brain.aiTurns === 1,
        'hermes: deterministic commands bypass Hermes',
        `${time.text} / ${open.text} (AI turns still ${mid.brain.aiTurns})`,
        JSON.stringify({ time, open, aiTurns: mid.brain.aiTurns }),
      )

      // Not a strict command: in Hermes mode JARVIS recognises it itself (a 4B
      // agent following an "ask JARVIS" protocol measured ~60% reliable), and
      // only because Calculator is installed. Dry run: nothing really opens.
      const sums = await h.ask("I'd like to do some sums, could you get the calculator going?")
      const afterSums = await h.diagnostics()
      check(
        sums.source === 'router' && sums.tool === 'open_application' && afterSums.apps.lastResolved === 'Calculator' && afterSums.apps.lastLaunch === 'ok (dry run)',
        'hermes mode: natural app request -> JARVIS opens the installed app',
        `${sums.text} (resolved ${afterSums.apps.lastResolved}, ${afterSums.apps.lastLaunch})`,
        `${JSON.stringify(sums)} apps=${JSON.stringify(afterSums.apps)}`,
      )

      await h.ask('For this conversation, my favourite colour is teal. Reply in one short sentence.')
      const recall = await h.ask('What is my favourite colour?')
      check(hermesAnswer(recall) && /teal/i.test(recall.text), 'hermes: session remembers earlier turns', recall.text, JSON.stringify(recall))

      const cut = await h.askAndInterrupt('Write a detailed 500 word essay on the history of computing.')
      const next = await h.ask('Reply with just the word ready.')
      check(
        cut.interrupted && cut.lateFrames === 0 && hermesAnswer(next) && /ready/i.test(next.text),
        'hermes: barge-in cancels; next turn answers cleanly',
        `late frames ${cut.lateFrames}, next: ${next.text}`,
        JSON.stringify({ cut, next }),
      )
      const after = await h.diagnostics()
      check(
        !JSON.stringify(after).includes(BRAIN.hermesKey) && after.brain.cloudRequired === null && after.brain.claudeRuntime === 'none',
        'hermes: diagnostics never contain the API key',
        `cloud required ${after.brain.cloudRequired}, Claude runtime ${after.brain.claudeRuntime}`,
        'key or Claude runtime present in diagnostics',
      )
    } catch (err) {
      fail('hermes bridge', err.message)
    } finally {
      await h.stop()
    }

    // Hermes down: deterministic commands keep working; conversation falls back to Ollama.
    const down = await startBridge(8785, { ...HERMES, JARVIS_HERMES_URL: 'http://127.0.0.1:9/v1' })
    try {
      const time = await down.ask('What time is it?')
      const chat = await down.ask('In one short sentence, what is a keyboard for?')
      check(
        time.source === 'router' && time.ok && chat.source === 'ollama' && chat.fallbackUsed === true && aiAnswer(chat),
        'hermes down: router works, Ollama answers',
        `${time.text} / ${chat.model}: ${chat.text}`,
        JSON.stringify({ time, chat }),
      )
    } catch (err) {
      fail('hermes-down bridge', err.message)
    } finally {
      await down.stop()
    }

    // Wrong key with fallback disabled: an honest failure, and JARVIS stays up.
    const strict = await startBridge(8786, { ...HERMES, JARVIS_HERMES_FALLBACK: 'none', JARVIS_HERMES_KEY: 'wrong-key-for-e2e' })
    try {
      const chat = await strict.ask('Tell me something interesting about the moon.')
      const time = await strict.ask('What time is it?')
      const d = await strict.diagnostics()
      check(
        chat.source === 'unavailable' && /authentication failed/.test(d.brain.lastError) && time.ok && (await strict.health()),
        'hermes bad key, no fallback: explicit failure, JARVIS alive',
        `"${chat.text}" (${d.brain.lastError})`,
        JSON.stringify({ chat, time, err: d.brain.lastError }),
      )
    } catch (err) {
      fail('hermes-strict bridge', err.message)
    } finally {
      await strict.stop()
    }
  }
}

console.log(`\n${results.length - failures} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(failures ? 1 : 0)
