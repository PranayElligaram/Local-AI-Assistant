/**
 * The conversation engine: router first, then the local brain; honest failure;
 * tool calls executed by JARVIS; barge-in cancels; claimed-but-not-done actions
 * are never spoken.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { BrainError } from '../bridge/brain/provider.mjs'
import { UNAVAILABLE, createConversation } from '../bridge/assistant.mjs'
import { createTools } from '../bridge/tools.mjs'

const tick = () => new Promise((r) => setImmediate(r))

/** A scripted brain. Each turn takes the next script: events, or an error. */
function fakeBrain(...scripts) {
  const brain = {
    calls: 0,
    requests: [],
    async *stream(req) {
      brain.calls++
      brain.requests.push(req)
      const script = scripts.shift() ?? []
      if (script instanceof Error) throw script
      yield { type: 'model', provider: 'ollama', model: 'granite4:3b', fallbackUsed: false }
      for (const ev of script) {
        if (ev === 'wait') {
          await new Promise((resolve, reject) => {
            if (req.signal.aborted) return reject(new BrainError('aborted', 'cancelled'))
            req.signal.addEventListener('abort', () => reject(new BrainError('aborted', 'cancelled')), { once: true })
          })
        } else yield ev
      }
    },
  }
  return brain
}

function setup(brain) {
  const frames = []
  const launched = []
  const opened = []
  const apps = { spotify: 'Spotify', 'visual studio code': 'Visual Studio Code', calculator: 'Calculator' }
  const catalogue = {
    async resolve(name) {
      const hit = apps[String(name).toLowerCase()]
      if (String(name).toLowerCase() === 'visual studio') return { status: 'ambiguous', candidates: ['Visual Studio Code', 'Visual Studio Installer'] }
      return hit ? { status: 'found', app: { name: hit, type: 'startapp', target: hit }, method: 'exact' } : { status: 'not_found' }
    },
  }
  const tools = createTools({ catalogue, launcher: { launchApp: async (e) => (launched.push(e.name), { ok: true }), openUrl: async (u) => (opened.push(u), { ok: true }) } })
  const convo = createConversation({ brain, tools, systemPrompt: 'SYSTEM', send: (f) => frames.push(f) })
  const done = () => frames.filter((f) => f.type === 'done')
  return { convo, frames, done, launched, opened, tools }
}

test('deterministic commands never touch the model', async () => {
  const brain = fakeBrain()
  const { convo, done, launched } = setup(brain)
  await convo.ask('What time is it?', 'a1')
  await convo.ask("What's the date?", 'a2')
  await convo.ask('Open Spotify', 'a3')
  assert.equal(brain.calls, 0)
  assert.deepEqual(done().map((d) => [d.source, d.tool, d.ask]), [
    ['router', 'get_time', 'a1'],
    ['router', 'get_date', 'a2'],
    ['router', 'open_application', 'a3'],
  ])
  assert.deepEqual(launched, ['Spotify'])
})

test('known websites open at their trusted URL without touching the model', async () => {
  const brain = fakeBrain()
  const { convo, done, opened } = setup(brain)
  await convo.ask('Open YouTube in Google', 's1')
  await convo.ask('Open Gmail in Chrome', 's2')
  await convo.ask('Open Calendar', 's3')
  assert.equal(brain.calls, 0)
  assert.deepEqual(done().map((d) => [d.source, d.tool]), [['router', 'open_url'], ['router', 'open_url'], ['router', 'open_url']])
  assert.deepEqual(opened.map(String), ['https://www.youtube.com/', 'https://mail.google.com/', 'https://calendar.google.com/'])
})

test('conversation streams from the local model, tagged with the ask id', async () => {
  const brain = fakeBrain([{ type: 'text', delta: 'Paris is ' }, { type: 'text', delta: 'the **capital**.' }, { type: 'done' }])
  const { convo, frames, done } = setup(brain)
  await convo.ask('What is the capital of France?', 'q1')
  assert.equal(frames.filter((f) => f.type === 'text').map((f) => f.delta).join(''), 'Paris is the capital.')
  assert.equal(done()[0].source, 'ollama')
  assert.equal(done()[0].model, 'granite4:3b')
  assert.ok(frames.every((f) => f.ask === 'q1'))
  assert.equal(brain.requests[0].messages[0].content, 'SYSTEM')
  assert.ok(brain.requests[0].tools.length > 0)
})

test('an unavailable brain is said plainly, is not a success, and the next turn still works', async () => {
  const brain = fakeBrain(new BrainError('offline', 'Ollama is not reachable'), [{ type: 'text', delta: 'Back.' }])
  const { convo, done } = setup(brain)
  await convo.ask('Tell me a story', 'b1')
  assert.equal(done()[0].source, 'unavailable')
  assert.equal(done()[0].text, UNAVAILABLE)
  await convo.ask('What time is it?', 'b2')
  assert.equal(done()[1].source, 'router')
  await convo.ask('Hello again', 'b3')
  assert.equal(done()[2].source, 'ollama')
})

