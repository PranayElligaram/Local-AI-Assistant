/**
 * Wake -> command -> answer -> standby, end to end through the real voice loop
 * (browser recogniser engine, which is what runs when ElevenLabs refuses
 * transcription) and the real conversation phase machine. Only the recogniser,
 * the speakers and the bridge are fakes.
 *
 * The regression this pins: speech starting used to clear the listening
 * deadline, so a command that was then dropped left JARVIS in 'listening' for
 * good — and in that state "Hey Jarvis" was a command, not a wake.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBrowserModule } from './browser-modules.mjs'

const GREETING = 'Yes, sir?'
const GREETING_MS = 600
const ANSWER_MS = 1500
const THINK_MS = 800

async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const instances = []
  const micListeners = new Set()
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
  // The speakers. `tail` is what the echo filter believes is still in the air.
  const tts = { speaking: '', since: 0, ended: 0, last: '', tail: '' }
  globalThis.__wc = { tts, micListeners }

  const voiceMod = await loadBrowserModule('src/lib/voice.ts', {
    '../config': "export const BRIDGE_HTTP_URL = 'http://test.invalid'",
    './audio': 'export const getMicSoon = async () => ({}); export const onMicChange = fn => { globalThis.__wc.micListeners.add(fn); return () => globalThis.__wc.micListeners.delete(fn) }',
    './tts': [
      "export const speakingNow = () => `${globalThis.__wc.tts.speaking} ${globalThis.__wc.tts.tail}`.trim()",
      'export const speakingSince = () => globalThis.__wc.tts.since',
      'export const speakingEndedAt = () => globalThis.__wc.tts.ended',
      'export const lastSpoken = () => globalThis.__wc.tts.last',
    ].join('\n'),
    './capabilities': 'export const caps = () => ({ stt: false })',
    './vad': 'export async function startVad() { throw new Error("not used") }',
  })
  const convMod = await loadBrowserModule('src/lib/conversation.ts', {})

  let phase = 'dormant'
  const log = { asked: [], greetings: 0, sfx: [], abandoned: 0 }
  let speakTimer = null

  /** Callbacks, not promises: mocked timers tick synchronously and a promise
   *  continuation would not run until the test next yields. */
  const speak = (line, ms, done = () => {}) => {
    tts.speaking = line
    tts.since = Date.now()
    clearTimeout(speakTimer)
    speakTimer = setTimeout(() => { stopSpeaking(); done() }, ms)
  }
  const stopSpeaking = () => {
    if (!tts.speaking) return
    tts.last = tts.speaking
    tts.tail = tts.speaking
    tts.speaking = ''
    tts.since = 0
    tts.ended = Date.now()
    clearTimeout(speakTimer)
  }

  let turn = 0
  let conv
  conv = convMod.createConversation({
    getPhase: () => phase,
    // Stands in for the store subscription App wires up.
    setPhase: (p) => { const from = phase; phase = p; conv.phaseChanged(from, p) },
    greet: () => { log.greetings++; speak(GREETING, GREETING_MS) },
    respond: (said) => {
      const mine = ++turn
      conv.beginTurn()
      const from = phase
      phase = 'thinking'
      conv.phaseChanged(from, 'thinking')
      log.asked.push(said)
      setTimeout(() => {
        if (mine !== turn) return
        phase = 'speaking'
        conv.phaseChanged('thinking', 'speaking')
        speak(`The answer to ${said}.`, ANSWER_MS, () => {
          if (mine === turn) conv.standDown('answered')
        })
      }, THINK_MS)
    },
    silence: () => stopSpeaking(),
    abandonTurn: () => { turn++; log.abandoned++ },
    clearStage: () => { turn++ },
    sfx: (name) => log.sfx.push(name),
    setCaption: () => {},
    clearError: () => {},
  })

  const voice = await voiceMod.startVoice({
    mode: conv.mode,
    onWake: conv.onWake,
    onSpeechStart: conv.onSpeechStart,
    onPartial: conv.onPartial,
    onUtterance: conv.onUtterance,
    onError: () => {},
  })

  t.after(() => {
    voice.stop()
    delete globalThis.window
    delete globalThis.__wc
  })

  /** The recogniser that is live now. Speaking into an aborted one is a test bug. */
  const live = () => {
    const rec = instances.at(-1)
    assert.ok(rec && !rec.aborted, 'a live recogniser')
    return rec
  }
  const tick = (ms) => t.mock.timers.tick(ms)
  /** Advance until the app reaches `p`; fail if it never does. */
  const until = (p, max = 10_000) => {
    for (let waited = 0; phase !== p; waited += 50) {
      assert.ok(waited < max, `never reached ${p} (stuck in ${phase})`)
      tick(50)
    }
  }
  /** Let every timer that a normal exchange needs run out. */
  const settle = () => { for (let i = 0; i < 40; i++) tick(100) }

  /** "Hey Jarvis", then wait for the greeting and the re-arm. */
  const wake = () => {
    live().result('Hey Jarvis')
    settle()
    assert.equal(phase, 'listening', 'listening after the greeting')
    assert.equal(voiceMod.diag.voiceMode, 'COMMAND', 'command mic open after the greeting')
  }
  /** A command, then the whole answer. */
  const command = (text) => {
    live().result(text)
    // The recogniser's endpoint, the assembler's hold, think, speak, re-arm.
    for (let i = 0; i < 70; i++) tick(100)
  }
  const standby = (msg) => {
    assert.equal(phase, 'dormant', msg)
    tick(200) // one poll of the voice loop
    assert.equal(phase, 'dormant', msg)
    assert.equal(voiceMod.diag.voiceMode, 'STANDBY', msg)
    assert.equal(conv.hasDeadline(), false)
  }

  return {
    voiceMod, convMod, conv, instances, micListeners, log, tts,
    phase: () => phase, live, tick, until, settle, wake, command, standby, speak, stopSpeaking,
  }
}

