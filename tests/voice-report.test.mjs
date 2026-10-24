import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeVoiceReport } from '../bridge/voice-report.mjs'

test('the voice report keeps the wake/command state the diagnostics need', () => {
  const r = sanitizeVoiceReport({
    engine: 'browser', voiceState: 'COMMAND_LISTENING', voiceMode: 'COMMAND', micCapturing: true,
    wakes: 3, restarts: 1, dropCode: 'echo', wakeRejectCode: 'debounced', lastWakeRejectionAt: 5,
    commandSince: 7, lastError: 'network', phaseTransition: 'listening -> dormant (timeout)',
    listeningSince: 9, listenTimeouts: 2,
  })
  assert.equal(r.voiceMode, 'COMMAND')
  assert.equal(r.micCapturing, true)
  assert.equal(r.dropCode, 'echo')
  assert.equal(r.wakeRejectCode, 'debounced')
  assert.equal(r.lastError, 'network')
  assert.equal(r.phaseTransition, 'listening -> dormant (timeout)')
  assert.equal(r.listenTimeouts, 2)
})

test('nothing heard crosses into the bridge, whatever the page sends', () => {
  const r = sanitizeVoiceReport({
    voiceMode: 'say hello', dropCode: 'heard "my password is hunter2"',
    lastError: 'heard "call mum on 07700 900123"', phaseTransition: 'open my bank account please',
    heard: 'secret', holding: 'secret', lastWakePhrase: 'hey jarvis', lastFinalTranscript: 'secret',
  })
  const text = JSON.stringify(r)
  for (const leak of ['hunter2', '07700', 'bank', 'secret', 'hey jarvis', 'hello']) {
    assert.ok(!text.includes(leak), `leaked ${leak}`)
  }
  assert.equal(r.voiceMode, 'OFF')
  assert.equal(r.lastError, 'other')
  assert.equal(r.phaseTransition, '')
})
