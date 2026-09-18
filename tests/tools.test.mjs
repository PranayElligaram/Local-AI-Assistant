/**
 * The tool boundary: the model selects, JARVIS validates and executes.
 * Nothing a model says reaches a shell, a path, or a command line.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools, safeUrl, validateArgs } from '../bridge/tools.mjs'
import { launchApp, launchCommand, openUrl } from '../bridge/apps/launch.mjs'

function setup(entries = [{ name: 'Spotify', key: 'spotify', aliases: [], type: 'startapp', target: 'SpotifyAB.SpotifyMusic!Spotify', source: 'start-apps' }], extra = {}) {
  const launched = []
  const opened = []
  const catalogue = {
    async resolve(name) {
      const hit = entries.find((e) => e.key === String(name).toLowerCase())
      return hit ? { status: 'found', app: hit, method: 'exact' } : { status: 'not_found' }
    },
    async refresh() {
      return { count: entries.length, sources: {} }
    },
  }
  const launcher = {
    launchApp: async (entry) => (launched.push(entry), { ok: true }),
    openUrl: async (url) => (opened.push(url), { ok: true }),
  }
  const lifecycle = { restarted: 0, stopped: 0, restart() { this.restarted++ }, stop() { this.stopped++ } }
  const ui = []
  const tools = createTools({ catalogue, launcher, lifecycle, ui: (op) => ui.push(op), now: () => new Date(2026, 8, 18, 15, 42), ...extra })
  return { tools, launched, opened, lifecycle, ui }
}

test('a valid tool call runs and returns a structured result', async () => {
  const { tools, launched } = setup()
  const r = await tools.execute('open_application', { name: 'Spotify' }, { origin: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.tool, 'open_application')
  assert.equal(r.say, 'Opening Spotify.')
  assert.equal(launched[0].name, 'Spotify')
  assert.equal(tools.state.last, 'open_application')
  assert.equal(tools.state.app.resolved, 'Spotify')
})

test('time and date come from the clock', async () => {
  const { tools } = setup()
  assert.match((await tools.execute('get_time', {}, { origin: 'router' })).say, /^It's 3:42\s?pm\.$/i)
  assert.match((await tools.execute('get_date', {}, { origin: 'router' })).say, /Friday.*18.*September.*2026/)
})

test('unknown and malformed tool requests are rejected', async () => {
  const { tools } = setup()
  for (const [name, args] of [
    ['run_shell', { command: 'dir' }],
    ['powershell', {}],
    [undefined, {}],
    [42, {}],
    ['open_application', '{not json'],
    ['open_application', ['Spotify']],
    ['open_application', null],
  ]) {
    const r = await tools.execute(name, args, { origin: 'model' })
    assert.equal(r.ok, false, String(name))
    assert.equal(r.rejected, true, String(name))
  }
  assert.ok(tools.state.rejected >= 7)
})

test('JSON-string arguments from a model are parsed, then validated', async () => {
  const { tools } = setup()
  assert.equal((await tools.execute('open_application', '{"name":"Spotify"}', { origin: 'model' })).ok, true)
})

test('invalid arguments are rejected before anything runs', async () => {
  const { tools, launched } = setup()
  for (const args of [{}, { name: '' }, { name: 'x'.repeat(81) }, { name: 'Spotify', extra: 1 }, { name: 7 }]) {
    const r = await tools.execute('open_application', args, { origin: 'model' })
    assert.equal(r.rejected, true, JSON.stringify(args))
  }
  assert.equal(launched.length, 0)
})

test('no executable path, command line or shell argument gets through open_application', async () => {
  const { tools, launched } = setup()
  for (const name of [
    'C:\\Windows\\System32\\cmd.exe',
    'powershell.exe -Command Remove-Item C:\\ -Recurse',
    'powershell -c "whoami"',
    'cmd /c del *',
    'calc | whoami',
    'app; rm -rf /',
    '$(whoami)',
    '`whoami`',
    '..\\..\\evil',
    'node -e process.exit()',
    'python script.py',
    'pwsh --version',
  ]) {
    const r = await tools.execute('open_application', { name }, { origin: 'model' })
    assert.equal(r.rejected, true, name)
  }
  assert.equal(launched.length, 0)
  // "&" is a real name character ("Films & TV"). It is only ever a NAME: with
  // no shell anywhere it cannot chain a command, and it resolves to nothing.
  const r = await tools.execute('open_application', { name: 'notepad & calc' }, { origin: 'model' })
  assert.equal(r.ok, false)
  assert.equal(launched.length, 0)
})

test('there is no shell or command tool for a model to choose', () => {
  const { tools } = setup()
  const names = tools.modelSchemas().map((t) => t.function.name)
  for (const n of names) assert.doesNotMatch(n, /shell|command|exec|powershell|cmd|script|run_|file|delete|write|install/)
  assert.deepEqual(names.sort(), ['get_date', 'get_system_status', 'get_time', 'open_application', 'open_url', 'search_web', 'show_diagnostics'])
})

test('lifecycle tools obey the router only, never the model', async () => {
  const { tools, lifecycle } = setup()
  assert.equal((await tools.execute('restart_jarvis', {}, { origin: 'model' })).rejected, true)
  assert.equal((await tools.execute('stop_jarvis', {}, { origin: 'model' })).rejected, true)
  assert.equal(lifecycle.restarted + lifecycle.stopped, 0)
  assert.equal((await tools.execute('restart_jarvis', {}, { origin: 'router' })).ok, true)
  assert.equal(lifecycle.restarted, 1)
})

test('only http(s) addresses open, and searches are encoded', async () => {
  const { tools, opened } = setup()
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ms-settings:', 'https://user:pass@example.com', 'data:text/html,hi'])
    assert.equal((await tools.execute('open_url', { url }, { origin: 'model' })).rejected, true, url)
  assert.equal((await tools.execute('open_url', { url: 'example.com' }, { origin: 'model' })).ok, true)
  assert.equal(opened[0], 'https://example.com/')
  await tools.execute('search_web', { query: 'a&b "c" | d' }, { origin: 'model' })
  assert.equal(opened[1], 'https://www.google.com/search?q=a%26b%20%22c%22%20%7C%20d')
  assert.equal(safeUrl('https://example.com/a b'), 'https://example.com/a%20b')
})

test('diagnostics are shown through the interface channel', async () => {
  const { tools, ui } = setup()
  assert.equal((await tools.execute('show_diagnostics', {}, { origin: 'model' })).ok, true)
  assert.deepEqual(ui, ['diagnostics'])
})

test('the writes permission level is enforced when a write tool exists', () => {
  // No write tool is registered in this build; the mode is reported honestly.
  assert.equal(setup().tools.mode, 'safe')
  assert.equal(setup(undefined, { allowWrites: true }).tools.mode, 'writes')
})

test('the schema validator is strict about types and extras', () => {
  const schema = { type: 'object', properties: { a: { type: 'string', maxLength: 3 } }, required: ['a'] }
  assert.equal(validateArgs(schema, { a: 'abc' }), null)
  assert.match(validateArgs(schema, { a: 'abcd' }), /too long/)
  assert.match(validateArgs(schema, {}), /missing/)
  assert.match(validateArgs(schema, { a: 'x', b: 1 }), /unexpected/)
  assert.match(validateArgs(schema, 'a'), /object/)
})

// --- the launcher itself ---------------------------------------------------

test('launch commands never carry arguments and never use a shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-launch-'))
  const exe = join(dir, 'tool.exe')
  const lnk = join(dir, 'Tool.lnk')
  writeFileSync(exe, '')
  writeFileSync(lnk, '')
  assert.deepEqual(launchCommand({ type: 'exe', target: exe }), [exe, []])
  assert.deepEqual(launchCommand({ type: 'shortcut', target: lnk })[1], [lnk])
  assert.deepEqual(launchCommand({ type: 'startapp', target: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' })[1], [
    'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
  ])
  assert.throws(() => launchCommand({ type: 'exe', target: 'calc.exe' }), /absolute/)
  assert.throws(() => launchCommand({ type: 'exe', target: join(dir, 'missing.exe') }), /no longer there/)
  assert.throws(() => launchCommand({ type: 'startapp', target: 'x" & calc' }), /forbidden/)
  assert.throws(() => launchCommand({ type: 'uri', target: 'https://evil' }), /unsupported/)
  assert.throws(() => launchCommand({ type: 'script', target: exe }), /unknown/)
})

test('launching spawns detached with shell disabled, and reports spawn errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-launch-'))
  const exe = join(dir, 'tool.exe')
  writeFileSync(exe, '')
  const calls = []
  const fake = (outcome) => (file, args, opts) => {
    calls.push({ file, args, opts })
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => (outcome === 'ok' ? child.emit('spawn') : child.emit('error', new Error('ENOENT'))))
    return child
  }
  assert.deepEqual(await launchApp({ type: 'exe', target: exe }, { spawnFn: fake('ok') }), { ok: true })
  assert.equal(calls[0].opts.shell, false)
  assert.equal(calls[0].opts.detached, true)
  assert.deepEqual(calls[0].args, [])
  assert.deepEqual(await launchApp({ type: 'exe', target: exe }, { spawnFn: fake('fail') }), { ok: false, error: 'ENOENT' })
  const dry = await launchApp({ type: 'exe', target: exe }, { dryRun: true, spawnFn: () => assert.fail('dry run spawned') })
  assert.equal(dry.dryRun, true)
  assert.equal((await openUrl('https://example.com/', { spawnFn: fake('ok') })).ok, true)
  assert.equal(calls.at(-1).opts.shell, false)
})
