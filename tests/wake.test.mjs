/**
 * The wake phrase and the endpointing rules.
 *
 * IMPORTANT, and stated here because it is easy to forget when these all pass:
 * this file tests the JUDGEMENTS, given text. It says nothing about whether a
 * microphone in a real room produces that text. Wake-word reliability with a
 * human voice is a physical measurement and cannot be established from here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WAKE, afterWake, holdFor, isEcho } from '../src/lib/wake.ts'

const wakes = (text) => WAKE.test(text)

test('"Hey Jarvis" and its ordinary spoken variants wake him', () => {
  for (const said of [
    'hey jarvis',
    'Hey Jarvis',
    'hey jarvis are you there',
    'jarvis',
    'ok jarvis',
    'okay jarvis what is the time',
    'hi jarvis',
    'yo jarvis',
  ]) {
    assert.equal(wakes(said), true, `"${said}" should wake him`)
  }
})

test('the mishearings a dictation model actually returns still wake him', () => {
  // "Jarvis" is not a high-frequency word; Chrome returns these for a
  // perfectly clear utterance, and dropping them is what made the wake word
  // "just not work" with nothing on screen to explain why.
  for (const said of ['hey travis', 'hey jervis', 'hey jarvys', 'jarviss', 'hey jarv']) {
    assert.equal(wakes(said), true, `"${said}" should wake him`)
  }
})

test('ordinary speech does not wake him', () => {
  for (const said of [
    'what is the weather like today',
    'can you pass me that',
    'I was talking to someone else entirely',
    '',
  ]) {
    assert.equal(wakes(said), false, `"${said}" must not wake him`)
  }
})

test('a possessive is not an address', () => {
  assert.equal(wakes("jarvis's job"), false)
})

test('the command after the name is carried into the same turn', () => {
  assert.equal(afterWake('hey jarvis what is the time'), 'what is the time')
  assert.equal(afterWake('jarvis, open the news'), 'open the news')
  assert.equal(afterWake('hey jarvis'), '')
  assert.equal(afterWake('nothing here'), '')
})

test('a finished sentence is sent immediately', () => {
  // The latency of an ordinary question must not change: a complete thought
  // waits for nothing.
  assert.equal(holdFor('what is the weather in London.'), 0)
  assert.equal(holdFor('are you there?'), 0)
})

test('a sentence left hanging is held for more', () => {
  // "what's the weather in — " *pause* " — London" is one question, not two.
  assert.ok(holdFor('what is the weather in') > 0)
  assert.ok(holdFor('tell me about the') > 0)
  assert.ok(holdFor('open the news and') > 0)
  assert.ok(holdFor('show me,') > 0)
})

test('a short command is not mistaken for an unfinished thought', () => {
  // One or two words are usually the start of something rather than the whole
  // of it — except the short commands that genuinely are complete, which are
  // held only for the brief settle window instead of the long one.
  assert.ok(holdFor('stop') < holdFor('the news'))
  assert.ok(holdFor('cancel') < holdFor('the news'))
  assert.ok(holdFor('stop') <= 250)
})

test('his own voice coming back through the speakers is discarded', () => {
  const spoken = 'The render is complete, sir. Forty-two frames at the requested resolution.'
  assert.equal(isEcho('the render is complete sir forty two frames', spoken), true)
})

test('a real follow-up question is not mistaken for an echo', () => {
  // Every word of this appears in the answer it follows; a naive bag-of-words
  // match would swallow the user's actual question.
  const spoken = 'There are three items on the list, sir.'
  assert.equal(isEcho('what about the second one', spoken), false)
})

test('an interruption always cuts through, whatever he is saying', () => {
  const spoken = 'I am afraid the connection stopped responding, sir.'
  assert.equal(isEcho('stop', spoken), false)
  assert.equal(isEcho('jarvis', spoken), false)
  assert.equal(isEcho('cancel', spoken), false)
})

test('nothing is an echo when he is not speaking', () => {
  assert.equal(isEcho('open the news', ''), false)
})
