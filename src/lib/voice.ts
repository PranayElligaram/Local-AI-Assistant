import { BRIDGE_HTTP_URL } from '../config'
import { getMicSoon, onMicChange } from './audio'
import { lastSpoken, speakingEndedAt, speakingNow, speakingSince } from './tts'
import { startVad, type Vad, type VadHandlers } from './vad'
import { caps } from './capabilities'
import {
  MAX_HOLD_MS,
  OVERRIDE,
  SELF_GUARD_MS,
  WAKE,
  WAKE_DEBOUNCE,
  afterWake,
  holdFor,
  isEcho,
} from './wake'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name, from a partial — waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */


type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}


// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which input engine is running: 'elevenlabs' (VAD+Scribe) or 'browser'. */
  engine: 'browser',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
  /** WAKE_LISTENING | COMMAND_LISTENING | TRANSCRIBING | THINKING | SPEAKING | REARMING | OFF */
  voiceState: 'OFF',
  wakeListening: false,
  commandRecognitionActive: false,
  ttsActive: false,
  /** Moves every time the microphone opens or closes; see makeCycle. */
  recognitionGeneration: 0,
  lastFinalTranscript: '',
  lastUtteranceSentAt: 0,
  lastWakeAt: 0,
  /** Wake word heard -> microphone open for the question (the HUD's listening
   *  state), for the last wake that was followed by a question. */
  wakeToListenMs: 0,
  /** Wake word heard -> recogniser actually capturing again. Browser engine
   *  only: rec.start() takes a moment after the HUD already says listening. */
  wakeToMicMs: 0,
  /** OFF | STANDBY (waiting for his name) | WAKE (name heard, greeting or
   *  re-arm, mic shut) | COMMAND (mic open for the question) | THINKING | SPEAKING */
  voiceMode: 'OFF',
  /** The wake phrase as the recogniser heard it ("hey travis"), nothing more. */
  lastWakePhrase: '',
  /** Why the last thing heard while waiting for his name did not wake him. */
  lastWakeRejection: '',
  lastWakeRejectionAt: 0,
  /** Machine-readable form of `dropped`, safe to send to the bridge. */
  dropCode: '' as DropCode | '',
  wakeRejectCode: '' as DropCode | '',
  /** "wake -> guard": the voice loop's own last mode change. */
  lastTransition: '',
  lastTransitionAt: 0,
  /** When the command microphone last opened; 0 while it is shut. */
  commandSince: 0,
}

export type DropCode =
  | 'not-wake'
  | 'debounced'
  | 'echo'
  | 'stale'
  | 'closed'
  | 'empty'
  | 'stt-failed'
  | 'unreachable'

/** Set on a bare wake (no command in the same breath) until it is measured. */
let wakePending = 0
let micPending = 0

/** A wake that opens a listening window: time how long until it really listens. */
function noteWake(at: number, text: string, trailing: string) {
  wakePending = trailing ? 0 : at
  micPending = wakePending
  diag.lastWakePhrase = (WAKE.exec(text)?.[0] ?? '').trim().slice(0, 40)
  diag.lastWakeRejection = ''
  diag.wakeRejectCode = ''
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string, code: DropCode) {
  diag.dropped = why
  diag.dropCode = code
  if (diag.mode === 'wake') {
    diag.lastWakeRejection = why
    diag.wakeRejectCode = code
    diag.lastWakeRejectionAt = Date.now()
  }
}

/** Something heard while waiting for his name, and what to make of it. */
function wakeVerdict(text: string, lastWake: number): 'wake' | DropCode {
  if (!WAKE.test(text)) return 'not-wake'
  // His name, but inside the window of the wake that already fired: one
  // utterance yields several results that all contain it.
  if (Date.now() - lastWake <= WAKE_DEBOUNCE) return 'debounced'
  return 'wake'
}

const rejectWake = (text: string, code: DropCode) =>
  drop(
    code === 'debounced'
      ? `heard his name again within ${WAKE_DEBOUNCE} ms of the last wake`
      : `heard "${text.slice(-40)}" — not his name`,
    code,
  )

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

// ---------------------------------------------------------------------------
// Half-duplex
// ---------------------------------------------------------------------------

