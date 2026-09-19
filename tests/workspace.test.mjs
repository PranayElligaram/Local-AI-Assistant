/**
 * The clap-started development workspace: JARVIS on monitor 1, the Claude
 * desktop app on 2, Git Bash + Claude Code in Impromptu on 3. Fixed targets,
 * reuse over relaunch, one start at a time, and no failure takes the others
 * down. Nothing here starts a real program or moves a real window.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { route } from '../bridge/router.mjs'
import { createTools } from '../bridge/tools.mjs'
import {
  MATCHERS,
  MONITOR_MAP,
  WORKSPACE,
  claudeCodeCommand,
  createWorkspace,
  defaultLaunchers,
  destination,
  findChrome,
  findGitBash,
} from '../bridge/workspace.mjs'

const IMPROMPTU = 'C:\\Users\\prana\\dev\\src\\Impromptu'
const WEBSITE_REPO = 'C:\\Users\\prana\\dev\\src\\Impromptu\\Website'
const JARVIS_ROOT = resolve(import.meta.dirname, '..')

const mon = (x, y, width, height, primary = false) => ({ x, y, width, height, primary, work: { x, y, width, height: height - 48 } })
// This machine: a scaled laptop panel to the LEFT of the primary, at negative X.
const LAPTOP = mon(-2880, 0, 2880, 1800)
const PRIMARY = mon(0, 0, 1920, 1080, true)
const RIGHT = mon(1920, 0, 1920, 1080)

const WINDOWS = {
  // The dedicated --app window: the page title and nothing else.
  jarvis: { hwnd: 11, process: 'chrome', className: 'Chrome_WidgetWin_1', title: 'J.A.R.V.I.S.' },
  claudeDesktop: { hwnd: 22, process: 'claude', className: 'Chrome_WidgetWin_1', title: 'Claude' },
  claudeCode: { hwnd: 33, process: 'mintty', className: WORKSPACE.claudeCode.windowClass, title: 'Impromptu Claude Code' },
  chrome: { hwnd: 44, process: 'chrome', className: 'Chrome_WidgetWin_1', title: 'New Tab - Google Chrome' },
}
// The same page in an ordinary tab: a browsing window, not JARVIS's own.
const JARVIS_IN_A_TAB = { hwnd: 55, process: 'chrome', className: 'Chrome_WidgetWin_1', title: 'J.A.R.V.I.S. - Google Chrome' }

function fakeDesktop({ monitors = [PRIMARY, RIGHT, LAPTOP], windows = [], placeFails = [] } = {}) {
  const d = {
    monitors,
    windows: [...windows],
    placed: [],
    async snapshot() {
      return { monitors: d.monitors, windows: d.windows }
    },
    async place(hwnd, rect) {
      d.placed.push({ hwnd, rect })
      return placeFails.includes(hwnd) ? { ok: false, error: 'nope' } : { ok: true }
    },
  }
  return d
}

/** Launchers that "open" a window, recording what they were called with. */
function fakeLaunchers(desktop, { fail = {} } = {}) {
  const calls = { jarvis: [], claudeDesktop: [], claudeCode: [], chrome: [] }
  const make = (id) => async (...args) => {
    calls[id].push(args)
    if (fail[id] === 'throw') throw new Error(`${id} exploded`)
    if (fail[id]) return { ok: false, error: fail[id] }
    desktop.windows.push(WINDOWS[id])
    return { ok: true }
  }
  return { calls, launchers: { jarvis: make('jarvis'), claudeDesktop: make('claudeDesktop'), claudeCode: make('claudeCode'), chrome: make('chrome') } }
}

const quick = { waitMs: 50, pollMs: 1, sleep: async () => {} }

function fakeSpawn() {
  const spawned = []
  const spawnFn = (file, args, opts) => {
    spawned.push({ file, args, opts })
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('spawn'))
    return child
  }
  return { spawned, spawnFn }
}

// --- monitors ------------------------------------------------------------------

test('the mapping is JARVIS 1, Claude desktop 2, Claude Code 3', () => {
  assert.deepEqual({ ...MONITOR_MAP }, { jarvis: 1, claudeDesktop: 2, claudeCode: 3 })
})

