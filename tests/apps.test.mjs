/**
 * The installed-application catalogue and resolver: discovery sources,
 * matching priority, ambiguity, fuzzy caution, aliases and portable apps.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverApps, parseAppPaths, parseStartApps, scanStartMenu } from '../bridge/apps/discover.mjs'
import { AppCatalogue, buildCatalogue } from '../bridge/apps/catalog.mjs'
import { normalizeName, resolveApp } from '../bridge/apps/resolve.mjs'
import { addAlias, addPortable, readRegistry, removeEntry, validatePortableTarget } from '../bridge/apps/registry.mjs'
import { createTools } from '../bridge/tools.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-apps-'))

/** A fake Start Menu tree: .lnk files are just files as far as discovery is concerned. */
function startMenu(files) {
  const root = tmp()
  for (const f of files) {
    const full = join(root, f)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, '')
  }
  return root
}

const row = (name, source = 'start-apps', extra = {}) => ({ name, type: 'startapp', target: `${name}.id`, source, ...extra })

/** Roughly this machine's Start menu. */
const MACHINE = buildCatalogue([
  row('Spotify'),
  row('Visual Studio Code'),
  row('Visual Studio Installer'),
  row('Google Chrome'),
  row('Chrome Remote Desktop'),
  row('Word'),
  row('Excel'),
  row('PowerPoint'),
  row('Terminal'),
  row('Windows PowerShell'),
  row('Windows PowerShell (x86)'),
  row('Windows PowerShell ISE'),
  row('Git Bash'),
  row('Git CMD'),
  row('Git GUI'),
  row('Python 3.12 (64-bit)'),
  row('Python 3.13 (64-bit)'),
  row('Calculator'),
  row('Settings'),
  row('Discord'),
  row('Ollama'),
  row('Cursor'),
  row('Calendar'),
  { name: 'Calendar', type: 'startapp', target: 'other.calendar', source: 'start-apps' },
  { name: 'chrome', type: 'exe', target: 'C:\\x\\chrome.exe', source: 'app-paths' },
  { name: 'WINWORD', type: 'exe', target: 'C:\\x\\WINWORD.EXE', source: 'app-paths' },
  { name: 'Notepad', type: 'exe', target: 'C:\\Windows\\System32\\notepad.exe', source: 'builtin' },
])

const resolved = (q, aliases) => {
  const r = resolveApp(q, MACHINE, aliases)
  return r.status === 'found' ? r.app.name : r.status
}

test('discovery reads the current-user and all-users Start Menus, skipping non-apps', () => {
  const user = startMenu(['Spotify.lnk', 'Tools/Portable Thing.lnk', 'Uninstall Spotify.lnk', 'Readme.lnk', 'notes.txt'])
  const system = startMenu(['Google Chrome.lnk', 'Microsoft Office/Word.lnk', 'deep/a/b/c/d/e/f/Too Deep.lnk'])
  const u = scanStartMenu(user, 'startmenu-user')
  const s = scanStartMenu(system, 'startmenu-system')
  assert.deepEqual(u.map((e) => e.name).sort(), ['Portable Thing', 'Spotify'])
  assert.deepEqual(s.map((e) => e.name).sort(), ['Google Chrome', 'Word'])
  assert.ok(u.every((e) => e.type === 'shortcut' && e.source === 'startmenu-user'))
  assert.deepEqual(scanStartMenu(join(user, 'missing'), 'x'), [])
})

