/**
 * Half-duplex voice. While JARVIS thinks or talks, nothing the microphone
 * hears may become a barge-in, a wake or a turn: his own ElevenLabs voice came
 * back through the speakers and he answered it. Voice barge-in is off
 * (VOICE_BARGE_IN); the keyboard still interrupts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBrowserModule } from './browser-modules.mjs'

const tick = () => new Promise((r) => setImmediate(r))

/** premium: VAD + /stt path. Otherwise the browser recogniser. */
async function setup(t, { premium = true, mode: initial = 'guard' } = {}) {
  let mode = initial
  const events = []
  const instances = []
  class Recognizer {
    constructor() { instances.push(this) }
    start() { this.onstart?.() }
    abort() { this.aborted = true }
    result(text, isFinal = true) {
      const row = [{ transcript: text }]
      row.isFinal = isFinal
      this.onresult?.({ resultIndex: 0, results: [row] })
    }
  }
  globalThis.window = { SpeechRecognition: Recognizer }
  globalThis.__hdTest = { capture: null, speaking: '', since: 0, ended: 0 }
  const module = await loadBrowserModule('src/lib/voice.ts', {
    '../config': "export const BRIDGE_HTTP_URL = 'http://test.invalid'",
    './audio': 'export const getMicSoon = async () => ({}); export const onMicChange = () => () => {}',
    './tts': [
      'export const speakingNow = () => globalThis.__hdTest.speaking',
      'export const speakingSince = () => globalThis.__hdTest.since',
      'export const speakingEndedAt = () => globalThis.__hdTest.ended',
      "export const lastSpoken = () => globalThis.__hdTest.last ?? ''",
    ].join('\n'),
    './capabilities': `export const caps = () => ({ stt: ${premium} })`,
    './vad': 'export async function startVad(h) { globalThis.__hdTest.capture = h; return { stop() {}, live: () => true, meter: () => ({ speaking: false }), setGuard() {} } }',
  })
  const voice = await module.startVoice({
    mode: () => mode,
    onWake: (text) => events.push(['wake', text]),
    onSpeechStart: () => events.push('speech-start'),
    onPartial() {},
    onUtterance: (text) => events.push(['utterance', text]),
    onError: (text) => events.push(['error', text]),
  })
  const tts = globalThis.__hdTest
  const speak = (line) => { tts.speaking = line; tts.since = Date.now() }
  const finishSpeaking = () => { tts.speaking = ''; tts.since = 0; tts.ended = Date.now() - 10_000 }
  t.after(() => {
    voice.stop()
    delete globalThis.window
    delete globalThis.__hdTest
  })
  return { module, voice, events, instances, speak, finishSpeaking, capture: () => tts.capture, setMode: (m) => (mode = m) }
}

test('voice barge-in is disabled: talking over JARVIS does not interrupt him', async (t) => {
  const { module, events, capture } = await setup(t)
  assert.equal(module.VOICE_BARGE_IN, false)
  capture().onStart()
  assert.deepEqual(events, [])
})

test('speech while listening for a command is not a barge-in', async (t) => {
  const { events, capture, setMode } = await setup(t)
  setMode('command')
  capture().onStart()
  setMode('wake')
  capture().onStart()
  assert.deepEqual(events, [])
})

test('a segment captured while TTS is active never reaches /stt or the app', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ text: 'Why is the sky blue?' }))
  const { events, capture, setMode, speak } = await setup(t, { mode: 'command' })
  speak('The sky is blue because of Rayleigh scattering.')
  capture().onStart()
  capture().onEnd(new Blob(['his own voice']))
  await tick()
  assert.equal(fetch.mock.callCount(), 0)
  setMode('wake')
  capture().onEnd(new Blob(['still his own voice']))
  await tick()
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(events, [])
})

test('own TTS output cannot create a recursive ask: a transcript landing after he started speaking is dropped', async (t) => {
  let finish
  t.mock.method(globalThis, 'fetch', () => new Promise((r) => (finish = r)))
  const { module, events, capture, speak } = await setup(t, { mode: 'command' })
  capture().onStart()
  capture().onEnd(new Blob(['user command']))
  await tick()
  // The app took a previous turn and he is now speaking the answer.
  speak('Here is the answer.')
  finish(Response.json({ text: 'Here is the answer.' }))
  await tick(); await tick()
  assert.deepEqual(events, [])
  assert.match(module.diag.dropped, /stale|cycle/)
})

test('a stale ElevenLabs STT result from an older generation is ignored', async (t) => {
  let finish
  t.mock.method(globalThis, 'fetch', () => new Promise((r) => (finish = r)))
  const { module, events, capture, setMode, speak, finishSpeaking } = await setup(t, { mode: 'command' })
  capture().onStart()
  capture().onEnd(new Blob(['old segment']))
  await tick()
  const before = module.diag.recognitionGeneration
  // A whole cycle passes while the request is in flight: he speaks, finishes,
  // and the loop re-arms on the wake word.
  speak('An answer.'); setMode('guard'); capture().onLevel(0)
  finishSpeaking(); setMode('wake'); capture().onLevel(0)
  assert.ok(module.diag.recognitionGeneration >= before + 2, 'generation moves on close and on re-open')
  finish(Response.json({ text: 'Hey Jarvis' }))
  await tick(); await tick()
  assert.deepEqual(events, [])
})