test('three monitors map left to right, including one at negative X', () => {
  const monitors = [PRIMARY, RIGHT, LAPTOP]
  assert.deepEqual(destination(monitors, 1), { monitor: 1, fallback: false, rect: LAPTOP.work })
  assert.deepEqual(destination(monitors, 2), { monitor: 2, fallback: false, rect: PRIMARY.work })
  assert.deepEqual(destination(monitors, 3), { monitor: 3, fallback: false, rect: RIGHT.work })
})

test('stacked monitors order top to bottom at the same X', () => {
  const top = mon(0, -1080, 1920, 1080)
  assert.equal(destination([PRIMARY, top], 1).rect, top.work)
})

test('with fewer than three monitors the missing ones fall back to the primary', () => {
  assert.deepEqual(destination([PRIMARY], 2), { monitor: 1, fallback: true, rect: PRIMARY.work })
  assert.deepEqual(destination([PRIMARY], 3), { monitor: 1, fallback: true, rect: PRIMARY.work })
  assert.deepEqual(destination([LAPTOP, PRIMARY], 3), { monitor: 2, fallback: true, rect: PRIMARY.work })
  assert.deepEqual(destination([], 1), { monitor: null, fallback: true, rect: null })
})

// --- fixed configuration ---------------------------------------------------------

test('the Claude Code terminal is Git Bash in Impromptu running exactly "claude"', () => {
  assert.equal(WORKSPACE.claudeCode.cwd, IMPROMPTU)
  assert.notEqual(WORKSPACE.claudeCode.cwd, WEBSITE_REPO)
  assert.equal(WORKSPACE.claudeCode.command, 'claude')
  assert.notEqual(WORKSPACE.claudeCode.cwd.toLowerCase(), JARVIS_ROOT.toLowerCase())
  assert.ok(!WORKSPACE.claudeCode.cwd.toLowerCase().includes('jarvis'))

  const git = { mintty: 'C:\\Git\\usr\\bin\\mintty.exe', bash: 'C:\\Git\\usr\\bin\\bash.exe' }
  const [file, args, env] = claudeCodeCommand(git, { PATH: 'x' })
  assert.equal(file, git.mintty)
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '/usr/bin/bash', '--login', '-c', 'cd "$JARVIS_WORKSPACE_CWD" && claude; exec bash --login -i'])
  assert.equal(args[args.indexOf('--class') + 1], 'JarvisImpromptuClaudeCode')
  assert.equal(args[args.indexOf('--title') + 1], 'Impromptu Claude Code')
  assert.equal(env.JARVIS_WORKSPACE_CWD, IMPROMPTU)
  assert.equal(env.CHERE_INVOKING, '1')
  assert.ok(!args.some((a) => /powershell|cmd\.exe/i.test(a)))
})

test('the Claude desktop app is monitor 2, resolved by name; no browser and no claude.ai', async () => {
  assert.equal(MONITOR_MAP.claudeDesktop, 2)
  assert.equal(WORKSPACE.claudeDesktop.appName, 'Claude')
  assert.ok(!JSON.stringify(WORKSPACE).match(/https?:|claude\.ai|chrome/i))

  const asked = []
  const catalogue = { async resolve(n) { asked.push(n); return { status: 'found', app: { type: 'startapp', target: 'Claude_abc!Claude' } } } }
  const { spawned, spawnFn } = fakeSpawn()
  const r = await defaultLaunchers({ catalogue, spawnFn }).claudeDesktop()
  assert.equal(r.ok, true)
  assert.deepEqual(asked, ['Claude'])
  assert.equal(spawned.length, 1)
  assert.match(spawned[0].file, /explorer\.exe$/i)
  assert.deepEqual(spawned[0].args, ['shell:AppsFolder\\Claude_abc!Claude'])
})

test('a missing Claude app is a reported failure, not a guess', async () => {
  const { spawned, spawnFn } = fakeSpawn()
  const catalogue = { async resolve() { return { status: 'ambiguous', candidates: ['Claude', 'Claude Code'] } } }
  const r = await defaultLaunchers({ catalogue, spawnFn }).claudeDesktop()
  assert.equal(r.ok, false)
  assert.match(r.error, /ambiguous/)
  assert.equal(spawned.length, 0)
})

test('a connected interface is never opened a second time', async () => {
  const { spawned, spawnFn } = fakeSpawn()
  const r = await defaultLaunchers({ catalogue: {}, interfaceConnected: () => true, spawnFn }).jarvis()
  assert.equal(r.ok, false)
  assert.equal(spawned.length, 0)
})