/**
 * Voice barge-in: the open-microphone design, where talking over him cuts him
 * off. It is off because it made him hear himself - his own ElevenLabs voice
 * came back through the speakers, was taken for an interruption or a command,
 * and he answered it. Until there is real acoustic echo cancellation the loop
 * is half-duplex: while he thinks or talks, nothing the microphone hears can
 * become a wake, a barge-in or a turn. Escape and Space still interrupt.
 */
export const VOICE_BARGE_IN = false

/** After his last word, how long the microphone stays shut before re-arming.
 *  Covers the gap between two sentences and the room's reverb. */
export const REARM_MS = 500
/**
 * ...and after a line of a few words - in practice the wake greeting, which is
 * the one thing standing between "Hey Jarvis" and him hearing the question.
 * There is no next sentence to wait for, and a short line leaves a short echo
 * (the text echo filter still has its tail). The browser recogniser then takes
 * a further ~0.1-0.3 s to start capturing.
 */
export const SHORT_REARM_MS = 250
const SHORT_LINE_WORDS = 4

/** How long to stay shut after `spoken` finished playing. */
export function rearmFor(spoken: string): number {
  const words = spoken.trim().split(/\s+/).filter(Boolean).length
  return words > 0 && words <= SHORT_LINE_WORDS ? SHORT_REARM_MS : REARM_MS
}

/** Modes in which something heard may become a wake or a turn. */
const accepting = (m: VoiceMode | '') => m === 'wake' || m === 'command'

/**
 * The mode as the voice loop must treat it. The app's mode says what the
 * conversation expects; this also closes the microphone for as long as sound
 * is coming out of the speakers, whatever phase the app thinks it is in - the
 * greeting after the wake word plays while the app is already 'listening'.
 */
export function effectiveMode(h: Pick<VoiceHandlers, 'mode'>): VoiceMode {
  const m = h.mode()
  if (VOICE_BARGE_IN || m === 'deaf') return m
  const ended = speakingEndedAt()
  if (speakingSince() || (ended && Date.now() - ended < rearmFor(lastSpoken()))) {
    diag.voiceState = speakingSince() ? 'SPEAKING' : 'REARMING'
    return 'guard'
  }
  return m
}

/**
 * The recognition generation.
 *
 * It moves every time the microphone closes (a turn went to the bridge, he
 * started talking) and every time it re-opens. Every capture, pending
 * transcription and endpoint timer carries the generation it began in, and a
 * result arriving under a different one belongs to a cycle that is already
 * over - most often his own voice, captured while he spoke - so it is dropped
 * rather than becoming a second turn.
 */
function makeCycle(
  h: Pick<VoiceHandlers, 'mode'>,
  onChange: (open: boolean) => void,
  /** Any mode change, including wake <-> command, which leaves the mic open. */
  onMode?: (from: VoiceMode, to: VoiceMode) => void,
) {
  let last: VoiceMode | '' = ''
  return {
    sync(): VoiceMode {
      const m = effectiveMode(h)
      const changed = last !== '' && accepting(m) !== accepting(last)
      const from = last
      last = m
      diag.voiceMode = voiceModeLabel(h.mode(), m)
      if (from !== m) {
        diag.lastTransition = `${from || 'start'} -> ${m}`
        diag.lastTransitionAt = Date.now()
        diag.commandSince = m === 'command' ? Date.now() : 0
        if (from) onMode?.(from, m)
      }
      diag.mode = m
      diag.wakeListening = m === 'wake'
      diag.commandRecognitionActive = m === 'command'
      diag.ttsActive = Boolean(speakingSince())
      if (m === 'wake') diag.voiceState = 'WAKE_LISTENING'
      else if (m === 'command') {
        diag.voiceState = 'COMMAND_LISTENING'
        // Counted once the greeting that answered the wake has finished: until
        // then 'command' is only the instant before he starts speaking it.
        if (wakePending && speakingEndedAt() >= wakePending) {
          const ms = Date.now() - wakePending
          wakePending = 0
          // Only a listening window that this wake opened; ten seconds on, it is
          // some other turn's.
          if (ms < 10_000) {
            diag.wakeToListenMs = ms
            if (diag.engine === 'elevenlabs') diag.wakeToMicMs = ms
          } else micPending = 0
        }
      }
      else if (m === 'deaf') diag.voiceState = 'OFF'
      else if (!diag.ttsActive && diag.voiceState !== 'REARMING') diag.voiceState = 'THINKING'
      if (changed && !VOICE_BARGE_IN) {
        diag.recognitionGeneration++
        onChange(accepting(m))
      }
      return m
    },
    open: () => accepting(last),
    generation: () => diag.recognitionGeneration,
  }
}

