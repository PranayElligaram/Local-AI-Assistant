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

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

const MIN_NODE_MAJOR = 20
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < MIN_NODE_MAJOR || (major === 20 && minor < 19) || major === 21 || (major === 22 && minor < 12)) {
  console.error(
    `\nThis is Node ${process.versions.node}. JARVIS needs Node 20.19+ or 22.12+ (Vite requirement).\n` +
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
/** When each child started, so stop.ps1 can tell a live child from a reused PID. */
const childStartedAt = {}

/** The bridge asks for a fresh copy of itself with this exit code ("restart Jarvis"). */
const RESTART_EXIT_CODE = 75
const MAX_RESTARTS = 5
const restarts = []

function run(name, args, colour, env) {
  const label = paint(name, colour)
  // Always this Node. See the header: `node` on PATH is not necessarily the
  // one running this launcher, and on Windows it usually is not.
  const child = spawn(process.execPath, [resolve(ROOT, args[0]), ...args.slice(1)], {
    env: { ...process.env, ...env },
    shell: false,
    // stdin is a pipe on purpose: closing it is how this launcher asks the
    // bridge to stop gracefully. On Windows a SIGTERM is TerminateProcess,
    // which would skip the bridge's own cleanup.
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('error', (err) => {
    console.error(`\x1b[${colour}m${name}\x1b[0m could not start: ${err.message}`)
    shutdown(1)
  })
  child.on('exit', (code) => {
    const at = children.indexOf(child)
    if (at !== -1) children.splice(at, 1)
    delete childStartedAt[child.pid]
    if (stopping) {
      if (children.length === 0) finish()
      return
    }
    // A spoken "restart Jarvis": a fresh bridge on the same port, same face.
    // Bounded, so a bridge that exits 75 on every start cannot loop for ever.
    if (name === 'bridge' && code === RESTART_EXIT_CODE) {
      const now = Date.now()
      while (restarts.length && now - restarts[0] > 10 * 60_000) restarts.shift()
      if (restarts.length < MAX_RESTARTS) {
        restarts.push(now)
        console.log(`\x1b[${colour}m${name}\x1b[0m restarting on request.`)
        run(name, args, colour, env)
        writePidFile()
        return
      }
      console.error('The bridge asked to restart too often; stopping instead.')
    }
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code === RESTART_EXIT_CODE ? 1 : (code ?? 0))
  })
  child.jarvisName = name
  children.push(child)
  childStartedAt[child.pid] = new Date().toISOString()
  return child
}

/**
 * Which processes belong to this instance.
 *
 * Written so stop.ps1 can stop JARVIS specifically. Windows has no process
 * groups worth relying on here, and "kill every node.exe" is the kind of stop
 * command that also kills the editor's language server.
 */
const RUN_DIR = resolve(process.env.JARVIS_RUN_DIR || join(ROOT, '.jarvis'))
const PID_FILE = join(RUN_DIR, 'jarvis.pid')

let ownsPidFile = false
const startedAt = new Date().toISOString()

/**
 * Is the launcher recorded in an existing PID file still running? A PID alone
 * is not proof - Windows reuses them - so on Windows the process must also
 * still be a node.exe.
 */
function launcherAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (err.code === 'ESRCH') return false
    throw err
  }
  if (process.platform !== 'win32') return true
  const out = spawnSync('tasklist.exe', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (out.status !== 0) return true // cannot tell: assume alive, never steal
  return /^"node(\.exe)?"/im.test(out.stdout)
}

function claimPidFile() {
  mkdirSync(RUN_DIR, { recursive: true })
  if (existsSync(PID_FILE)) {
    let previous = null
    try {
      previous = JSON.parse(readFileSync(PID_FILE, 'utf8'))
    } catch {
      // Unreadable: either a crash mid-write long ago (stale), or another
      // launcher writing it this instant (not ours to touch).
      if (Date.now() - statSync(PID_FILE).mtimeMs < 10_000) throw new Error('another start is in progress')
    }
    if (previous && Number.isInteger(previous.launcher) && launcherAlive(previous.launcher)) {
      throw new Error(`launcher PID ${previous.launcher} is running`)
    }
    rmSync(PID_FILE, { force: true })
  }
  // Exclusive creation prevents two simultaneous starts from taking ownership.
  const fd = openSync(PID_FILE, 'wx')
  ownsPidFile = true
  writeFileSync(fd, JSON.stringify({ launcher: process.pid, startedAt }))
  closeSync(fd)
}

function writePidFile() {
  try {
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(
      PID_FILE,
      JSON.stringify(
        {
          launcher: process.pid,
          children: children.map((c) => c.pid).filter(Boolean),
          childStartedAt,
          port: Number(process.env.JARVIS_BRIDGE_PORT ?? 8787),
          ui: `http://localhost:${process.env.PORT ?? 5173}`,
          startedAt,
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
let exitCode = 0
let exited = false

/** Everything this launcher started is gone: release the PID file and leave. */
function finish() {
  if (exited) return
  exited = true
  try {
    if (ownsPidFile) rmSync(PID_FILE, { force: true })
  } catch {
    /* nothing to clean up */
  }
  process.exit(exitCode)
}

function shutdown(code) {
  if (stopping) return
  stopping = true
  exitCode = code
  if (children.length === 0) return finish()
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
  // Vite has no graceful-stop channel worth waiting for; the bridge does, and
  // gets up to 2.5 seconds to cancel its turns and release its port.
  setTimeout(() => {
    for (const c of children) {
      if (c.jarvisName === 'bridge') continue
      try {
        c.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }, 300).unref()
  setTimeout(() => {
    for (const c of children) {
      try {
        c.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }, 2500).unref()
  // The backstop: exit even if a child never reports its own exit.
  setTimeout(finish, 3500)
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

try {
  claimPidFile()
} catch (err) {
  console.error('JARVIS is already running, or its PID file is inaccessible. Use scripts\\stop.ps1 before starting again.', err.message)
  process.exit(1)
}

vendorWasm()

console.log('\nJ.A.R.V.I.S. starting - the local brain and the face.\n')
run('bridge', ['bridge/server.mjs', ...(writes ? ['--writes'] : [])], '36', bridgeEnv)
run('face', ['node_modules/vite/bin/vite.js'], '35', {})
writePidFile()

console.log(
  `\nWhen it says the dev server is ready, open http://localhost:${port ?? 5173} in Chrome or Edge\n` +
    '(a real window — an embedded preview pane cannot use the microphone),\n' +
    'click INITIALISE, allow the microphone, and say "Hey Jarvis".\n' +
    'Ctrl-C stops everything; so does scripts\\stop.ps1 from another terminal.\n',
)
