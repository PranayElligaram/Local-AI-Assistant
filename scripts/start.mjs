/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so `npm start` is the whole story.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the browser, run
 * shell, send things): `npm start -- --writes`, or `npm run start:writes`.
 *
 * Windows notes, since that is the primary target here:
 *   - both children are spawned with THIS Node (process.execPath) rather than
 *     whatever `node` happens to be first on PATH. On a machine with several
 *     Node versions installed — normal — that is the difference between a
 *     working bridge and a stack trace from inside a dependency.
 *   - a PID file is written so scripts\stop.ps1 can stop exactly this instance
 *     rather than every node.exe on the machine.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

const MIN_NODE_MAJOR = 20
const major = Number(process.versions.node.split('.')[0])
if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
  console.error(
    `\nThis is Node ${process.versions.node}. JARVIS needs Node ${MIN_NODE_MAJOR} or newer.\n` +
      'On Windows, start it with:  powershell -ExecutionPolicy Bypass -File scripts\\jarvis.ps1\n' +
      'which finds a suitable Node (Volta, nvm4w, or Program Files) for you.\n',
  )
  process.exit(1)
}

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over: the page's CSP names no CDN in `script-src`,
 * and a CDN import is a live supply-chain dependency. Copying it out of
 * node_modules is served from our own origin and is the exact bytes of the
 * version in the lockfile. It stays out of git.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, args, colour, env) {
  const label = paint(name, colour)
  // Always this Node. See the header: `node` on PATH is not necessarily the
  // one running this launcher, and on Windows it usually is not.
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    shell: false,
    // stdin is a pipe on purpose: closing it is how this launcher asks the
    // bridge to stop gracefully. On Windows a SIGTERM is TerminateProcess,
    // which would orphan the agent's own `claude` child process.
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('error', (err) => {
    console.error(`\x1b[${colour}m${name}\x1b[0m could not start: ${err.message}`)
    shutdown(1)
  })
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

/**
 * Which processes belong to this instance.
 *
 * Written so stop.ps1 can stop JARVIS specifically. Windows has no process
 * groups worth relying on here, and "kill every node.exe" is the kind of stop
 * command that also kills the editor's language server.
 */
const RUN_DIR = join(ROOT, '.jarvis')
const PID_FILE = join(RUN_DIR, 'jarvis.pid')

function writePidFile() {
  try {
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(
      PID_FILE,
      JSON.stringify(
        {
          launcher: process.pid,
          children: children.map((c) => c.pid).filter(Boolean),
          port: Number(process.env.JARVIS_BRIDGE_PORT ?? 8787),
          ui: `http://localhost:${process.env.PORT ?? 5173}`,
          startedAt: new Date().toISOString(),
          writes,
        },
        null,
        2,
      ),
    )
  } catch (err) {
    console.warn(`  could not write ${PID_FILE}: ${err.message}`)
  }
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      // Ask first: closing stdin is the signal the bridge listens for, and it
      // is the only one that works the same way on Windows and everywhere
      // else. The kill below is the follow-up for anything that ignores it.
      c.stdin?.end()
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    for (const c of children) {
      try {
        c.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }, 400).unref()
  try {
    rmSync(PID_FILE, { force: true })
  } catch {
    /* nothing to clean up */
  }
  // Long enough for the bridge to close its sockets and reap the agent's own
  // child; short enough that Ctrl-C still feels like Ctrl-C.
  setTimeout(() => process.exit(code), 1500)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
// Windows console close / Ctrl-Break, which otherwise leaves both children
// running with no terminal attached to stop them from.
process.on('SIGHUP', () => shutdown(0))
process.on('SIGBREAK', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every tool on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', ['bridge/server.mjs', ...(writes ? ['--writes'] : [])], '36', bridgeEnv)
run('face', ['node_modules/vite/bin/vite.js'], '35', {})
writePidFile()

console.log(
  `\nWhen it says the dev server is ready, open http://localhost:${port ?? 5173} in Chrome or Edge\n` +
    '(a real window — an embedded preview pane cannot use the microphone),\n' +
    'click INITIALISE, allow the microphone, and say "Hey Jarvis".\n' +
    'Ctrl-C stops everything; so does scripts\\stop.ps1 from another terminal.\n',
)
