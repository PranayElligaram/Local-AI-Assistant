/**
 * Two phases, never collapsed:
 *
 *   logon  install-startup.ps1 -> jarvis.ps1 -Source logon -> start.mjs + open-ui.ps1
 *          JARVIS's runtime and its own window on monitor 1, dormant, clap armed.
 *   clap   POST /workspace (or "start workspace") -> bridge/workspace.mjs
 *          Claude desktop, Claude Code in Impromptu, a normal Chrome.
 *
 * The logon path is PowerShell that starts real processes, so it is checked
 * here by what it says it runs; the scripts' syntax is checked by
 * powershell.test.mjs and the start/stop/restart cycle by launcher.test.mjs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTools } from '../bridge/tools.mjs'
import { MONITOR_MAP, WORKSPACE } from '../bridge/workspace.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
/** Code only: comments may mention anything. */
const code = (p) =>
  read(p)
    .replace(/<#[\s\S]*?#>/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(#|\/\/).*$/, ''))
    .join('\n')

const LOGON_PATH = ['scripts/install-startup.ps1', 'scripts/jarvis.ps1', 'scripts/open-ui.ps1', 'scripts/start.mjs']

test('the logon task runs the JARVIS launcher, marked as a logon start', () => {
  const install = code('scripts/install-startup.ps1')
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn -User \$currentUser/)
  assert.match(install, /-MultipleInstances IgnoreNew/)
  assert.match(install, /\$launcher = Join-Path \$PSScriptRoot 'jarvis\.ps1'/)
  assert.match(install, /'-Source', 'logon'/)
  assert.match(code('scripts/jarvis.ps1'), /\$env:JARVIS_START_SOURCE = \$Source/)
})

test('logon starts JARVIS only: no Claude, no Git Bash, no Claude Code, no normal Chrome', () => {
  for (const file of LOGON_PATH) {
    const c = code(file)
    for (const banned of [/claude/i, /mintty|git-bash|bash\.exe/i, /impromptu/i, /\/workspace\b/]) {
      assert.doesNotMatch(c, banned, `${file} must not reference ${banned}`)
    }
  }
  // The only browser the logon path starts is JARVIS's own --app window.
  const openUi = code('scripts/open-ui.ps1')
  const launches = openUi.match(/Start-Process[^\n]*/g) ?? []
  assert.deepEqual(launches, ['Start-Process -FilePath $browser -ArgumentList @("--app=$Url") | Out-Null'])
})

test('the dedicated window uses the normal profile: no temporary profile, no incognito', () => {
  const openUi = code('scripts/open-ui.ps1')
  assert.doesNotMatch(openUi, /--user-data-dir|--profile-directory|--incognito|--guest/)
})

test('a repeated logon start reuses the JARVIS window before launching one', () => {
  const openUi = code('scripts/open-ui.ps1')
  const find = openUi.indexOf('$window = Find-JarvisWindow $snap')
  const launch = openUi.indexOf('Start-Process -FilePath $browser')
  assert.ok(find > 0 && launch > find, 'looks for the dedicated window first')
  assert.match(openUi, /if \(\$window\) \{\s*Write-Host 'JARVIS interface already open; reusing its window\.'\s*\} else \{/)
  // Recognised by the page title alone, never by being chrome.exe.
  assert.match(openUi, /\$_\.title -ceq 'J\.A\.R\.V\.I\.S\.'/)
  // A second launcher is refused by start.mjs's PID file, and the task itself ignores overlap.
  assert.match(code('scripts/start.mjs'), /claimPidFile\(\)/)
})

test('JARVIS is placed on monitor 1, by the same monitor ordering as the workspace', () => {
  assert.equal(MONITOR_MAP.jarvis, 1)
  const openUi = code('scripts/open-ui.ps1')
  assert.match(openUi, /\$monitors = @\(\$snap\.monitors \| Sort-Object x, y\)/)
  assert.match(openUi, /& \$helper -Op Place -Hwnd \$window\.hwnd/)
})

test('the clap is the one trigger for the workspace, and it is the existing orchestrator', () => {
  const app = code('src/App.tsx')
  assert.equal(app.match(/\/workspace`/g)?.length, 1)
  assert.match(app, /listenForClap\(\(\) => \{[\s\S]*?void powerOn\(\)[\s\S]*?\/workspace`, \{ method: 'POST' \}/)
  const server = code('bridge/server.mjs')
  assert.equal(server.match(/workspace\.start\(/g)?.length, 1)
  assert.match(server, /req\.url === '\/workspace'\) \{[\s\S]{0,80}workspace\.start\(\{ trigger: 'clap' \}\)/)
})

test('workspace targets are unchanged by the lifecycle work', () => {
  assert.deepEqual({ ...MONITOR_MAP }, { jarvis: 1, claudeDesktop: 2, claudeCode: 3 })
  assert.equal(WORKSPACE.claudeDesktop.appName, 'Claude')
  assert.equal(WORKSPACE.claudeCode.cwd, 'C:\\Users\\prana\\dev\\src\\Impromptu')
  assert.equal(WORKSPACE.claudeCode.command, 'claude')
})

test('the model has no way to start, stop or configure the startup or the workspace', () => {
  const tools = createTools({ catalogue: {} })
  const offered = tools.modelSchemas().map((s) => s.function.name)
  for (const name of ['start_workspace', 'restart_jarvis', 'stop_jarvis']) assert.ok(!offered.includes(name), name)
  assert.ok(!offered.some((n) => /startup|workspace|monitor|shell/.test(n)))
})

test('uninstall still removes exactly the one named task', () => {
  const un = code('scripts/uninstall-startup.ps1')
  assert.match(un, /\[string\] \$TaskName = 'JarvisAssistant'/)
  assert.match(un, /Unregister-ScheduledTask -TaskName \$TaskName -Confirm:\$false/)
  assert.match(code('scripts/install-startup.ps1'), /\[string\] \$TaskName = 'JarvisAssistant'/)
})

test('the clap ignores the capture start-up transient, with sensitivity unchanged', () => {
  const clap = code('src/lib/clap.ts')
  assert.match(clap, /const SETTLE_MS = 2000/)
  assert.match(clap, /if \(now - armedAt < SETTLE_MS\) return\s+if \(candidate\)/)
  for (const t of ['PEAK_OVER_FLOOR = 7', 'MIN_PEAK = 0.055', 'QUIET_BEFORE = 0.16', 'DECAY_TO = 0.35', 'DECAY_MS = 130', 'GIVE_UP_MS = 260', 'COOLDOWN_MS = 1200']) {
    assert.ok(clap.includes(`const ${t}`), t)
  }
})
