/**
 * The development workspace: one clap, three windows.
 *
 *   monitor 1   the JARVIS interface
 *   monitor 2   the Claude desktop app
 *   monitor 3   Git Bash running Claude Code in the Impromptu website repo
 *
 * Everything that is started here is fixed, trusted configuration in this
 * file. Nothing reaches it from the model or from a spoken sentence: start()
 * takes a trigger label and nothing else, and the tool that calls it is
 * router-only. There is no path, command or monitor number to supply.
 *
 * Idempotent by construction: a window that is already there is reused and
 * repositioned, never started again, and a start that arrives while another is
 * running is dropped. Nothing is ever closed or killed - when a window cannot
 * be identified, it is reported, not guessed at.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp } from './apps/launch.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WINDIR = process.env.SystemRoot ?? 'C:\\Windows'
const POWERSHELL = `${WINDIR}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const WINDOWS_SCRIPT = join(ROOT, 'scripts', 'workspace-windows.ps1')
const OPEN_UI_SCRIPT = join(ROOT, 'scripts', 'open-ui.ps1')

export const WORKSPACE = Object.freeze({
  claudeDesktop: Object.freeze({ appName: 'Claude' }),
  claudeCode: Object.freeze({
    cwd: 'C:\\Users\\prana\\dev\\src\\Impromptu\\Website',
    command: 'claude',
    title: 'Impromptu Claude Code',
    // mintty's window class. Unlike the title, a program running inside the
    // terminal cannot change it, so it is what identifies our session later.
    windowClass: 'JarvisImpromptuClaudeCode',
  }),
})

/** Which display each window goes to: 1-based, left to right, then top to bottom. */
export const MONITOR_MAP = Object.freeze({ jarvis: 1, claudeDesktop: 2, claudeCode: 3 })

// --- monitors ----------------------------------------------------------------

/** The same ordering open-ui.ps1 uses, so "monitor 1" means one thing everywhere. */
export function orderMonitors(monitors) {
  return [...(monitors ?? [])].sort((a, b) => a.x - b.x || a.y - b.y)
}

/**
 * Where monitor `index` is. A display that does not exist falls back to the
 * primary one, and says so.
 */
export function destination(monitors, index) {
  const ordered = orderMonitors(monitors)
  if (!ordered.length) return { monitor: null, fallback: true, rect: null }
  if (ordered[index - 1]) return { monitor: index, fallback: false, rect: ordered[index - 1].work }
  const primary = ordered.find((m) => m.primary) ?? ordered[0]
  return { monitor: ordered.indexOf(primary) + 1, fallback: true, rect: primary.work }
}

// --- windows -----------------------------------------------------------------

const BROWSERS = /^(?:chrome|msedge)$/i

/** How each component's window is recognised in a snapshot. */
export const MATCHERS = {
  jarvis: (w) => BROWSERS.test(w.process) && w.title.startsWith('J.A.R.V.I.S.'),
  // Electron's main window. The Claude Code CLI is claude.exe too, but it never
  // owns a Chrome_WidgetWin_1 window.
  claudeDesktop: (w) => /^claude$/i.test(w.process) && w.className === 'Chrome_WidgetWin_1',
  claudeCode: (w) => w.className === WORKSPACE.claudeCode.windowClass,
}

// --- Git Bash ----------------------------------------------------------------

/** Git for Windows' own terminal and shell, from the usual install locations. */
export function findGitBash(env = process.env, exists = existsSync) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean)
    .map((base) => win32.join(base, 'Git'))
  for (const root of roots) {
    const mintty = win32.join(root, 'usr', 'bin', 'mintty.exe')
    const bash = win32.join(root, 'usr', 'bin', 'bash.exe')
    if (exists(mintty) && exists(bash)) return { root, mintty, bash }
  }
  return null
}

/**
 * The Claude Code terminal: [program, argv, env]. The folder travels in an
 * environment variable rather than being spliced into the script, and the
 * trailing `exec bash` keeps the window an interactive shell when Claude exits.
 */