test('discovery parses registered App Paths', () => {
  const text = [
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '    Path    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application',
    '',
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE',
    '    (Default)    REG_SZ    "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE"',
    '',
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\notanexe',
    '    (Default)    REG_SZ    C:\\somewhere\\file.dll',
  ].join('\r\n')
  const rows = parseAppPaths(text, 'app-paths')
  assert.deepEqual(rows.map((r) => r.name), ['chrome', 'WINWORD'])
  assert.equal(rows[1].target, 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE')
  assert.ok(rows.every((r) => r.type === 'exe'))
})

test('discovery includes packaged (UWP) apps and drops documents and links', () => {
  const rows = parseStartApps(
    JSON.stringify([
      { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
      { Name: 'Dropbox Website', AppID: 'https://www.dropbox.com' },
      { Name: 'Python Docs', AppID: 'C:\\Python\\Doc\\index.html' },
      { Name: 'Git Release Notes', AppID: 'C:\\Git\\ReleaseNotes.html' },
      { Name: 'Evil', AppID: 'x" & calc' },
    ]),
  )
  assert.deepEqual(rows.map((r) => r.name), ['Calculator'])
  assert.equal(parseStartApps('not json').length, 0)
  assert.equal(parseStartApps(JSON.stringify({ Name: 'Solo', AppID: 'solo!App' })).length, 1)
})

test('discovery survives every source failing, and never scans the drive', async () => {
  const calls = []
  const exec = async (file, args) => (calls.push([file, ...args].join(' ')), null)
  const { entries, sources } = await discoverApps({ env: {}, platform: 'win32', exec })
  assert.ok(Array.isArray(entries))
  assert.ok('app-paths' in sources && 'start-apps' in sources)
  assert.ok(calls.every((c) => /^reg\.exe query|^powershell\.exe/.test(c)), calls.join('\n'))
  assert.ok(!calls.some((c) => /Get-ChildItem|dir \/s|\*\.exe/i.test(c)))
})

test('exact and case-insensitive names resolve', () => {
  assert.equal(resolved('Spotify'), 'Spotify')
  assert.equal(resolved('spotify'), 'Spotify')
  assert.equal(resolved('DISCORD'), 'Discord')
  assert.equal(resolved('Ollama'), 'Ollama')
  assert.equal(resolved('Cursor'), 'Cursor')
  assert.equal(normalizeName('Intel® Graphics Command Center'), 'intel graphics command center')
})

test('the well-known aliases resolve to the same app every time', () => {
  for (const q of ['VS Code', 'vscode', 'Code', 'Visual Studio Code']) assert.equal(resolved(q), 'Visual Studio Code', q)
  for (const q of ['Chrome', 'Google Chrome']) assert.equal(resolved(q), 'Google Chrome', q)
  for (const q of ['Word', 'Microsoft Word', 'winword']) assert.equal(resolved(q), 'Word', q)
  assert.equal(resolved('Windows Terminal'), 'Terminal')
  assert.equal(resolved('PowerShell'), 'Windows PowerShell')
  assert.equal(resolved('calc'), 'Calculator')
})

test('app-paths and built-ins fill gaps but never duplicate a known app', () => {
  assert.equal(MACHINE.filter((e) => e.key === 'chrome').length, 0)
  assert.equal(MACHINE.filter((e) => e.key === 'winword').length, 0)
  assert.equal(resolved('Notepad'), 'Notepad')
})

test('a strong token match launches; several plausible ones ask', () => {
  assert.equal(resolved('Bash'), 'Git Bash')
  const vs = resolveApp('Visual Studio', MACHINE)
  assert.equal(vs.status, 'ambiguous')
  assert.deepEqual(vs.candidates.sort(), ['Visual Studio Code', 'Visual Studio Installer'])
  assert.equal(resolveApp('Git', MACHINE).status, 'ambiguous')
  assert.equal(resolveApp('Python', MACHINE).status, 'ambiguous')
  assert.equal(resolveApp('Calendar', MACHINE).status, 'ambiguous')
})

test('build variants of one app are one app; different versions are not', () => {
  const r = resolveApp('Windows PowerShell', MACHINE)
  assert.equal(r.status, 'found')
  assert.equal(r.app.name, 'Windows PowerShell')
  assert.equal(resolveApp('python 64 bit', MACHINE).status, 'ambiguous')
})

test('a close fuzzy match launches only when unique; a weak one only suggests', () => {
  assert.equal(resolved('Visual Studio Codes'), 'Visual Studio Code')
  const weak = resolveApp('spotfy', MACHINE)
  assert.equal(weak.status, 'suggest')
  assert.deepEqual(weak.candidates, ['Spotify'])
  assert.equal(resolveApp('quantum flux capacitor', MACHINE).status, 'not_found')
  assert.equal(resolveApp('', MACHINE).status, 'not_found')
})

test('user aliases point at apps by name', () => {
  assert.equal(resolved('ide', { ide: 'Visual Studio Code' }), 'Visual Studio Code')
  assert.equal(resolved('music', { music: 'Spotify' }), 'Spotify')
  assert.equal(resolved('browser', { browser: 'chrome' }), 'Google Chrome')
})

test('portable apps are registered only with a real absolute executable', () => {
  const dir = tmp()
  const file = join(dir, 'jarvis.apps.json')
  const exe = join(dir, 'MyTool.exe')
  writeFileSync(exe, '')
  writeFileSync(join(dir, 'script.bat'), '')
  assert.equal(validatePortableTarget('MyTool.exe').ok, false)
  assert.equal(validatePortableTarget(join(dir, 'missing.exe')).ok, false)
  assert.equal(validatePortableTarget(join(dir, 'script.bat')).ok, false)
  assert.equal(validatePortableTarget(dir).ok, false)
  assert.equal(addPortable(file, 'my tool', join(dir, 'nope.exe')).ok, false)
  assert.equal(existsSync(file), false)
  const added = addPortable(file, 'My Tool', `"${exe}"`)
  assert.equal(added.ok, true)
  assert.equal(readRegistry(file).apps['my tool'].path, exe)
  assert.equal(addAlias(file, 'IDE', 'Visual Studio Code').ok, true)
  assert.deepEqual(readRegistry(file).aliases, { ide: 'Visual Studio Code' })
  assert.equal(removeEntry(file, 'ide').ok, true)
  assert.equal(removeEntry(file, 'ide').ok, false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).aliases, {})
})

test('the catalogue merges portable apps, caches discovery and refreshes on demand', async () => {
  const dir = tmp()
  const exe = join(dir, 'MyTool.exe')
  writeFileSync(exe, '')
  const registryFile = join(dir, 'jarvis.apps.json')
  addPortable(registryFile, 'mytool', exe)
  let scans = 0
  let installed = [row('Spotify')]
  const discover = async () => (scans++, { entries: installed, sources: { 'start-apps': installed.length } })
  const cat = new AppCatalogue({ cacheFile: join(dir, 'cache.json'), registryFile, discover, missRefreshAfterMs: 0 })

  const tool = await cat.resolve('mytool')
  assert.equal(tool.status, 'found')
  assert.equal(tool.app.source, 'user')
  assert.equal(tool.app.target, exe)
  assert.equal(scans, 1)
  assert.equal(cat.status().count, 2)

  // A second catalogue starts from the cache, without scanning.
  const again = new AppCatalogue({ cacheFile: join(dir, 'cache.json'), registryFile, discover })
  assert.equal((await again.resolve('Spotify')).status, 'found')
  assert.equal(scans, 1)

  // Something installed since: a miss triggers one refresh and finds it.
  installed = [row('Spotify'), row('Steam')]
  assert.equal((await cat.resolve('Steam')).status, 'found')
  assert.equal(scans, 2)
  assert.equal((await cat.refresh()).count, 3)
})

test('opening an app goes through the resolver without needing Ollama', async () => {
  const launched = []
  const cat = new AppCatalogue({ discover: async () => ({ entries: [row('Calculator')], sources: {} }) })
  const tools = createTools({ catalogue: cat, launcher: { launchApp: async (e) => (launched.push(e), { ok: true }), openUrl: async () => ({ ok: true }) } })
  const r = await tools.execute('open_application', { name: 'calc' }, { origin: 'router' })
  assert.equal(r.ok, true)
  assert.equal(launched[0].target, 'Calculator.id')
  const amb = await tools.execute('open_application', { name: 'nothing like it' }, { origin: 'router' })
  assert.equal(amb.ok, false)
  assert.equal(launched.length, 1)
})

// -- canonical deduplication ---------------------------------------------------

const DISCORD_ROOT = 'C:\\Users\\u\\AppData\\Local\\Discord'
const lnk = (name, file, link) => ({ name, type: 'shortcut', target: `C:\\SM\\${file}`, source: 'startmenu-user', link })
const discordDirect = lnk('Discord', 'Discord.lnk', { target: `${DISCORD_ROOT}\\app-1.0.9256\\Discord.exe`, args: '', workDir: `${DISCORD_ROOT}\\app-1.0.9256`, exists: true })
const discordUpdater = lnk('Discord', 'Discord Inc\\Discord.lnk', { target: `${DISCORD_ROOT}\\Update.exe`, args: '--processStart Discord.exe', workDir: `${DISCORD_ROOT}\\app-1.0.9256`, exists: true })

test('a direct shortcut and its Squirrel updater stub are one Discord, launched directly', () => {
  for (const order of [[discordUpdater, discordDirect], [discordDirect, discordUpdater]]) {
    const list = buildCatalogue(order)
    const hits = list.filter((e) => e.key === 'discord')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].target, 'C:\\SM\\Discord.lnk', 'the direct executable wins over Update.exe --processStart')
    const r = resolveApp('Discord', list)
    assert.equal(r.status, 'found')
    assert.equal(r.app.name, 'Discord')
  }
})

