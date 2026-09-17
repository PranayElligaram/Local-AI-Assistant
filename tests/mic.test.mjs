/**
 * Microphone selection, ported from the previous implementation's rules.
 *
 * The expensive bug these prevent is not "no sound" — it is being confidently
 * connected to the wrong device, which looks exactly like a broken assistant
 * and takes an afternoon to find.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseMic, retryDelay } from '../src/lib/mic.ts'

const devices = [
  { deviceId: 'id-array', label: 'Microphone Array (Realtek Audio)' },
  { deviceId: 'id-yeti', label: 'Microphone (Blue Yeti)' },
  { deviceId: 'id-cam', label: 'Camera Microphone (Logitech Webcam)' },
]

test('no preference means the system default', () => {
  const choice = chooseMic(devices, '')
  assert.equal(choice.deviceId, '')
  assert.equal(choice.reason, 'default')
  assert.equal(choice.fallback, '')
})

test('a numeric preference selects by index', () => {
  const choice = chooseMic(devices, '1')
  assert.equal(choice.deviceId, 'id-yeti')
  assert.equal(choice.reason, 'index')
})

test('a unique name fragment selects that device, case-insensitively', () => {
  const choice = chooseMic(devices, 'yeti')
  assert.equal(choice.deviceId, 'id-yeti')
  assert.equal(choice.reason, 'name')
  assert.equal(choice.fallback, '')
})

test('an ambiguous name is refused rather than guessed at', () => {
  const choice = chooseMic(devices, 'microphone')
  assert.equal(choice.deviceId, '')
  assert.equal(choice.reason, 'fallback')
  assert.match(choice.fallback, /matches 3 microphones/)
})

test('a preference that matches nothing falls back — and says so', () => {
  const choice = chooseMic(devices, 'shure')
  assert.equal(choice.deviceId, '')
  assert.equal(choice.reason, 'fallback')
  assert.match(choice.fallback, /no microphone matches/)
})

test('an index past the end falls back with the count, not a crash', () => {
  const choice = chooseMic(devices, '9')
  assert.equal(choice.deviceId, '')
  assert.equal(choice.reason, 'fallback')
  assert.match(choice.fallback, /3 available/)
})

test('a fallback is never silent', () => {
  // The old implementation's hard rule, kept: being on a different microphone
  // than you configured is survivable; not knowing it is not.
  for (const preference of ['shure', 'microphone', '9']) {
    assert.notEqual(chooseMic(devices, preference).fallback, '')
  }
})

test('with no devices at all, the default is still what we ask for', () => {
  const choice = chooseMic([], '')
  assert.equal(choice.deviceId, '')
  assert.equal(choice.reason, 'default')
})

test('recovery backs off but never gives up', () => {
  assert.equal(retryDelay(0), 250)
  assert.ok(retryDelay(1) > retryDelay(0))
  assert.ok(retryDelay(4) >= retryDelay(3))
  // A device plugged back in twenty minutes later must still be picked up, so
  // the delay tops out rather than growing without bound.
  assert.equal(retryDelay(50), retryDelay(4))
})
