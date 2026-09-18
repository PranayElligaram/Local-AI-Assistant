/**
 * The bridge, actually running.
 *
 * Everything else in this suite is a pure function. This one starts the real
 * process on a spare port and asks it questions over HTTP, because the failures
 * worth catching here are the ones that only exist once a socket is open: a
 * refused origin, a missing key reported as a crash instead of a 503, a
 * shutdown that leaves the port held.
 *
 * Ollama is pointed at a closed port for the whole run, so every turn here
 * proves what JARVIS does WITHOUT its model: deterministic commands still
 * answer, conversation says plainly that the brain is unavailable, and the
 * process stays up. The socket handshake is also exercised through its
 * rejection paths, which are the security-relevant half.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_DIR = mkdtempSync(join(tmpdir(), 'jarvis-run-'))
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const ALLOWED = 'http://localhost:5173'

let bridge
let output = ''

async function waitForHealth(deadlineMs = 25000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (bridge.exitCode !== null) {
      throw new Error(`the bridge exited early (${bridge.exitCode}):\n${output}`)
    }
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(`the bridge never answered:\n${output}`)
}

test.before(async () => {
  bridge = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: String(PORT),
      JARVIS_RUN_DIR: RUN_DIR,
      // No key: this run must exercise the keyless fallback path, whatever the
      // developer happens to have in their own .env.
      ELEVENLABS_API_KEY: '',
      // Ollama deliberately unreachable: every assertion here must hold with
      // no model at all. Launches are dry runs; user app settings are scratch.
      JARVIS_OLLAMA_URL: 'http://127.0.0.1:9',
      JARVIS_LAUNCH_DRY_RUN: '1',
      JARVIS_WARM_MODEL: '0',
      JARVIS_UNLOAD_ON_EXIT: '0',
      JARVIS_APPS_FILE: join(RUN_DIR, 'apps.json'),
    },
  })
  bridge.stdout.on('data', (d) => (output += d))
  bridge.stderr.on('data', (d) => (output += d))
  await waitForHealth()
})

test.after(async () => {
  if (!bridge || bridge.exitCode !== null) return
  bridge.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 800))
})

test('/health reports the keyless fallback rather than failing', async () => {
  const res = await fetch(`${BASE}/health`, { headers: { origin: ALLOWED } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { ok: true, tts: false, stt: false })
})

test('the banner names what it loaded, and never a secret', () => {
  assert.match(output, /bridge listening on ws:\/\/localhost:8799/)
  assert.match(output, /no ElevenLabs key/)
  assert.match(output, /local Ollama .* primary granite4:3b .* fallback qwen3\.5:4b/)
  assert.match(output, /no cloud, no Claude/)
  assert.match(output, /mode safe \(read-only\)/)
  assert.ok(!/ELEVENLABS_API_KEY=\S/.test(output))
})

test('/diagnostics states the local brain, its health, and the isolation', async () => {
  const res = await fetch(`${BASE}/diagnostics`, { headers: { origin: ALLOWED } })
  assert.equal(res.status, 200)
  const d = await res.json()
  assert.equal(d.isolation.globalClaudeConfigRead, false)
  assert.deepEqual(d.isolation.mcpServers, [])
  assert.equal(d.brain.mode, 'local')
  assert.equal(d.brain.provider, 'ollama')
  assert.equal(d.brain.primary.model, 'granite4:3b')
  assert.equal(d.brain.fallback.model, 'qwen3.5:4b')
  // Ollama is down in this run, and the panel must say so rather than go green.
  assert.equal(d.brain.primary.ok, false)
  assert.equal(d.brain.primary.reachable, false)
  assert.equal(d.brain.cloudRequired, false)
  assert.equal(d.brain.claudeRuntime, 'none')
  assert.equal(d.tools.writes, false)
  assert.equal(d.tools.mode, 'safe')
  assert.equal(d.bridge.ownsRunFile, true)
  assert.ok('count' in d.apps && 'lastLaunch' in d.apps)
  assert.equal(d.speech.elevenlabsConfigured, false)
  assert.equal(d.bridge.port, PORT)
  assert.ok(d.bridge.uptimeSeconds >= 0)
  // Nothing private, even in the shape of the payload.
  assert.ok(!JSON.stringify(d).toLowerCase().includes('api_key'))
})

/** One WebSocket turn, the way the page asks. */
async function askOnce(text) {
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { origin: ALLOWED } })
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  const done = await new Promise((res) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.ask === 't' && (m.type === 'done' || m.type === 'error')) res(m)
    })
    ws.send(JSON.stringify({ type: 'ask', id: 't', text }))
  })
  ws.close()
  return done
}

test('with Ollama stopped, time and apps still work and conversation says why it cannot', async () => {
  const time = await askOnce('What time is it?')
  assert.equal(time.source, 'router')
  assert.equal(time.tool, 'get_time')
  const app = await askOnce('Open Calculator')
  assert.equal(app.source, 'router')
  assert.equal(app.tool, 'open_application')
  const chat = await askOnce('Tell me a joke')
  assert.equal(chat.type, 'done')
  assert.equal(chat.source, 'unavailable')
  assert.equal(chat.text, 'My local AI brain is unavailable right now.')
  // Still alive afterwards.
  assert.equal((await fetch(`${BASE}/health`)).status, 200)
  const d = await (await fetch(`${BASE}/diagnostics`)).json()
  assert.equal(d.brain.aiTurns, 0)
  assert.ok(d.brain.unavailableTurns >= 1)
  assert.match(d.brain.lastError, /offline/)
})