test('a completed browser command produces exactly one utterance, and nothing after the turn starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { events, instances, setMode, speak } = await setup(t, { premium: false, mode: 'command' })
  instances[0].result('What time is it?')
  t.mock.timers.tick(1000)
  assert.deepEqual(events.filter((e) => e[0] === 'utterance'), [['utterance', 'What time is it?']])
  // The app sent the ask; he is thinking, then speaking.
  setMode('guard'); speak('It is ten past three.')
  t.mock.timers.tick(200)
  instances[0].result('It is ten past three.')
  instances.at(-1).result('It is ten past three.')
  t.mock.timers.tick(2000)
  assert.equal(events.filter((e) => e[0] === 'utterance').length, 1)
})

test('recognition is torn down while TTS is active and a fresh recogniser re-arms on the wake word only after it ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { module, events, instances, setMode, speak, finishSpeaking } = await setup(t, { premium: false, mode: 'wake' })
  const first = instances[0]
  const gen0 = module.diag.recognitionGeneration
  setMode('guard'); speak('Good afternoon, sir.')
  t.mock.timers.tick(200)
  assert.equal(first.aborted, true, 'recogniser stopped while he speaks')
  assert.equal(instances.length, 1, 'no recogniser runs while he speaks')
  assert.equal(module.diag.voiceState, 'SPEAKING')
  // A stale callback from the old recogniser arriving now is ignored.
  first.result('Hey Jarvis, good afternoon sir')
  // Still speaking: even an app that thinks it is dormant does not re-arm.
  setMode('wake')
  t.mock.timers.tick(200)
  assert.equal(instances.length, 1)
  finishSpeaking()
  t.mock.timers.tick(200)
  assert.equal(instances.length, 2, 'fresh recogniser after TTS')
  assert.ok(module.diag.recognitionGeneration >= gen0 + 2)
  assert.equal(module.diag.voiceState, 'WAKE_LISTENING')
  assert.deepEqual(events, [])
  instances[1].result('Hey Jarvis')
  assert.deepEqual(events, [['wake', '']])
})

test('a wake heard only as a partial waits for the whole phrase instead of sending a fragment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { events, instances } = await setup(t, { premium: false, mode: 'wake' })
  instances[0].result('hey Jarvis what', false)
  assert.deepEqual(events, [])
  instances[0].result('hey Jarvis what time is it', true)
  assert.deepEqual(events, [['wake', 'what time is it']])
})

test('after a short line (the wake greeting) the microphone re-arms in 250 ms; after an answer, 500 ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const { module, events, instances, setMode, speak } = await setup(t, { premium: false, mode: 'wake' })
  assert.equal(module.rearmFor('Yes, sir?'), module.SHORT_REARM_MS)
  assert.equal(module.rearmFor('The sky is blue because of Rayleigh scattering.'), module.REARM_MS)
  assert.equal(module.rearmFor(''), module.REARM_MS)
  const tts = globalThis.__hdTest
  const finish = (line) => { tts.speaking = ''; tts.since = 0; tts.ended = Date.now(); tts.last = line }

  // "Hey Jarvis" alone: he answers to his name, then listens for the question.
  instances[0].result('Hey Jarvis')
  assert.deepEqual(events, [['wake', '']])
  setMode('command')
  speak('Yes, sir?')
  t.mock.timers.tick(150)
  assert.equal(instances.length, 1, 'no recogniser while the greeting plays')
  t.mock.timers.tick(450) // the greeting lasts 0.6 s
  finish('Yes, sir?')
  t.mock.timers.tick(150)
  assert.equal(instances.length, 1, 'still shut inside the short re-arm')
  t.mock.timers.tick(150)
  assert.equal(instances.length, 2, 'listening again 250-300 ms after the greeting')
  assert.equal(module.diag.voiceState, 'COMMAND_LISTENING')
  assert.ok(module.diag.wakeToListenMs >= 850 && module.diag.wakeToListenMs <= 950, `wake -> listening ${module.diag.wakeToListenMs} ms`)
  assert.equal(module.diag.wakeToMicMs, module.diag.wakeToListenMs, 'the stub recogniser starts at once')

  // A full answer keeps the longer guard.
  setMode('guard')
  speak('The sky is blue because of Rayleigh scattering.')
  t.mock.timers.tick(300)
  finish('The sky is blue because of Rayleigh scattering.')
  setMode('wake')
  t.mock.timers.tick(300)
  assert.equal(instances.length, 2, 'still shut 300 ms after a long answer')
  t.mock.timers.tick(300)
  assert.equal(instances.length, 3)
})

test('a wake with the command in the same breath records no listening delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const { module, events, instances } = await setup(t, { premium: false, mode: 'wake' })
  instances[0].result('Hey Jarvis what time is it')
  assert.deepEqual(events, [['wake', 'what time is it']])
  t.mock.timers.tick(2000)
  assert.equal(module.diag.wakeToListenMs, 0)
})