test('ten consecutive wake -> command -> answer cycles each return to standby', async (t) => {
  const s = await setup(t)
  for (let i = 1; i <= 10; i++) {
    s.wake()
    s.command(`question number ${i}`)
    s.standby(`standby after cycle ${i}`)
  }
  assert.equal(s.log.asked.length, 10)
  assert.deepEqual(s.log.asked.at(-1), 'question number 10')
  assert.equal(s.log.greetings, 10)
  assert.equal(s.voiceMod.diag.wakes, 10)
})

test('wake works straight after a command completes', async (t) => {
  const s = await setup(t)
  s.wake()
  s.command('what time is it')
  s.standby()
  s.live().result('Hey Jarvis')
  assert.equal(s.phase(), 'listening')
  assert.equal(s.log.greetings, 2)
})

test('wake after the listening window times out in silence', async (t) => {
  const s = await setup(t)
  s.wake()
  s.tick(s.convMod.AWAIT_SPEECH_MS)
  s.standby('timed out to standby')
  assert.match(s.convMod.convDiag.lastTransition, /listening -> dormant \(timeout\)/)
  s.tick(600)
  s.wake()
  s.command('are you there')
  assert.deepEqual(s.log.asked, ['are you there'])
})

test('REGRESSION: speech that starts and is then dropped still returns to standby', async (t) => {
  const s = await setup(t)
  s.wake()
  // The greeting's reverb, heard in two pieces: one word is not evidence of
  // an echo, so it starts a turn; the whole phrase is, so it is discarded.
  s.tts.tail = GREETING
  s.live().result('sir', false)
  s.live().result('yes sir', true)
  s.tick(2000)
  assert.deepEqual(s.log.asked, [], 'the echo was not sent')
  assert.equal(s.phase(), 'listening')
  assert.equal(s.conv.hasDeadline(), true, 'the window still has a deadline')
  s.tick(s.convMod.AWAIT_SPEECH_MS)
  s.standby('back to standby, not stuck listening')
  s.tts.tail = ''
  s.tick(600)
  s.wake()
  assert.equal(s.log.greetings, 2, '"Hey Jarvis" is a wake again, with a greeting')
})

test('speech start never removes the listening deadline', async (t) => {
  const s = await setup(t)
  s.wake()
  s.conv.onSpeechStart()
  assert.equal(s.conv.hasDeadline(), true)
  s.tick(s.convMod.AWAIT_SPEECH_MS + 100)
  s.standby()
})

test('any route into listening gets a deadline, even one that skips listen()', async (t) => {
  const s = await setup(t)
  s.conv.phaseChanged('dormant', 'listening')
  assert.equal(s.conv.hasDeadline(), true)
})

