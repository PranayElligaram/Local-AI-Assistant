/**
 * ElevenLabs is optional, and a key is not a capability.
 *
 * A fake ElevenLabs refuses both speech and transcription (the measured case on
 * this machine was a key with text_to_speech but not speech_to_text). The
 * bridge must remember each refusal, stop calling the refused endpoint, and
 * say so in /health so the browser uses its own recogniser and voice.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBrowserModule } from './browser-modules.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8797
const BASE = `http://127.0.0.1:${PORT}`

test('refused ElevenLabs capabilities are remembered, reported, and not retried', async (t) => {
  const hits = { tts: 0, stt: 0 }
  const fake = createServer((req, res) => {
    req.resume()
    if (req.url.startsWith('/v1/text-to-speech')) hits.tts++
    if (req.url.startsWith('/v1/speech-to-text')) hits.stt++
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"detail":{"status":"missing_permissions"}}')
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => fake.close(r)))

  const runDir = mkdtempSync(join(tmpdir(), 'jarvis-speech-'))
  const bridge = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: String(PORT),
      JARVIS_RUN_DIR: runDir,
      JARVIS_OLLAMA_URL: 'http://127.0.0.1:9',
      JARVIS_WARM_MODEL: '0',
      JARVIS_UNLOAD_ON_EXIT: '0',
      JARVIS_APPS_FILE: join(runDir, 'apps.json'),
      ELEVENLABS_API_KEY: 'test-key-not-real',
      JARVIS_ELEVENLABS_BASE: `http://127.0.0.1:${fake.address().port}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let log = ''
  bridge.stdout.on('data', (d) => (log += d))
  bridge.stderr.on('data', (d) => (log += d))
  t.after(async () => {
    bridge.stdin.end()
    await new Promise((r) => (bridge.exitCode !== null ? r() : bridge.once('exit', r)))
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  assert.deepEqual(await (await fetch(`${BASE}/health`)).json(), { ok: true, tts: true, stt: true })

  const speak = () =>
    fetch(`${BASE}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello.' }) })
  const listen = () =>
    fetch(`${BASE}/stt`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(4000, 1) })

  assert.ok(!(await speak()).ok)
  assert.ok(!(await listen()).ok)
  assert.deepEqual(await (await fetch(`${BASE}/health`)).json(), { ok: true, tts: false, stt: false })

  // Asked again: refused locally, the upstream is not called a second time.
  assert.equal((await speak()).status, 403)
  assert.equal((await listen()).status, 403)
  assert.deepEqual(hits, { tts: 1, stt: 1 })

  const d = await (await fetch(`${BASE}/diagnostics`)).json()
  assert.equal(d.speech.elevenlabsTtsDenied, true)
  assert.equal(d.speech.elevenlabsSttDenied, true)
  assert.ok(!log.includes('test-key-not-real'), 'the key never reaches a log line')
  assert.ok(!JSON.stringify(d).includes('test-key-not-real'))
})

test('the browser picks its own speech when the bridge reports no capability', async (t) => {
  let health = { ok: true, tts: true, stt: false }
  globalThis.fetch = async () => ({ ok: true, json: async () => health })
  t.after(() => delete globalThis.fetch)
  const caps = await loadBrowserModule('src/lib/capabilities.ts', {
    '../config': "export const BRIDGE_HTTP_URL = 'http://test.invalid'",
  })
  await caps.probeCapabilities()
  assert.deepEqual(caps.caps(), { stt: false, tts: true })
  assert.equal(caps.engineLabel(), 'ElevenLabs voice')

  health = { ok: true, tts: false, stt: false }
  await caps.probeCapabilities()
  assert.equal(caps.engineLabel(), 'browser speech')

  // A bridge that is down leaves the browser on its own engines, not broken.
  globalThis.fetch = async () => {
    throw new Error('connection refused')
  }
  await caps.probeCapabilities()
  assert.equal(caps.capabilitiesProbed(), true)
})