test('the updater stub is kept when the direct executable is gone', () => {
  const stale = { ...discordDirect, link: { ...discordDirect.link, exists: false } }
  const list = buildCatalogue([discordUpdater, stale])
  assert.equal(list.filter((e) => e.key === 'discord').length, 1)
})

test('identical equivalent shortcuts (Spotify in two folders) collapse to one app', () => {
  const exe = 'C:\\Users\\u\\AppData\\Roaming\\Spotify\\Spotify.exe'
  const list = buildCatalogue([
    lnk('Spotify', 'Spotify.lnk', { target: exe, args: '', workDir: '', exists: true }),
    lnk('Spotify', 'Music\\Spotify.lnk', { target: exe, args: '', workDir: '', exists: true }),
  ])
  assert.equal(list.filter((e) => e.key === 'spotify').length, 1)
  assert.equal(resolveApp('Spotify', list).status, 'found')
})

test('same-named apps from unrelated installs stay ambiguous', () => {
  const list = buildCatalogue([
    lnk('Studio', 'A\\Studio.lnk', { target: 'C:\\Program Files\\VendorA\\Studio.exe', args: '', workDir: '', exists: true }),
    lnk('Studio', 'B\\Studio.lnk', { target: 'D:\\Tools\\VendorB\\studio64.exe', args: '', workDir: '', exists: true }),
  ])
  assert.equal(list.filter((e) => e.key === 'studio').length, 2)
  assert.equal(resolveApp('Studio', list).status, 'ambiguous')
})

