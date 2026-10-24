import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBrowserModule } from './browser-modules.mjs'
const tick = () => new Promise(r => setImmediate(r))
async function setup(t, premium = false) {
  const instances = [], listeners = new Set(), events = []
  let mode = 'wake'
  class Recognizer {
    constructor() { instances.push(this) }
    start() { this.onstart?.() }
    abort() { this.aborted = true }
    result(text) { const row = [{ transcript: text }]; row.isFinal = true; this.onresult?.({ resultIndex: 0, results: [row] }) }
  }
  globalThis.window = { SpeechRecognition: Recognizer }
  globalThis.__voiceTest = { listeners, premium, capture: null, stopped: false }
  const module = await loadBrowserModule('src/lib/voice.ts', {
    '../config': "export const BRIDGE_HTTP_URL = 'http://test.invalid'",
    './audio': 'export const getMicSoon = async () => ({}); export const onMicChange = fn => { globalThis.__voiceTest.listeners.add(fn); return () => globalThis.__voiceTest.listeners.delete(fn) }',
    './tts': "export const speakingNow = () => ''; export const speakingSince = () => 0; export const speakingEndedAt = () => 0; export const lastSpoken = () => ''",
    './capabilities': 'export const caps = () => ({ stt: globalThis.__voiceTest.premium })',
    './vad': 'export async function startVad(h) { globalThis.__voiceTest.capture = h; return { stop() { globalThis.__voiceTest.stopped = true }, live: () => true, meter: () => ({ speaking: false }), setGuard() {} } }',
  })
  const voice = await module.startVoice({ mode: () => mode, onWake: text => { events.push(['wake', text]); mode = 'command' }, onSpeechStart() {}, onPartial() {}, onUtterance: text => events.push(['utterance', text]), onError: text => events.push(['error', text]) })
  t.after(() => { voice.stop(); delete globalThis.window; delete globalThis.__voiceTest })
  return { voice, instances, listeners, events, module }
}
test('browser wake and following command flow through the real voice module', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { instances, events } = await setup(t)
  instances[0].result('Hey Jarvis')
  instances[0].result('Tell me a joke.')
  t.mock.timers.tick(1000)
  assert.deepEqual(events, [['wake', ''], ['utterance', 'Tell me a joke.']])
})
test('old recognition end events cannot shut down the replacement', async t => {
  const { voice, instances, listeners } = await setup(t)
  const old = instances[0]
  for (const fn of listeners) fn({})
  assert.equal(instances.length, 2); assert.equal(old.aborted, true)
  old.onend(); old.result('Hey Jarvis')
  assert.equal(voice.live(), true)
  voice.stop(); assert.equal(voice.live(), false)
})
test('browser recognition restarts when microphone permission returns', async t => {
  const { voice, instances, listeners } = await setup(t)
  instances[0].onerror({ error: 'not-allowed' }); instances[0].onend()
  assert.equal(voice.live(), false)
  for (const fn of listeners) fn({})
  assert.equal(voice.live(), true); assert.equal(instances.length, 2)
})
test('an STT authorization refusal immediately switches to browser recognition', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }))
  const { module, voice, instances } = await setup(t, true)
  globalThis.__voiceTest.capture.onEnd(new Blob(['synthetic test audio']))
  await tick()
  assert.equal(globalThis.__voiceTest.stopped, true)
  assert.equal(module.diag.engine, 'browser'); assert.equal(instances.length, 1)
  assert.equal(voice.live(), true)
})
test('stopping while STT is pending ignores its late result', async t => {
  let finish
  t.mock.method(globalThis, 'fetch', () => new Promise(r => finish = r))
  const { voice, events } = await setup(t, true)
  globalThis.__voiceTest.capture.onEnd(new Blob(['synthetic test audio']))
  voice.stop()
  finish(Response.json({ text: 'Hey Jarvis' })); await tick()
  assert.deepEqual(events, [])
})