/** The one-word answer to "what is the voice loop doing", from the app's mode
 *  and the mode the loop is actually applying. */
export function voiceModeLabel(app: VoiceMode, effective: VoiceMode): string {
  if (effective === 'deaf') return 'OFF'
  if (effective === 'wake') return 'STANDBY'
  if (effective === 'command') return 'COMMAND'
  // Shut, but the app is waiting for a question: the greeting, or the re-arm.
  if (app === 'command') return 'WAKE'
  return speakingSince() || app === 'wake' ? 'SPEAKING' : 'THINKING'
}

/** A finished command, on its way to the app and so to the bridge. */
function noteFinal(text: string) {
  diag.lastFinalTranscript = text.slice(0, 200)
}

/**
 * Pick the voice engine and start it.
 *
 * Two engines, chosen by what the bridge reported at boot (see capabilities.ts):
 *   - ElevenLabs available -> local voice-activity detection for instant
 *     barge-in, and ElevenLabs Scribe for the words. The reliable path.
 *   - nothing configured -> the browser's own SpeechRecognition, so a student
 *     with no keys still has a working assistant. Less robust, but free and
 *     zero-setup, and guarded by a heartbeat so its silent death is recovered.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers): Promise<Voice> {
  try {
    // Bounded, because an unanswered permission prompt never settles either
    // way: without the clock this await is where the interface stops for good.
    await getMicSoon()
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    diag.lastError = name === 'TimeoutError' ? 'mic-permission-pending' : 'mic'
    if (name === 'NotAllowedError') {
      h.onError('Microphone access denied - voice input is unavailable.')
      diag.engine = 'browser'
      return startBrowserVoice(h, true)
    }
    if (name === 'TimeoutError') {
      // The prompt is still sitting there unanswered. Say so, and carry on:
      // the browser recogniser raises its own request, and audio.ts picks the
      // device up the moment permission is granted.
      h.onError('Waiting for microphone permission - allow it to speak to me.')
      diag.engine = 'browser'
      return startBrowserVoice(h)
    }
    h.onError('No microphone available.')
    diag.engine = 'browser'
    return startBrowserVoice(h, true)
  }
  if (!caps().stt) {
    diag.engine = 'browser'
    return startBrowserVoice(h)
  }

  /**
   * The premium path, with a way back.
   *
   * Choosing the engine once at boot assumes the capability probe was right,
   * and it is not always: a key can exist, pass /health, and still be refused
   * for transcription — measured on this machine, a key carrying
   * text_to_speech but not speech_to_text. The symptom is the worst one this
   * project has: a live microphone, a running detector, and an assistant that
   * never hears a word, with no error anywhere the user would look.
   *
   * So the fallback is live rather than only at boot. A hard refusal,
   * and the browser's own recogniser takes over — which needs no key, and is
   * the engine a fresh clone uses anyway.
   */
  diag.engine = 'elevenlabs'
  let current: Voice | null = null
  let stopped = false
  let fallen = false

  const fallBack = () => {
    if (fallen || stopped) return
    fallen = true
    diag.engine = 'browser'
    diag.lastError = 'transcription refused — using the browser recogniser'
    console.warn(
      '[jarvis] the speech service refused this key; falling back to the browser recogniser.',
    )
    current?.stop()
    current = startBrowserVoice(h)
  }

  current = await startElevenVoice(h, fallBack)
  return {
    stop: () => {
      stopped = true
      current?.stop()
    },
    live: () => (stopped ? false : (current?.live() ?? false)),
  }
}