export function claudeCodeCommand(gitBash, baseEnv = process.env) {
  const { cwd, command, title, windowClass } = WORKSPACE.claudeCode
  const script = `cd "$JARVIS_WORKSPACE_CWD" && ${command}; exec bash --login -i`
  return [
    gitBash.mintty,
    ['-i', '/mingw64/share/git/git-for-windows.ico', '--class', windowClass, '--title', title, '-w', 'max', '--', '/usr/bin/bash', '--login', '-c', script],
    {
      ...baseEnv,
      MSYSTEM: 'MINGW64',
      // Git Bash's profile otherwise changes to $HOME.
      CHERE_INVOKING: '1',
      JARVIS_WORKSPACE_CWD: cwd,
      // Keep the fixed title; Claude Code would otherwise retitle the window.
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    },
  ]
}

function spawnDetached(file, args, options = {}, spawnFn = spawn) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(file, args, { detached: true, stdio: 'ignore', shell: false, ...options })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }
    child.once('error', (err) => resolve({ ok: false, error: err.message }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

// --- the real desktop ----------------------------------------------------------

function runWindowsScript(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SCRIPT, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return reject(err)
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error('unreadable window helper output'))
        }
      },
    )
  })
}

/** Win32 via scripts/workspace-windows.ps1: a snapshot, or one placement. */
export const windowsDesktop = {
  async snapshot() {
    const s = await runWindowsScript(['-Op', 'Snapshot'])
    return { monitors: [].concat(s.monitors ?? []), windows: [].concat(s.windows ?? []) }
  },
  async place(hwnd, rect) {
    const nums = [hwnd, rect?.x, rect?.y, rect?.width, rect?.height]
    if (!nums.every(Number.isSafeInteger)) return { ok: false, error: 'invalid placement' }
    return runWindowsScript(['-Op', 'Place', '-Hwnd', String(hwnd), '-X', String(rect.x), '-Y', String(rect.y), '-Width', String(rect.width), '-Height', String(rect.height)])
  },
}

/**
 * How each component is started when no window for it exists.
 * @param {object} deps
 * @param {{ resolve: (name: string) => Promise<any> }} deps.catalogue
 * @param {() => boolean} deps.interfaceConnected  an interface is talking to the bridge
 * @param {object} [deps.env]   environment handed to the terminal
 */
export function defaultLaunchers({ catalogue, interfaceConnected = () => false, env = process.env, spawnFn = spawn }) {
  return {
    async jarvis() {
      // A connected interface whose window was not recognised is still an
      // interface: opening another would be the duplicate we promise not to make.
      if (interfaceConnected()) return { ok: false, error: 'the interface is running but its window was not identified' }
      return spawnDetached(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OPEN_UI_SCRIPT], { windowsHide: true }, spawnFn)
    },
    async claudeDesktop() {
      const r = await catalogue.resolve(WORKSPACE.claudeDesktop.appName)
      if (r.status !== 'found') return { ok: false, error: `the Claude app was not found (${r.status})` }
      return launchApp(r.app, { spawnFn })
    },
    async claudeCode() {
      const git = findGitBash()
      if (!git) return { ok: false, error: 'Git Bash is not installed' }
      if (!existsSync(WORKSPACE.claudeCode.cwd)) return { ok: false, error: 'the Impromptu folder is missing' }
      const [file, args, childEnv] = claudeCodeCommand(git, env)
      return spawnDetached(file, args, { cwd: WORKSPACE.claudeCode.cwd, env: childEnv, windowsHide: false }, spawnFn)
    },
  }
}

// --- orchestration -------------------------------------------------------------

const COMPONENTS = ['jarvis', 'claudeDesktop', 'claudeCode']
const LABELS = { jarvis: 'JARVIS', claudeDesktop: 'Claude', claudeCode: 'Claude Code' }

/**
 * @param {object} deps
 * @param {{ snapshot: () => Promise<{monitors: any[], windows: any[]}>, place: (hwnd: number, rect: object) => Promise<{ok: boolean, error?: string}> }} deps.desktop
 * @param {Record<string, () => Promise<{ok: boolean, error?: string}>>} deps.launchers
 * @param {boolean} [deps.dryRun]   work out what would happen; start and move nothing
 */