test('the configuration cannot be changed at run time', () => {
  assert.throws(() => { WORKSPACE.claudeCode.cwd = 'C:\\evil' }, TypeError)
  assert.throws(() => { WORKSPACE.claudeCode.command = 'rm -rf /' }, TypeError)
  assert.throws(() => { MONITOR_MAP.claudeCode = 1 }, TypeError)
})

test('Git Bash is found in Git for Windows install folders only', () => {
  const git = findGitBash({ ProgramFiles: 'C:\\Program Files' }, (p) => p.startsWith('C:\\Program Files\\Git\\usr\\bin\\'))
  assert.deepEqual(git, { root: 'C:\\Program Files\\Git', mintty: 'C:\\Program Files\\Git\\usr\\bin\\mintty.exe', bash: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' })
  assert.equal(findGitBash({ ProgramFiles: 'C:\\Program Files' }, () => false), null)
})

test('windows are recognised precisely', () => {
  assert.ok(MATCHERS.jarvis(WINDOWS.jarvis))
  assert.ok(MATCHERS.claudeDesktop(WINDOWS.claudeDesktop))
  assert.ok(MATCHERS.claudeCode(WINDOWS.claudeCode))
  // Someone else's Git Bash running Claude Code, and a console-hosted CLI.
  assert.ok(!MATCHERS.claudeCode({ process: 'mintty', className: 'mintty', title: 'Impromptu Claude Code' }))
  assert.ok(!MATCHERS.claudeDesktop({ process: 'claude', className: 'ConsoleWindowClass', title: 'claude' }))
  assert.ok(!MATCHERS.jarvis({ process: 'chrome', className: 'Chrome_WidgetWin_1', title: 'Gmail - Google Chrome' }))
})

// --- orchestration --------------------------------------------------------------

test('a cold start launches all three and places each on its own monitor', async () => {
  const desktop = fakeDesktop()
  const { calls, launchers } = fakeLaunchers(desktop)
  const ws = createWorkspace({ desktop, launchers, ...quick })
  const r = await ws.start({ trigger: 'clap' })
  assert.equal(r.ok, true)
  for (const id of ['jarvis', 'claudeDesktop', 'claudeCode', 'chrome']) assert.equal(calls[id].length, 1)
  assert.deepEqual(desktop.placed, [
    { hwnd: 11, rect: LAPTOP.work },
    { hwnd: 22, rect: PRIMARY.work },
    { hwnd: 33, rect: RIGHT.work },
  ])
  const d = ws.diagnostics()
  assert.deepEqual(d.monitors, { count: 3, primary: 2, error: '' })
  assert.equal(d.components.claudeCode.action, 'launched')
  assert.equal(d.components.claudeCode.placement, 'placed')
  assert.equal(d.launches, 1)
  assert.equal(d.lastResult, 'ok')
})

test('existing windows are reused and repositioned, never relaunched', async () => {
  const desktop = fakeDesktop({ windows: Object.values(WINDOWS) })
  const { calls, launchers } = fakeLaunchers(desktop)
  const ws = createWorkspace({ desktop, launchers, ...quick })
  await ws.start()
  await ws.start()
  assert.deepEqual([calls.jarvis.length, calls.claudeDesktop.length, calls.claudeCode.length, calls.chrome.length], [0, 0, 0, 0])
  assert.equal(desktop.windows.length, 4)
  assert.equal(desktop.placed.length, 6)
  assert.equal(ws.diagnostics().components.claudeDesktop.action, 'reused')
})

test('an overlapping start is suppressed', async () => {
  const desktop = fakeDesktop()
  const { calls, launchers } = fakeLaunchers(desktop)
  const ws = createWorkspace({ desktop, launchers, ...quick })
  const [a, b] = await Promise.all([ws.start({ trigger: 'clap' }), ws.start({ trigger: 'clap' })])
  assert.equal(a.ok, true)
  assert.equal(b.suppressed, true)
  assert.equal(calls.claudeCode.length, 1)
  assert.equal(ws.diagnostics().suppressed, 1)
  assert.equal(ws.diagnostics().launches, 1)
})

test('one failed component does not stop the others', async () => {
  const desktop = fakeDesktop()
  const { calls, launchers } = fakeLaunchers(desktop, { fail: { claudeDesktop: 'throw', claudeCode: 'Git Bash is not installed' } })
  const ws = createWorkspace({ desktop, launchers, ...quick })
  const r = await ws.start()
  assert.equal(r.ok, false)
  assert.match(r.say, /Claude and Claude Code/)
  assert.equal(calls.jarvis.length, 1)
  assert.deepEqual(desktop.placed, [{ hwnd: 11, rect: LAPTOP.work }])
  const c = ws.diagnostics().components
  assert.equal(c.claudeDesktop.action, 'failed')
  assert.match(c.claudeDesktop.error, /exploded/)
  assert.equal(c.claudeCode.error, 'Git Bash is not installed')
  assert.equal(c.jarvis.placement, 'placed')
})

test('a failed placement leaves the window open and is recorded', async () => {
  const desktop = fakeDesktop({ windows: Object.values(WINDOWS), placeFails: [22] })
  const ws = createWorkspace({ desktop, launchers: fakeLaunchers(desktop).launchers, ...quick })
  const r = await ws.start()
  assert.equal(r.ok, false)
  assert.equal(ws.diagnostics().components.claudeDesktop.placement, 'failed: nope')
  assert.equal(ws.diagnostics().components.claudeCode.placement, 'placed')
})

test('a window that never appears is a bounded wait, not a hang', async () => {
  const desktop = fakeDesktop()
  const launchers = { jarvis: async () => ({ ok: true }), claudeDesktop: async () => ({ ok: true }), claudeCode: async () => ({ ok: true }), chrome: async () => ({ ok: true }) }
  let t = 0
  const ws = createWorkspace({ desktop, launchers, waitMs: 5000, pollMs: 1000, now: () => t, sleep: async (ms) => { t += ms } })
  await ws.start()
  assert.equal(ws.diagnostics().components.claudeCode.placement, 'window not found in time')
  assert.equal(t, 5000)
})

test('one monitor: everything lands on the primary, and the fallback is recorded', async () => {
  const desktop = fakeDesktop({ monitors: [PRIMARY], windows: Object.values(WINDOWS) })
  const ws = createWorkspace({ desktop, launchers: fakeLaunchers(desktop).launchers, ...quick })
  await ws.start()
  assert.ok(desktop.placed.every((p) => p.rect === PRIMARY.work))
  assert.equal(ws.diagnostics().components.claudeCode.fallback, true)
  assert.equal(ws.diagnostics().components.jarvis.fallback, false)
})

test('start() ignores anything but a trigger: launchers receive no arguments', async () => {
  const desktop = fakeDesktop()
  const { calls, launchers } = fakeLaunchers(desktop)
  const ws = createWorkspace({ desktop, launchers, ...quick })
  await ws.start({ trigger: 'clap', cwd: 'C:\\evil', command: 'calc', monitor: 9, url: 'https://claude.ai' })
  for (const id of Object.keys(calls)) assert.deepEqual(calls[id], [[]])
  assert.deepEqual(desktop.placed.map((p) => p.rect), [LAPTOP.work, PRIMARY.work, RIGHT.work])
})

test('dry run starts and moves nothing', async () => {
  const desktop = fakeDesktop()
  const { calls, launchers } = fakeLaunchers(desktop)
  const ws = createWorkspace({ desktop, launchers, dryRun: true, ...quick })
  await ws.start()
  assert.equal(calls.claudeCode.length, 0)
  assert.equal(desktop.placed.length, 0)
})

// --- the voice command and the model -------------------------------------------------

test('"start workspace" routes to the same orchestrator, bypassing the model', async () => {
  assert.deepEqual(route('Start workspace'), { tool: 'start_workspace', args: {} })
  assert.deepEqual(route('Start my workspace'), { tool: 'start_workspace', args: {} })
  const starts = []
  const tools = createTools({ catalogue: {}, workspace: { start: async (o) => (starts.push(o), { ok: true, say: 'ready' }) } })
  const r = await tools.execute('start_workspace', {}, { origin: 'router' })
  assert.equal(r.ok, true)
  assert.deepEqual(starts, [{ trigger: 'voice' }])
})

test('the model can neither call nor configure the workspace', async () => {
  const starts = []
  const tools = createTools({ catalogue: {}, workspace: { start: async (o) => (starts.push(o), { ok: true }) } })
  assert.ok(!tools.modelSchemas().some((s) => s.function.name === 'start_workspace'))
  const byModel = await tools.execute('start_workspace', {}, { origin: 'model' })
  assert.equal(byModel.rejected, true)
  const withArgs = await tools.execute('start_workspace', { cwd: 'C:\\evil', command: 'calc' }, { origin: 'router' })
  assert.equal(withArgs.rejected, true)
  assert.deepEqual(starts, [])
})

// --- the dedicated JARVIS window vs normal Chrome ------------------------------

test('the dedicated JARVIS window and a normal Chrome window are told apart', () => {
  assert.ok(MATCHERS.jarvis(WINDOWS.jarvis))
  assert.ok(!MATCHERS.chrome(WINDOWS.jarvis))
  assert.ok(MATCHERS.chrome(WINDOWS.chrome))
  assert.ok(!MATCHERS.jarvis(WINDOWS.chrome))
  // JARVIS in an ordinary tab is somebody's browsing window.
  assert.ok(!MATCHERS.jarvis(JARVIS_IN_A_TAB))
  assert.ok(MATCHERS.chrome(JARVIS_IN_A_TAB))
  // Claude desktop (also Chrome_WidgetWin_1) and other --app windows are neither.
  assert.ok(!MATCHERS.chrome(WINDOWS.claudeDesktop))
  assert.ok(!MATCHERS.chrome({ process: 'chrome', className: 'Chrome_WidgetWin_1', title: 'YouTube' }))
})

test('normal Chrome is never picked as JARVIS: with only a tab, JARVIS is not reused', async () => {
  const desktop = fakeDesktop({ windows: [JARVIS_IN_A_TAB, WINDOWS.claudeDesktop, WINDOWS.claudeCode] })
  const { calls, launchers } = fakeLaunchers(desktop)
  const ws = createWorkspace({ desktop, launchers, ...quick })
  await ws.start()
  assert.equal(calls.jarvis.length, 1)
  assert.equal(calls.chrome.length, 0, 'the tab window already is a normal Chrome window')
  assert.ok(!desktop.placed.some((p) => p.hwnd === JARVIS_IN_A_TAB.hwnd))
  assert.deepEqual(desktop.placed[0], { hwnd: 11, rect: LAPTOP.work })
})

test('normal Chrome is opened only when absent, and never moved', async () => {
  const desktop = fakeDesktop({ windows: [WINDOWS.jarvis, WINDOWS.claudeDesktop, WINDOWS.claudeCode] })
  const { calls, launchers } = fakeLaunchers(desktop)
  const ws = createWorkspace({ desktop, launchers, ...quick })
  await ws.start()
  await ws.start()
  assert.equal(calls.chrome.length, 1)
  assert.deepEqual(ws.diagnostics().components.chrome, { target: null, monitor: null, fallback: false, action: 'reused', placement: 'not moved', error: '' })
  assert.ok(!desktop.placed.some((p) => p.hwnd === WINDOWS.chrome.hwnd))
})

test('normal Chrome launches with no arguments: no URL, no profile, no incognito', async () => {
  const { spawned, spawnFn } = fakeSpawn()
  const r = await defaultLaunchers({ catalogue: {}, spawnFn }).chrome()
  if (!findChrome()) return assert.equal(r.ok, false)
  assert.equal(r.ok, true)
  assert.match(spawned[0].file, /chrome\.exe$/i)
  assert.deepEqual(spawned[0].args, [])
})

test('Chrome is looked for in its install folders only', () => {
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  assert.equal(findChrome({ ProgramFiles: 'C:\\Program Files' }, (p) => p === exe), exe)
  assert.equal(findChrome({ ProgramFiles: 'C:\\Program Files' }, () => false), null)
})

test('browser inspection reports the dedicated window and normal Chrome, cached', async () => {
  let snaps = 0
  const desktop = fakeDesktop({ windows: [JARVIS_IN_A_TAB] })
  const counted = { ...desktop, snapshot: async () => (snaps++, desktop.snapshot()) }
  let t = 0
  const ws = createWorkspace({ desktop: counted, launchers: {}, now: () => t })
  assert.deepEqual(await ws.inspectBrowsers(), { jarvisDedicatedWindow: false, normalChromePresent: true, error: '' })
  desktop.windows.push(WINDOWS.jarvis)
  await ws.inspectBrowsers()
  assert.equal(snaps, 1)
  t = 60000
  assert.equal((await ws.inspectBrowsers()).jarvisDedicatedWindow, true)
})
