import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBrowserModule } from './browser-modules.mjs'
const tick = () => new Promise(r => setImmediate(r))
function media() {
  const track = new EventTarget()
  Object.assign(track, { readyState: 'live', label: 'test microphone', getSettings: () => ({}), stop() { this.readyState = 'ended' } })
  return { getTracks: () => [track], getAudioTracks: () => [track], track }
}
async function setup(t, getUserMedia) {
  const devices = new EventTarget()
  Object.assign(devices, { getUserMedia, enumerateDevices: async () => [] })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: devices } })
  const audio = await loadBrowserModule('src/lib/audio.ts', { '../config': "export const MIC_PREFERENCE = ''" })
  t.after(() => { audio.releaseMic(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator })
  return { audio, devices }
}
test('microphone consumers and device recovery share one pending request', async t => {
  let resolveOpen, calls = 0
  const { audio, devices } = await setup(t, () => { calls++; return new Promise(r => resolveOpen = r) })
  let changes = 0
  audio.onMicChange(() => changes++)
  const first = audio.getMic(), second = audio.getMic()
  devices.dispatchEvent(new Event('devicechange'))
  await tick()
  assert.equal(calls, 1)
  const stream = media(); resolveOpen(stream)
  assert.equal(await first, stream); assert.equal(await second, stream)
  await tick(); assert.equal(changes, 1)
})
test('permission timeout recovers when the original request is granted later', async t => {
  let resolveOpen
  const { audio } = await setup(t, () => new Promise(r => resolveOpen = r))
  let changes = 0; audio.onMicChange(() => changes++)
  await assert.rejects(audio.getMicSoon(5), { name: 'TimeoutError' })
  const stream = media(); resolveOpen(stream); await tick()
  assert.equal(audio.micDiag.open, true); assert.equal(changes, 1)
  assert.equal(await audio.getMic(), stream)
})
test('releasing during permission wait stops a late stream and suppresses device recovery', async t => {
  let resolveOpen, calls = 0
  const { audio, devices } = await setup(t, () => { calls++; return new Promise(r => resolveOpen = r) })
  const request = audio.getMic(); audio.releaseMic()
  const stream = media(); resolveOpen(stream)
  await assert.rejects(request, { name: 'AbortError' })
  devices.dispatchEvent(new Event('devicechange')); await tick()
  assert.equal(stream.track.readyState, 'ended'); assert.equal(calls, 1)
  assert.equal(audio.micDiag.open, false)
})
test('track end and devicechange together reopen only once', async t => {
  let calls = 0
  const { audio, devices } = await setup(t, async () => { calls++; return media() })
  const first = await audio.getMic()
  first.track.readyState = 'ended'; first.track.dispatchEvent(new Event('ended'))
  devices.dispatchEvent(new Event('devicechange')); await tick()
  assert.equal(calls, 2); assert.equal(audio.micDiag.open, true)
  assert.notEqual(await audio.getMic(), first)
})