test('a model tool call is validated and executed by JARVIS, and recorded as a tool turn', async () => {
  const brain = fakeBrain(
    [{ type: 'tool_calls', calls: [{ name: 'open_application', arguments: { name: 'Calculator' } }] }, { type: 'done' }],
    [{ type: 'text', delta: 'Done.' }],
  )
  const { convo, done, launched } = setup(brain)
  await convo.ask("I'd like to do some sums", 't1')
  assert.deepEqual(launched, ['Calculator'])
  assert.equal(done()[0].text, 'Opening Calculator.')
  assert.deepEqual(done()[0].tools, ['open_application'])
  await convo.ask('thanks', 't2')
  const history = brain.requests[1].messages
  assert.ok(history.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.function.name === 'open_application'))
  assert.ok(history.some((m) => m.role === 'tool'))
})

test('unknown and malformed model tool calls are refused, never executed', async () => {
  const brain = fakeBrain([
    { type: 'tool_calls', calls: [{ name: 'run_shell', arguments: { command: 'del C:\\' } }, { name: 'open_application', arguments: { name: 'cmd /c whoami' } }] },
  ])
  const { convo, done, launched, tools } = setup(brain)
  await convo.ask('do something', 'm1')
  assert.deepEqual(launched, [])
  assert.equal(tools.state.rejected, 2)
  assert.equal(done()[0].text, "I can't do that. I can't do that.")
})

test('an action the model claims but did not call is done for real, or not claimed at all', async () => {
  const brain = fakeBrain(
    [{ type: 'text', delta: 'Opening Visual ' }, { type: 'text', delta: 'Studio Code.' }],
    [{ type: 'text', delta: "I've opened the flux capacitor." }],
    [{ type: 'text', delta: 'Starting points vary by region.' }],
  )
  const { convo, frames, done, launched } = setup(brain)
  await convo.ask('I need my editor', 'c1')
  assert.deepEqual(launched, ['Visual Studio Code'])
  assert.equal(done()[0].text, 'Opening Visual Studio Code.')
  await convo.ask('I want the flux thing', 'c2')
  assert.equal(done()[1].text, "I couldn't carry that out.")
  assert.ok(!frames.some((f) => f.type === 'text' && /flux capacitor/.test(f.delta)))
  await convo.ask('where do hikes start', 'c3')
  assert.equal(done()[2].text, 'Starting points vary by region.')
  assert.deepEqual(launched, ['Visual Studio Code'])
})

test('barge-in cancels the model turn and nothing more is spoken for it', async () => {
  const brain = fakeBrain([{ type: 'text', delta: 'This is a long answer. ' }, 'wait', { type: 'text', delta: 'NEVER' }], [{ type: 'text', delta: 'New answer.' }])
  const { convo, frames, done } = setup(brain)
  const first = convo.ask('Tell me everything', 'x1')
  await tick()
  await tick()
  assert.equal(convo.busy, true)
  const second = convo.ask('Actually, something else', 'x2')
  await Promise.all([first, second])
  assert.ok(!frames.some((f) => f.ask === 'x1' && f.type === 'done'))
  assert.ok(!frames.some((f) => /NEVER/.test(f.delta ?? '')))
  assert.equal(done()[0].ask, 'x2')
  assert.equal(convo.busy, false)

  const third = convo.ask('And another long one', 'x3')
  convo.interrupt()
  await third
  assert.ok(!frames.some((f) => f.ask === 'x3' && f.type === 'done'))
})

test('an ambiguous app asks, and the answer opens the chosen one', async () => {
  const brain = fakeBrain()
  const { convo, done, launched } = setup(brain)
  await convo.ask('Open Visual Studio', 'v1')
  assert.match(done()[0].text, /Visual Studio Code and Visual Studio Installer/)
  assert.deepEqual(launched, [])
  await convo.ask('the first one', 'v2')
  assert.deepEqual(launched, ['Visual Studio Code'])
  assert.equal(brain.calls, 0)
})

test('turn counters: a deterministic command counts as a router turn, a question as an AI turn', async () => {
  const { createMetrics } = await import('../bridge/assistant.mjs')
  const brain = fakeBrain([{ type: 'text', delta: 'Sunlight scatters off the air; blue scatters most.' }, { type: 'done' }])
  const metrics = createMetrics()
  const frames = []
  const tools = createTools({ catalogue: { resolve: async () => ({ status: 'not_found' }) }, launcher: { launchApp: async () => ({ ok: true }), openUrl: async () => ({ ok: true }) } })
  const convo = createConversation({ brain, tools, systemPrompt: 'S', send: (f) => frames.push(f), metrics })
  await convo.ask('What time is it?', 'r1')
  assert.equal(metrics.routerTurns, 1)
  assert.equal(metrics.aiTurns, 0)
  await convo.ask('Why is the sky blue?', 'r2')
  assert.equal(brain.calls, 1, 'an unmatched question falls through to the model')
  assert.equal(metrics.aiTurns, 1)
  assert.equal(metrics.routerTurns, 1)
  const done = frames.filter((f) => f.type === 'done')
  assert.equal(done[1].source, 'ollama')
  assert.equal(done[1].model, 'granite4:3b')
  assert.match(done[1].text, /scatter/)
  assert.doesNotMatch(done[1].text, /didn't understand|unknown command/i)
})
