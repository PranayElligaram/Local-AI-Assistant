/**
 * The Windows lifecycle, for real: start, duplicate start, stop, restart, a
 * spoken restart, and a stale PID file - all in an isolated run directory and
 * on spare ports, so the user's running JARVIS is never touched.
 *
 * stop.ps1 is given its default grace period: the launcher legitimately takes
 * a couple of seconds to let the bridge cancel its turns and release its port,
 * and forcing it sooner would turn a clean stop into a kill.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const windows = process.platform === 'win32'

function harness(t, bridgePort, uiPort) {
  const run = mkdtempSync(join(tmpdir(), 'jarvis-launch-'))
  const env = {
    ...process.env,
    JARVIS_RUN_DIR: run,
    JARVIS_BRIDGE_PORT: String(bridgePort),
    PORT: String(uiPort),
    ELEVENLABS_API_KEY: '',
    JARVIS_OLLAMA_URL: 'http://127.0.0.1:9',
    JARVIS_WARM_MODEL: '0',
    JARVIS_UNLOAD_ON_EXIT: '0',
    JARVIS_APPS_FILE: join(run, 'apps.json'),
  }
  const processes = []
  const start = (command, args) => {
    const child = spawn(command, args, { cwd: ROOT, env, windowsHide: true })
    child.output = ''
    child.stdout.on('data', (d) => (child.output += d))
    child.stderr.on('data', (d) => (child.output += d))
    child.exited = new Promise((r) => child.on('exit', r))
    processes.push(child)
    return child
  }
  const stop = async () => {
    const child = start('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/stop.ps1'])
    assert.equal(await child.exited, 0, child.output)
  }
  const up = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${bridgePort}/health`)).ok && (await fetch(`http://localhost:${uiPort}`)).ok
    } catch {
      return false
    }
  }
  const ready = async (child) => {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(child.output)
      if (await up()) return
      await delay(100)
    }
    throw Error('start timed out: ' + child.output)
  }
  const pidFile = join(run, 'jarvis.pid')
  const bridgeFile = join(run, 'bridge.json')
  t.after(async () => {
    if (existsSync(pidFile)) await stop()
    for (const p of processes) if (p.exitCode === null) p.kill()
  })
  return { run, start, stop, ready, pidFile, bridgeFile, bridgePort }
}

test('Windows start, duplicate start, stop, restart, and cleanup preserve the live instance', { skip: !windows, timeout: 90000 }, async (t) => {
  const h = harness(t, 8796, 5196)
  const liveFile = join(ROOT, '.jarvis', 'bridge.json')
  const liveBefore = existsSync(liveFile) ? readFileSync(liveFile, 'utf8') : null

  const first = h.start(process.execPath, ['scripts/start.mjs'])
  await h.ready(first)
  const before = readFileSync(h.pidFile, 'utf8')

  // A second launcher must refuse, and must not touch the first one's files.
  const duplicate = h.start(process.execPath, ['scripts/start.mjs'])
  assert.equal(await duplicate.exited, 1)
  assert.match(duplicate.output, /already running/)
  assert.equal(readFileSync(h.pidFile, 'utf8'), before)

  await h.stop()
  assert.equal(await first.exited, 0, first.output)
  assert.equal(existsSync(h.pidFile), false)
  assert.equal(existsSync(h.bridgeFile), false)
  await assert.rejects(fetch(`http://127.0.0.1:${h.bridgePort}/health`))

  const second = h.start(process.execPath, ['scripts/start.mjs'])
  await h.ready(second)
  // Options given to restart.ps1 must reach the new instance: restarting
  // with -Writes has to produce a writes-mode JARVIS, not a silent default.
  const restart = h.start('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/restart.ps1', '-Writes', '-Monitor', '0'])
  await second.exited
  await h.ready(restart)
  const state = JSON.parse(readFileSync(h.pidFile, 'utf8'))
  assert.equal(state.writes, true, restart.output)
  const d = await (await fetch(`http://127.0.0.1:${h.bridgePort}/diagnostics`)).json()
  assert.equal(d.tools.writes, true)

  await h.stop()
  assert.equal(await restart.exited, 0, restart.output)
  await assert.rejects(fetch(`http://127.0.0.1:${h.bridgePort}/health`))
  assert.equal(existsSync(h.pidFile), false)
  assert.equal(existsSync(liveFile) ? readFileSync(liveFile, 'utf8') : null, liveBefore)
})

test('a spoken "restart Jarvis" replaces only the bridge, and stop still stops everything', { skip: !windows, timeout: 90000 }, async (t) => {
  const h = harness(t, 8794, 5194)
  const launcher = h.start(process.execPath, ['scripts/start.mjs'])
  await h.ready(launcher)
  const oldBridge = JSON.parse(readFileSync(h.bridgeFile, 'utf8')).pid

  const ws = new WebSocket(`ws://127.0.0.1:${h.bridgePort}/`, { headers: { origin: 'http://localhost:5194' } })
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  const answer = await new Promise((res) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'done') res(m)
    })
    ws.send(JSON.stringify({ type: 'ask', id: 'r', text: 'Restart Jarvis' }))
  })
  assert.equal(answer.tool, 'restart_jarvis')
  ws.close()

  let newBridge = oldBridge
  for (let i = 0; i < 150 && (newBridge === oldBridge || !(await fetch(`http://127.0.0.1:${h.bridgePort}/health`).then((r) => r.ok, () => false))); i++) {
    await delay(100)
    try {
      newBridge = JSON.parse(readFileSync(h.bridgeFile, 'utf8')).pid
    } catch {
      /* between bridges */
    }
  }
  assert.notEqual(newBridge, oldBridge, launcher.output)
  assert.equal(launcher.exitCode, null, 'the launcher itself kept running')
  const state = JSON.parse(readFileSync(h.pidFile, 'utf8'))
  assert.ok(state.children.includes(newBridge))
  assert.ok(state.childStartedAt[newBridge], 'the new bridge has its own start time for stop.ps1')

  await h.stop()
  assert.equal(await launcher.exited, 0, launcher.output)
  assert.equal(existsSync(h.pidFile), false)
})

test('a stale PID file left by a dead launcher does not block the next start', { skip: !windows, timeout: 60000 }, async (t) => {
  const h = harness(t, 8793, 5193)
  writeFileSync(h.pidFile, JSON.stringify({ launcher: 4194300, startedAt: '2020-01-01T00:00:00.000Z' }))
  const launcher = h.start(process.execPath, ['scripts/start.mjs'])
  await h.ready(launcher)
  assert.equal(JSON.parse(readFileSync(h.pidFile, 'utf8')).launcher, launcher.pid)
  await h.stop()
  assert.equal(await launcher.exited, 0, launcher.output)
})