test('shortcut targets are read by index from a bounded list, never by searching', async () => {
  const { parseShortcuts, shortcutCommand } = await import('../bridge/apps/discover.mjs')
  const cmd = shortcutCommand(["C:\\SM\\O'Brien.lnk"])
  assert.ok(cmd.includes("'C:\\SM\\O''Brien.lnk'"), 'single quotes are escaped')
  assert.ok(!/Get-ChildItem|\*\.exe/i.test(cmd))
  const map = parseShortcuts(JSON.stringify([{ i: 0, t: 'C:\\x\\Update.exe', a: '--processStart X.exe', w: '' }, { i: 'bad', t: 'y' }]))
  assert.deepEqual([...map.keys()], [0])
  assert.equal(parseShortcuts('not json').size, 0)
})

test('"Open Discord" with the duplicated Start Menu opens one Discord through the router', async () => {
  const { createConversation, createMetrics } = await import('../bridge/assistant.mjs')
  const list = buildCatalogue([discordUpdater, discordDirect])
  const launched = []
  const catalogue = { resolve: async (name) => resolveApp(name, list) }
  const tools = createTools({ catalogue, launcher: { launchApp: async (e) => (launched.push(e), { ok: true }), openUrl: async () => ({ ok: true }) } })
  const brain = { calls: 0, async *stream() { brain.calls++; yield* [] } }
  const metrics = createMetrics()
  const frames = []
  const convo = createConversation({ brain, tools, systemPrompt: 'S', send: (f) => frames.push(f), metrics })
  await convo.ask('Open Discord', 'd1')
  assert.equal(brain.calls, 0, 'no model for an obvious command')
  assert.equal(launched.length, 1)
  assert.equal(launched[0].target, 'C:\\SM\\Discord.lnk')
  const done = frames.find((f) => f.type === 'done')
  assert.equal(done.tool, 'open_application')
  assert.equal(done.ok, true)
  assert.equal(metrics.routerTurns, 1)
})