test('"Hey Jarvis" said while already listening is answered, not swallowed', async (t) => {
  const s = await setup(t)
  s.wake()
  s.live().result('Hey Jarvis')
  for (let i = 0; i < 26; i++) s.tick(100) // endpoint + the assembler's hold
  assert.equal(s.log.greetings, 2, 'he answers to his name again')
  assert.deepEqual(s.log.asked, [])
  s.settle()
  s.command('open notepad')
  assert.deepEqual(s.log.asked, ['open notepad'])
  s.standby()
})

test('wake after TTS played from standby (the audio self-test)', async (t) => {
  const s = await setup(t)
  void s.speak('Audio test. If you can hear this, speech output is working, sir.', 2000)
  s.tick(200)
  assert.equal(s.voiceMod.diag.voiceMode, 'SPEAKING')
  s.tick(2000)
  s.tick(600)
  s.wake()
})

test('his own answer saying his name does not wake him', async (t) => {
  const s = await setup(t)
  s.wake()
  s.live().result('who are you')
  s.until('speaking')
  s.tick(200)
  // Answer playing: the mic is shut, nothing becomes a wake or a turn.
  assert.equal(s.voiceMod.diag.voiceMode, 'SPEAKING')
  assert.equal(s.instances.at(-1).aborted, true, 'no recogniser while he speaks')
  s.until('dormant')
  s.tick(600)
  s.standby()
  // The tail of "The answer to who are you." echoing after re-arm.
  s.live().result('the answer to who are you')
  assert.equal(s.log.greetings, 1)
  assert.equal(s.log.asked.length, 1)
})

test('the greeting echoing back is not taken as the command', async (t) => {
  const s = await setup(t)
  s.wake()
  s.tts.tail = GREETING
  s.live().result('yes sir')
  s.tick(1000)
  assert.deepEqual(s.log.asked, [])
  s.live().result('what is the weather')
  s.until('thinking')
  assert.deepEqual(s.log.asked, ['what is the weather'])
})

test('Escape while listening returns to standby and discards the half-said command', async (t) => {
  const s = await setup(t)
  s.wake()
  s.live().result('open the', false)
  s.conv.escape()
  s.standby('Escape stands down')
  assert.match(s.convMod.convDiag.lastTransition, /\(escape\)/)
  s.tick(7000) // past any hold the fragment might have had
  assert.deepEqual(s.log.asked, [])
  s.wake()
  s.command('what time is it')
  assert.deepEqual(s.log.asked, ['what time is it'], 'the fragment did not prefix the next command')
})

test('Escape during the greeting and during an answer both reach standby', async (t) => {
  const s = await setup(t)
  s.live().result('Hey Jarvis')
  s.tick(200)
  assert.equal(s.voiceMod.diag.voiceMode, 'WAKE')
  s.conv.escape()
  s.tick(600)
  s.standby('Escape over the greeting')

  s.tick(600)
  s.wake()
  s.live().result('tell me a long story')
  s.until('speaking')
  s.conv.escape()
  s.tick(600)
  s.standby('Escape over the answer')
  s.tick(ANSWER_MS)
  s.standby('the abandoned answer does not move the phase later')
  s.wake()
})

test('Space starts a turn from standby without the wake word', async (t) => {
  const s = await setup(t)
  assert.equal(s.conv.space(), 'listening')
  s.settle()
  assert.equal(s.voiceMod.diag.voiceMode, 'COMMAND')
  s.command('what is on my calendar')
  assert.deepEqual(s.log.asked, ['what is on my calendar'])
  s.standby()
})

test('Space over an answer interrupts him and listens', async (t) => {
  const s = await setup(t)
  s.wake()
  s.live().result('tell me a long story')
  s.until('speaking')
  s.conv.space()
  assert.equal(s.log.abandoned, 1)
  s.tick(800)
  assert.equal(s.voiceMod.diag.voiceMode, 'COMMAND')
  s.command('never mind, what time is it')
  assert.deepEqual(s.log.asked, ['tell me a long story', 'never mind, what time is it'])
  s.standby()
})

test('Space is ignored during boot and powers on when offline', async (t) => {
  const s = await setup(t)
  s.conv.standDown('other')
  const { createConversation } = s.convMod
  let phase = 'boot'
  const c = createConversation({
    getPhase: () => phase, setPhase: (p) => (phase = p), greet() {}, respond() {}, silence() {},
    abandonTurn() {}, clearStage() {}, sfx() {}, setCaption() {}, clearError() {},
  })
  assert.equal(c.space(), 'ignored')
  c.escape()
  assert.equal(phase, 'boot', 'Escape does not cut the boot sequence short')
  phase = 'offline'
  assert.equal(c.space(), 'power')
})