export function createWorkspace({
  desktop = windowsDesktop,
  launchers,
  dryRun = false,
  waitMs = 25000,
  pollMs = 1000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const diag = {
    monitors: { count: 0, primary: null, error: '' },
    targets: { ...MONITOR_MAP },
    components: {},
    launches: 0,
    suppressed: 0,
    lastTrigger: '',
    lastAt: '',
    lastResult: '',
  }
  let inFlight = null

  const snapshot = () => desktop.snapshot().catch((err) => ({ monitors: [], windows: [], error: String(err?.message ?? err) }))
  const pick = (windows, id) => {
    const hits = (windows ?? []).filter(MATCHERS[id])
    return hits.find((w) => w.title === 'Claude') ?? hits[0] ?? null
  }

  async function run(trigger) {
    diag.launches++
    diag.lastTrigger = trigger
    diag.lastAt = new Date(now()).toISOString()

    let snap = await snapshot()
    const monitors = orderMonitors(snap.monitors)
    const primary = monitors.findIndex((m) => m.primary)
    diag.monitors = { count: monitors.length, primary: primary >= 0 ? primary + 1 : null, error: snap.error ?? '' }

    const results = {}
    for (const id of COMPONENTS) {
      const dest = destination(monitors, MONITOR_MAP[id])
      const found = pick(snap.windows, id)
      const r = (results[id] = { action: found ? 'reused' : '', hwnd: found?.hwnd ?? null, monitor: dest.monitor, fallback: dest.fallback, rect: dest.rect, placement: '', error: '' })
      if (found) continue
      if (dryRun) {
        r.action = 'dry run'
        continue
      }
      // Each launch stands alone: one missing program must not cost the others.
      const l = await launchers[id]().catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      r.action = l.ok ? 'launched' : 'failed'
      r.error = l.ok ? '' : l.error ?? 'launch failed'
    }

    // One bounded wait for every window just started, sharing each snapshot.
    const waiting = () => COMPONENTS.filter((id) => results[id].action === 'launched' && !results[id].hwnd)
    const deadline = now() + waitMs
    while (waiting().length && now() < deadline) {
      await sleep(pollMs)
      snap = await snapshot()
      for (const id of waiting()) results[id].hwnd = pick(snap.windows, id)?.hwnd ?? null
    }

    for (const id of COMPONENTS) {
      const r = results[id]
      if (!r.hwnd) r.placement = r.action === 'launched' ? 'window not found in time' : 'skipped'
      else if (dryRun) r.placement = 'dry run'
      else if (!r.rect) r.placement = 'no monitor information'
      else {
        const p = await desktop.place(r.hwnd, r.rect).catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
        r.placement = p.ok ? 'placed' : `failed: ${p.error ?? 'unknown'}`
      }
    }

    diag.components = Object.fromEntries(
      COMPONENTS.map((id) => {
        const { action, monitor, fallback, placement, error } = results[id]
        return [id, { target: MONITOR_MAP[id], monitor, fallback, action, placement, error }]
      }),
    )
    const trouble = COMPONENTS.filter((id) => results[id].action === 'failed' || !['placed', 'dry run'].includes(results[id].placement))
    diag.lastResult = trouble.length ? `issues: ${trouble.join(', ')}` : 'ok'
    console.log(`[jarvis] workspace (${trigger}) -> ${diag.lastResult}`)
    return {
      ok: !trouble.length,
      say: trouble.length
        ? `The workspace is up, but I had trouble with ${trouble.map((id) => LABELS[id]).join(' and ')}.`
        : 'Your development workspace is ready.',
      data: diag.components,
    }
  }

  return {
    /** The only entry point. Deliberately takes nothing that could change what runs. */
    start({ trigger = 'unknown' } = {}) {
      if (inFlight) {
        diag.suppressed++
        return Promise.resolve({ ok: false, suppressed: true, say: 'The workspace is already starting.' })
      }
      inFlight = run(String(trigger).slice(0, 20)).finally(() => {
        inFlight = null
      })
      return inFlight
    },
    diagnostics: () => diag,
  }
}
