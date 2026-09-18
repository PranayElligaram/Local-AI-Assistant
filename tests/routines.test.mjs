/**
 * Daily routines: JARVIS-owned, deterministic, never model-generated. Sign-out
 * needs a spoken confirmation and is never reachable by the model.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { route } from '../bridge/router.mjs'
import { createConversation } from '../bridge/assistant.mjs'
import { createTools, DAILY_START_ROUTINE } from '../bridge/tools.mjs'
import { signOut, signOutCommand } from '../bridge/apps/launch.mjs'

function setup({ failUrl } = {}) {
  const opened = []
  let signOuts = 0
  const launcher = {
    launchApp: async () => ({ ok: true }),
    openUrl: async (u) => (opened.push(u), u === failUrl ? { ok: false, error: 'boom' } : { ok: true }),
    signOut: async () => (signOuts++, { ok: true }),
  }
  const tools = createTools({ catalogue: { async resolve() { return { status: 'not_found' } } }, launcher, now: () => new Date(2026, 8, 18, 7, 5) })
  const brain = { calls: 0, async *stream() { brain.calls++ } }
  const frames = []
  const convo = createConversation({ brain, tools, systemPrompt: 'SYSTEM', send: (f) => frames.push(f) })
  const last = () => frames.filter((f) => f.type === 'done').at(-1)
  return { tools, convo, brain, opened, last, signOuts: () => signOuts }
}

test('routine phrases route deterministically', () => {
  assert.deepEqual(route('Good morning, Jarvis'), { tool: 'good_morning', args: {} })
  assert.deepEqual(route('Start today'), { tool: 'start_today', args: {} })
  assert.deepEqual(route('Good night'), { tool: 'good_night', args: {} })
  assert.deepEqual(route('Confirm good night'), { tool: 'confirm_good_night', args: {} })
  assert.deepEqual(route('Cancel good night'), { tool: 'cancel_good_night', args: {} })
})

test('"Good morning" greets without the model and opens nothing', async () => {
  const { convo, brain, opened, last } = setup()
  await convo.ask('Good morning', 'm1')
  assert.equal(brain.calls, 0)
  assert.deepEqual(opened, [])
  assert.equal(last().source, 'router')
  assert.match(last().text, /^Good morning\. .*JARVIS is online and ready\.$/)
})

test('"Start today" opens Calendar then Gmail at their trusted URLs', async () => {
  const { convo, brain, opened, last } = setup()
  await convo.ask('Start today', 't1')
  assert.equal(brain.calls, 0)
  assert.deepEqual(opened, ['https://calendar.google.com', 'https://mail.google.com'])
  assert.equal(last().text, 'Your daily workspace is ready.')
  assert.deepEqual(DAILY_START_ROUTINE.map((i) => i.type), ['url', 'url'])
})

test('a failed routine item does not stop the rest, and the issue is reported', async () => {
  const { convo, opened, last } = setup({ failUrl: 'https://calendar.google.com' })
  await convo.ask('Start today', 't2')
  assert.deepEqual(opened, ['https://calendar.google.com', 'https://mail.google.com'])
  assert.equal(last().ok, false)
  assert.match(last().text, /finished with an issue/)
})

test('"Good night" alone never signs out; confirmation does', async () => {
  const { convo, last, signOuts } = setup()
  await convo.ask('Good night', 'n1')
  assert.equal(signOuts(), 0)
  assert.equal(last().text, "Good night. Say 'confirm good night' to sign out of Windows.")
  await convo.ask('Confirm good night', 'n2')
  assert.equal(signOuts(), 1)
  // The confirmation is spent: saying it again does nothing.
  await convo.ask('Confirm good night', 'n3')
  assert.equal(signOuts(), 1)
})

test('"Confirm good night" without a pending "Good night" does nothing', async () => {
  const { convo, signOuts } = setup()
  await convo.ask('Confirm good night', 'c1')
  assert.equal(signOuts(), 0)
})

test('"Cancel good night" clears the pending sign-out', async () => {
  const { convo, last, signOuts } = setup()
  await convo.ask('Good night', 'x1')
  await convo.ask('Cancel good night', 'x2')
  assert.match(last().text, /cancelled/)
  await convo.ask('Confirm good night', 'x3')
  assert.equal(signOuts(), 0)
})

test('the model cannot see or trigger any routine or sign-out', async () => {
  const { tools, signOuts } = setup()
  const menu = tools.modelSchemas().map((s) => s.function.name)
  for (const name of ['good_morning', 'start_today', 'good_night', 'confirm_good_night', 'cancel_good_night']) {
    assert.ok(!menu.includes(name), name)
    assert.equal((await tools.execute(name, {}, { origin: 'model' })).rejected, true)
  }
  await tools.execute('good_night', {}, { origin: 'router' })
  assert.equal((await tools.execute('confirm_good_night', {}, { origin: 'model' })).rejected, true)
  assert.equal(signOuts(), 0)
  assert.ok(!tools.names().some((n) => /shell|exec|command|run/.test(n)))
})

test('routine tools take no arguments, so nothing can be smuggled in', async () => {
  const { tools, signOuts } = setup()
  await tools.execute('good_night', {}, { origin: 'router' })
  const r = await tools.execute('confirm_good_night', { command: 'cmd /c del C:' }, { origin: 'router' })
  assert.equal(r.rejected, true)
  assert.equal(signOuts(), 0)
})

test('sign-out is a fixed shutdown /l with no shell', async () => {
  const [file, args] = signOutCommand()
  assert.match(file, /\\System32\\shutdown\.exe$/i)
  assert.deepEqual(args, ['/l'])
  const calls = []
  const spawnFn = (f, a, o) => {
    calls.push([f, a, o])
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('spawn'))
    return child
  }
  assert.equal((await signOut({ spawnFn })).ok, true)
  assert.deepEqual(calls[0][1], ['/l'])
  assert.equal(calls[0][2].shell, false)
  assert.equal(signOut.length, 0)
  const dry = await signOut({ dryRun: true, spawnFn: () => assert.fail('spawned in dry run') })
  assert.equal(dry.dryRun, true)
})