test('a command spoken across a pause is one turn, not two', async (t) => {
  const s = await setup(t)
  s.wake()
  s.live().result("what's the weather in")
  s.tick(1000)
  s.live().result('London')
  s.tick(1000)
  for (let i = 0; i < 50; i++) s.tick(100)
  assert.deepEqual(s.log.asked, ["what's the weather in London"])
  s.standby()
})

test('recogniser errors and restarts keep the wake word working', async (t) => {
  const s = await setup(t)
  for (const error of ['network', 'no-speech', 'aborted', 'audio-capture']) {
    const before = s.instances.length
    const rec = s.live()
    rec.onerror({ error })
    rec.onend()
    s.tick(100)
    assert.equal(s.instances.length, before + 1, `restarted after ${error}`)
    s.wake()
    s.command(`after ${error}`)
    s.standby()
  }
  assert.equal(s.log.asked.length, 4)
})

test('a recogniser that dies silently is replaced by the heartbeat', async (t) => {
  const s = await setup(t)
  const before = s.instances.length
  s.tick(21_000) // no events at all
  assert.ok(s.instances.length > before, 'heartbeat built a fresh recogniser')
  s.wake()
})

test('a microphone reconnect rebuilds the recogniser and the wake word still works', async (t) => {
  const s = await setup(t)
  const old = s.live()
  for (const fn of s.micListeners) fn({})
  assert.equal(old.aborted, true)
  s.wake()
  s.command('can you hear me')
  // Reconnect in the middle of a listening window too.
  s.wake()
  for (const fn of s.micListeners) fn({})
  s.command('and now')
  assert.deepEqual(s.log.asked, ['can you hear me', 'and now'])
  s.standby()
})

test('repeated activation without a reload: wakes, timeouts, Escapes and Spaces in any order', async (t) => {
  const s = await setup(t)
  for (let i = 0; i < 5; i++) {
    s.wake(); s.tick(s.convMod.AWAIT_SPEECH_MS); s.standby(`timeout ${i}`); s.tick(600)
    s.wake(); s.conv.escape(); s.standby(`escape ${i}`); s.tick(600)
    s.conv.space(); s.settle(); s.command(`space ${i}`); s.standby(`space ${i}`)
    s.wake(); s.command(`voice ${i}`); s.standby(`voice ${i}`)
  }
  assert.equal(s.log.asked.length, 10)
  assert.equal(s.voiceMod.diag.wakes, 15)
})

test('diagnostics name the wake phrase, a rejection, and the transitions', async (t) => {
  const s = await setup(t)
  s.live().result('turn the lights on')
  assert.equal(s.voiceMod.diag.wakeRejectCode, 'not-wake')
  assert.match(s.voiceMod.diag.lastWakeRejection, /not his name/)
  s.live().result('hey travis')
  assert.equal(s.voiceMod.diag.lastWakePhrase.toLowerCase(), 'hey travis')
  assert.equal(s.voiceMod.diag.wakeRejectCode, '')
  assert.ok(s.voiceMod.diag.lastWakeAt > 0)
  s.settle()
  assert.equal(s.voiceMod.diag.voiceMode, 'COMMAND')
  assert.ok(s.voiceMod.diag.commandSince > 0)
  assert.match(s.voiceMod.diag.lastTransition, /guard -> command/)
  assert.match(s.convMod.convDiag.lastTransition, /waking -> listening|dormant -> listening|-> listening/)
  assert.ok(s.convMod.convDiag.deadlineAt > Date.now())
})

test('a second "Hey Jarvis" inside the debounce is reported as debounced, not as a mishearing', async (t) => {
  const s = await setup(t)
  const { diag } = s.voiceMod
  // Two results from one utterance, both carrying his name, while in standby.
  s.live().result('hey Jarvis', false)
  s.tick(950)
  assert.equal(diag.wakes, 1)
  s.conv.escape() // straight back to standby, inside the debounce
  s.stopSpeaking()
  s.tick(300)
  s.live().result('Jarvis')
  assert.equal(diag.wakeRejectCode, 'debounced')
  assert.doesNotMatch(diag.lastWakeRejection, /not his name/)
})