/** VAD + ElevenLabs Scribe. */
async function startElevenVoice(
  h: VoiceHandlers,
  onUnavailable: () => void,
): Promise<Voice> {
  let lastWake = 0
  let stopped = false
  const abort = new AbortController()
  let vad: Vad | null = null
  /** Generation the segment being captured right now started in. */
  let segmentGen: number | null = null

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: { blob: Blob; gen: number }[] = []
  let draining = false

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      if (!VOICE_BARGE_IN && cycle.sync() !== 'command') {
        drop('microphone closed before the command was sent', 'closed')
        return
      }
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      noteFinal(text)
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  // Closing or re-opening the microphone throws away everything in flight:
  // queued segments and held text belong to the cycle that just ended.
  const cycle = makeCycle(h, () => {
    pendingAudio.length = 0
    segmentGen = null
    assemble.cancel()
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async ({ blob, gen }: { blob: Blob; gen: number }) => {
    if (stopped || cycle.sync() === 'deaf') return
    if (!VOICE_BARGE_IN && gen !== cycle.generation()) {
      drop('stale segment from an earlier cycle', 'stale')
      return
    }
    diag.voiceState = 'TRANSCRIBING'
    const t0 = performance.now()
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]),
      })
      if (stopped) return
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        diag.restarts++
        diag.lastError = `stt ${res.status}`
        drop(`transcription failed (${res.status})`, 'stt-failed')
        // 401/403 is the key being refused, and it will be refused again for
        // every segment after this one. 503 is the bridge saying it has no key
        // at all. None of those get better by waiting.
        if (res.status === 401 || res.status === 403 || res.status === 503) {
          onUnavailable()
        }
        return
      }
      const { text } = (await res.json()) as { text?: string }
      if (stopped) return
      const said = (text ?? '').trim()
      diag.lastError = ''
      // Re-read now: the transcript belongs to the mode the user is in when it
      // lands. Half-duplex, one that lands in a different cycle, or while he
      // is thinking or talking, is never a turn.
      const mode = cycle.sync()
      if (!VOICE_BARGE_IN && (gen !== cycle.generation() || !accepting(mode))) {
        drop('stale transcription - the cycle moved on', 'stale')
        return
      }

      if (!said) {
        drop('nothing intelligible in the segment', 'empty')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest.
      if (isEcho(said, speakingNow())) {
        drop('echo of his own voice', 'echo')
        return
      }

      diag.heard = said
      diag.heardAt = Date.now()

      if (mode === 'wake') {
        const verdict = wakeVerdict(said, lastWake)
        if (verdict === 'wake') {
          lastWake = Date.now()
          diag.lastWakeAt = lastWake
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          noteWake(lastWake, said, afterWake(said))
          h.onWake(afterWake(said))
        } else {
          rejectWake(said, verdict)
        }
        return
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      assemble.feed(said, vad?.meter().speaking ?? false)
    } catch (err) {
      if (stopped) return
      diag.restarts++
      diag.lastError = String(err)
      drop('could not reach the speech service', 'unreachable')
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (!stopped && pendingAudio.length) {
        await transcribe(pendingAudio.shift()!)
      }
    } finally {
      draining = false
    }
  }

  const vadHandlers: VadHandlers = {
    onStart: () => {
      const mode = cycle.sync()
      diag.sessions++
      segmentGen = cycle.generation()
      if (mode === 'deaf') return
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') assemble.cancel()
      // The barge-in. In guard mode the user has started talking over him, and
      // because the guard threshold is high this is a real interruption rather
      // than leaked playback — so cut him off now, do not wait for the words.
      if (mode === 'guard' && VOICE_BARGE_IN) {
        const since = speakingSince()
        if (since && Date.now() - since < SELF_GUARD_MS) {
          diag.selfGuarded++
          return
        }
        h.onSpeechStart()
      }
    },
    onEnd: (blob) => {
      if (stopped) return
      const mode = cycle.sync()
      const gen = segmentGen ?? cycle.generation()
      segmentGen = null
      if (!VOICE_BARGE_IN && (gen !== cycle.generation() || !accepting(mode))) {
        drop('captured while the microphone was closed', 'closed')
        return
      }
      pendingAudio.push({ blob, gen })
      void drain()
    },
    onLevel: (v) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = cycle.sync()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) return
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message: string) => {
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  }

  vad = await startVad(vadHandlers)
  diag.running = vad.live()

  /**
   * The detector is bound to one MediaStream, so a device that goes away and
   * comes back leaves it analysing a dead track — silently, for ever. audio.ts
   * reopens the device; this rebuilds the detector on top of the new stream.
   * Without it, "unplug the headset" is a permanent deafness that only a page
   * reload fixes.
   */
  const stopWatchingMic = onMicChange(() => {
    void (async () => {
      try {
        vad?.stop()
        const next = await startVad(vadHandlers)
        if (stopped) { next.stop(); return }
        vad = next
        diag.running = vad.live()
        diag.restarts++
        diag.lastError = ''
      } catch (err) {
        diag.running = false
        diag.lastError = `mic restart: ${String(err)}`
      }
    })()
  })

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  const guardPoll = setInterval(() => {
    const mode = cycle.sync()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
  }, 200)

  return {
    stop: () => {
      stopped = true
      abort.abort()
      pendingAudio.length = 0
      clearInterval(guardPoll)
      stopWatchingMic()
      assemble.cancel()
      vad?.stop()
      diag.running = false
    },
    live: () => vad?.live() ?? false,
  }
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
function startBrowserVoice(h: VoiceHandlers, blocked = false): Voice {
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return { stop: () => {}, live: () => false }
  }

  let stopped = false
  let running = false
  let starting = false
  let rec: any = null
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      if (!VOICE_BARGE_IN && cycle.sync() !== 'command') {
        drop('microphone closed before the command was sent', 'closed')
        return
      }
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      noteFinal(text)
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  /**
   * Half-duplex: the recogniser is torn down the moment the microphone closes
   * and a fresh one built when it re-opens. Aborting is the only reliable way
   * to discard what Chrome has already buffered — his own voice, heard while
   * he spoke, would otherwise arrive as a final result a second later.
   */
  const cycle = makeCycle(
    h,
    (open) => {
      reset()
      assemble.cancel()
      retire()
      if (open) spin()
    },
    (from, to) => {
      // Standby <-> command keeps the same recogniser running, but not what it
      // had half-heard: a fragment of a command abandoned by Escape or the
      // timeout must not open the next conversation, and wake-mode noise must
      // not become the start of a command.
      if (accepting(from) && accepting(to)) {
        reset()
        assemble.cancel()
      }
    },
  )

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
  }

  const emit = () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = cycle.sync()
    reset()
    if (!VOICE_BARGE_IN && !accepting(mode)) return
    if (!text || mode === 'deaf') return
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice', 'echo')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    if (mode === 'wake') {
      assemble.cancel()
      const verdict = wakeVerdict(text, lastWake)
      if (verdict === 'wake') {
        lastWake = Date.now()
        diag.lastWakeAt = lastWake
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        noteWake(lastWake, text, afterWake(text))
        h.onWake(afterWake(text))
      } else {
        rejectWake(text, verdict)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    const gen = cycle.generation()
    silenceTimer = setTimeout(() => {
      silenceTimer = null
      if (gen === cycle.generation()) emit()
    }, 900)
  }

  const onResult = (e: any, mode: VoiceMode) => {
    touch()
    if (mode === 'deaf' || (!VOICE_BARGE_IN && mode === 'guard')) {
      interim = ''
      return
    }
    let fresh = ''
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) fresh += chunk
      else interim += chunk
    }
    const heard = `${settled} ${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!heard) return
    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      interim = ''
      return
    }

    if (mode === 'wake') {
      settled = `${settled} ${fresh}`.replace(/\s+/g, ' ').trim()
      const verdict = wakeVerdict(heard, lastWake)
      if (verdict !== 'wake') {
        // Report finished phrases only; partials are still being decided.
        if (fresh.trim()) {
          diag.heard = fresh.trim()
          diag.heardAt = Date.now()
          rejectWake(fresh.trim(), verdict)
        }
        // A name inside the debounce belongs to the wake that already fired.
        // Kept, it would combine with the next stray word into a false wake.
        if (verdict === 'debounced' || settled.length > 400) settled = ''
        return
      }
      // Still mid-phrase: "hey jarvis what" is not a command yet. Waking on
      // the partial sent that fragment to the bridge as the question. Let
      // the recogniser finish (or the quiet gap endpoint it) and wake from
      // the whole phrase in emit().
      if (interim.trim()) {
        bumpSilence()
        return
      }
      lastWake = Date.now()
      diag.lastWakeAt = lastWake
      diag.wakes++
      diag.dropped = ''
      diag.accepted++
      const trailing = afterWake(heard)
      reset()
      noteWake(lastWake, heard, trailing)
      h.onWake(trailing)
      return
    }

    settled = `${settled} ${fresh}`.replace(/\s+/g, ' ').trim()
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      const words = full.split(/\s+/).filter(Boolean).length
      if (mode === 'guard') {
        // An override word cuts through everything below it — "stop" has to
        // work on the first syllable or it is not a stop button.
        if (!OVERRIDE.test(full)) {
          // His own first syllable, same as the premium path. This engine has
          // no energy gate, so without the clock the only defence is the word
          // count below, and a single clear word is exactly what leaks first.
          const since = speakingSince()
          if (since && Date.now() - since < SELF_GUARD_MS) {
            diag.selfGuarded++
            return
          }
          // Two words before this engine believes an interruption. The energy
          // path can be instant because it triggers on loudness the canceller
          // has already had a pass at; here the evidence is a transcript of
          // audio that includes his own playback, and one word of that is not
          // evidence of anything.
          if (words < 2) return
        }
      }
      started = true
      if (mode === 'guard') barged = true
      h.onSpeechStart()
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    bumpSilence()
  }

  const spin = () => {
    if (stopped || blocked || running || starting) return
    if (!VOICE_BARGE_IN && !cycle.open()) return
    starting = true
    rec = new Ctor()
    const instance = rec
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-GB'
    rec.onstart = () => {
      if (stopped || rec !== instance) return
      starting = false
      running = true
      diag.lastError = ''
      diag.running = true
      diag.sessions++
      // The first recogniser started for the question after a wake.
      if (micPending && speakingEndedAt() >= micPending && cycle.open() && h.mode() === 'command') {
        const ms = Date.now() - micPending
        micPending = 0
        if (ms < 10_000) diag.wakeToMicMs = ms
      }
      touch()
    }
    rec.onresult = (e: any) => {
      if (stopped || rec !== instance) return
      const mode = cycle.sync()
      // sync() may just have retired this very recogniser.
      if (rec === instance) onResult(e, mode)
    }
    rec.onerror = (ev: any) => {
      if (stopped || rec !== instance) return
      diag.lastError = String(ev.error ?? '')
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        blocked = true
        starting = false
        running = false
        diag.running = false
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    rec.onend = () => {
      if (stopped || rec !== instance) return
      starting = false
      running = false
      diag.running = false
      touch()
      rec = null
      if (!stopped) setTimeout(spin, 80)
    }
    try {
      rec.start()
    } catch {
      starting = false
      running = false
      setTimeout(spin, 250)
    }
  }

  const retire = () => {
    const old = rec
    rec = null
    running = false
    starting = false
    diag.running = false
    try { old?.abort() } catch { /* already gone */ }
  }
  const stopWatchingMic = onMicChange(() => {
    if (stopped) return
    blocked = false
    retire()
    touch()
    spin()
  })
  cycle.sync()
  spin()

  // The app's phase changes without telling the voice loop, so the loop looks.
  const phasePoll = setInterval(() => {
    if (!stopped) cycle.sync()
  }, 150)

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped || blocked) return
    if (!VOICE_BARGE_IN && !cycle.open()) {
      touch()
      return
    }
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000) return
    diag.restarts++
    retire()
    touch()
    spin()
  }, 5000)

  return {
    stop: () => {
      stopped = true
      clearInterval(health)
      clearInterval(phasePoll)
      stopWatchingMic()
      retire()
      clearSilence()
      assemble.cancel()
      diag.running = false
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
  }
}
