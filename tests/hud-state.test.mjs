/**
 * The HUD's state model: what the interface claims, derived from the app phase
 * and the voice loop's own state. The rule under test is the half-duplex one —
 * the screen must never say LISTENING while the microphone is closed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveDisplay, micFor, displayLabel, micLabel, humanTool } from '../src/ui/hudState.ts'
import { reactorFrame } from '../src/ui/layout.ts'

test('listening is only shown while the command mic is really open', () => {
  assert.equal(deriveDisplay('listening', 'COMMAND_LISTENING'), 'listening')
  // The greeting after the wake word plays while the phase is 'listening'.
  assert.equal(deriveDisplay('listening', 'SPEAKING'), 'wake')
  assert.equal(deriveDisplay('listening', 'REARMING'), 'wake')
  assert.equal(deriveDisplay('listening', 'TRANSCRIBING'), 'transcribing')
  for (const phase of ['thinking', 'tooling', 'speaking', 'waking', 'dormant', 'boot', 'offline']) {
    for (const voice of ['OFF', 'WAKE_LISTENING', 'COMMAND_LISTENING', 'THINKING', 'SPEAKING', 'REARMING']) {
      assert.notEqual(micFor(deriveDisplay(phase, voice)), 'live', `${phase}/${voice}`)
    }
  }
})

test('busy phases pause the mic and say so', () => {
  for (const [phase, display] of [['thinking', 'thinking'], ['tooling', 'working'], ['speaking', 'speaking']]) {
    assert.equal(deriveDisplay(phase, 'THINKING'), display)
    assert.equal(micFor(display), 'paused')
  }
  assert.equal(displayLabel.speaking, 'JARVIS speaking')
  assert.equal(micLabel.paused, 'Microphone paused')
})

test('dormant waits for the wake word, re-arms after speech, and shows the audio test', () => {
  assert.equal(deriveDisplay('dormant', 'WAKE_LISTENING'), 'dormant')
  assert.equal(micLabel[micFor('dormant')], 'Waiting for “Hey Jarvis”')
  assert.equal(deriveDisplay('dormant', 'REARMING'), 'rearming')
  assert.equal(deriveDisplay('dormant', 'SPEAKING'), 'speaking')
})

test('tool names read as words', () => {
  assert.equal(humanTool('open_application'), 'Open application')
  assert.equal(humanTool('get-time'), 'Get time')
})

test('the reactor frame fits the target desktops with room for the record', () => {
  for (const [w, h] of [[1920, 1080], [1600, 900], [1440, 900], [1366, 768]]) {
    const { y, d } = reactorFrame(w, h)
    const scaleTop = y - d * 0.66
    const readout = y + d * 0.7
    assert.ok(scaleTop > 70, `${w}x${h}: calibration scale clears the top bar`)
    // Readout (~70px) + at least three record lines before the key hints.
    assert.ok(h - readout > 190, `${w}x${h}: room below the reactor`)
  }
})