test('a page from somewhere else is refused outright', async () => {
  const res = await fetch(`${BASE}/health`, {
    headers: { origin: 'http://evil.example.com' },
  })
  assert.equal(res.status, 403)
})

/**
 * A raw WebSocket handshake, written by hand.
 *
 * `fetch` refuses to send an Upgrade request, so the one thing worth testing
 * here — that a page from elsewhere is turned away during the handshake rather
 * than after the socket is open — needs a plain socket and the status line.
 */
function handshake(origin, path = '/') {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, '127.0.0.1', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${PORT}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...(origin ? [`Origin: ${origin}`] : []),
          '',
          '',
        ].join('\r\n'),
      )
    })
    socket.setTimeout(5000)
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk
      if (data.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(data.split('\r\n')[0])
      }
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('handshake timed out'))
    })
    socket.on('error', reject)
  })
}

test('the websocket handshake is refused from a disallowed origin', async () => {
  assert.match(await handshake('http://evil.example.com'), /403/)
})

test('the websocket handshake is refused with no origin at all', async () => {
  // A client sending no Origin is a script or a native app — also exactly what
  // local malware looks like, so it is refused unless explicitly permitted.
  assert.match(await handshake(null), /403/)
})

test('the websocket is refused on an unexpected path even from a good origin', async () => {
  assert.match(await handshake(ALLOWED, '/admin'), /403/)
})

test('speech endpoints report the missing key instead of crashing', async () => {
  const tts = await fetch(`${BASE}/tts`, {
    method: 'POST',
    headers: { origin: ALLOWED, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'testing' }),
  })
  assert.equal(tts.status, 503)
  assert.equal(await tts.text(), 'no elevenlabs key')

  const stt = await fetch(`${BASE}/stt`, {
    method: 'POST',
    headers: { origin: ALLOWED, 'content-type': 'audio/webm' },
    body: new Uint8Array(2048),
  })
  assert.equal(stt.status, 503)
})

test('a malformed request does not take the bridge down', async () => {
  const res = await fetch(`${BASE}/tts`, {
    method: 'POST',
    headers: { origin: ALLOWED, 'content-type': 'application/json' },
    body: 'not json at all',
  })
  // 503 (no key, checked first) or 400 (bad json) — the point is that the
  // process survives, which the next request proves.
  assert.ok([400, 503].includes(res.status))
  const after = await fetch(`${BASE}/health`, { headers: { origin: ALLOWED } })
  assert.equal(after.status, 200)
})

test('/file refuses anything that is not an image inside the allowed roots', async () => {
  const res = await fetch(
    `${BASE}/file?path=${encodeURIComponent(join(ROOT, 'package.json'))}`,
    { headers: { origin: ALLOWED } },
  )
  assert.equal(res.status, 400)
})

test('the media proxy refuses a private address', async () => {
  const res = await fetch(`${BASE}/img?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`, {
    headers: { origin: ALLOWED },
  })
  assert.ok(res.status >= 400, 'cloud metadata must never be proxied')
})

test('a second bridge on the same port refuses to start, and says why', async () => {
  const second = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, JARVIS_BRIDGE_PORT: String(PORT), JARVIS_RUN_DIR: RUN_DIR },
  })
  let text = ''
  second.stdout.on('data', (d) => (text += d))
  second.stderr.on('data', (d) => (text += d))
  const code = await new Promise((r) => second.on('exit', r))
  assert.equal(code, 1)
  assert.match(text, /already in use/)
})

test('a shutdown request without the token is refused', async () => {
  const res = await fetch(`${BASE}/shutdown`, {
    method: 'POST',
    headers: { origin: ALLOWED, 'x-jarvis-token': 'not-the-token' },
  })
  assert.equal(res.status, 403)
  // ...and it is still running.
  assert.equal((await fetch(`${BASE}/health`, { headers: { origin: ALLOWED } })).status, 200)
})

test('the token lets it shut down cleanly and frees the port', async () => {
  // This is the path stop.ps1 uses, and it exists because on Windows a
  // SIGTERM is TerminateProcess: no handler runs, the sockets are never
  // closed, and in-flight turns are never cancelled.
  const run = JSON.parse(readFileSync(join(RUN_DIR, 'bridge.json'), 'utf8'))
  assert.equal(run.port, PORT)
  assert.ok(run.token)

  const res = await fetch(`${BASE}/shutdown`, {
    method: 'POST',
    headers: { origin: ALLOWED, 'x-jarvis-token': run.token },
  })
  assert.equal(res.status, 200)

  const code = await new Promise((r) => bridge.on('exit', r))
  assert.equal(code, 0)
  assert.match(output, /shutting down/)

  // The port must actually be free, or the next start lands on "already in use".
  await assert.rejects(
    fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }),
    'the bridge should no longer be listening',
  )
})
