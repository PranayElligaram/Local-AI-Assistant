import { getMic } from './audio'
import { createWakeGesture, DOUBLE_CLAP_MIN_MS, type ClapResult } from './doubleClap'

/**
 * Clap to wake him up.
 *
 * The ignition button exists because browsers will not let a page make a sound
 * until someone has interacted with it. That is still true, so the button is
 * not going anywhere — but there is no reason it should be the only way in, and
 * clapping at a dark room to bring it up is a better opening than clicking a
 * button.
 *
 * A clap is not loud, it is SHARP. Distinguishing it from a door, a cough or a
 * dropped mug is entirely a question of shape: a clap goes from silence to peak
 * in a couple of milliseconds and is gone again inside a tenth of a second.
 * Almost nothing else in a room does both. So this looks for three things in
 * order — quiet before, a near-instant rise, and a fast collapse — and refuses
 * anything that fails one of them. Loudness alone is not evidence.
 */

/** How far above the running floor counts as a candidate transient. */
const PEAK_OVER_FLOOR = 7
/** ...and an absolute floor, so a silent room cannot make a whisper a clap. */
const MIN_PEAK = 0.055

/** The room has to have been this quiet just before the strike. */
const QUIET_BEFORE = 0.16
/** Frames of history kept — about a third of a second at 60fps. */
const HISTORY = 20
/** How many frames back "just before" means. */
const LOOKBACK = 5

/** Confirmed once the level has fallen this far below the peak... */
const DECAY_TO = 0.35
/** ...within this long. Speech and music simply do not collapse this fast. */
const DECAY_MS = 130
/** A candidate that has not decayed by now was something sustained. */
const GIVE_UP_MS = 260

/** Nothing counts for this long after he wakes, so one gesture is one event. */
const COOLDOWN_MS = 1200
/**
 * Deaf for this long after the microphone opens. Opening a capture - this one,
 * or another page's - can put a click on the line, and one did trigger a
 * "clap" 0.3 s after arming. A clap now starts the whole workspace, so the
 * start-up transient must not count. The floor still learns the room meanwhile;
 * no threshold changes.
 */
const SETTLE_MS = 2000

export type ClapListener = { stop: () => void }

/** One clap-shaped event: loudness, timing, and what the gesture made of it. */
export type ClapEvent = { afterArmMs: number; peak: number; floor: number; gapMs: number; result: ClapResult }

/** How many of those are kept. Enough for a 90-second listen in a real room. */
const RECENT_CLAPS = 40

export const diag = {
  listening: false,
  /** Individual clap-shaped events heard. Most of these mean nothing on their own. */
  rawClaps: 0,
  /** Completed two-clap wake gestures — the only thing that starts anything. */
  wakeGestures: 0,
  /** Is half a gesture in hand, waiting for the second clap. */
  pendingFirstClap: false,
  lastPeak: 0,
  rejected: '',
  /** The listener's AudioContext. Chrome may hold it 'suspended' until the user interacts; suspended hears nothing. */
  audioState: 'none' as AudioContextState | 'none',
  /** For the last raw clap: how long after arming, and the room floor it beat. */
  lastClapAfterArmMs: 0,
  floorAtClap: 0,
  /** Gap between the last two raw claps, whether or not they made a gesture. */
  lastClapGapMs: 0,
  /** How long after arming the last completed gesture landed. */
  lastWakeAfterArmMs: 0,
  /**
   * The last few raw claps, newest last. A room's own impulses and a pair of
   * hands are told apart by how loud they are and how they arrive, and that is
   * a question for measurement, not for guessing at a threshold.
   */
  recent: [] as ClapEvent[],
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__clap = diag
}

/**
 * Listen until told to stop. Resolves once the microphone is actually open, so
 * a caller can tell "not listening" from "listening and hearing nothing".
 *
 * Never throws for a refused microphone — clapping is an alternative to the
 * button, not a requirement, and an interface that reports an error about a
 * feature the user never asked for is worse than one that quietly does without.
 */
export async function listenForClap(onWake: () => void, onStateChange: () => void = () => {}): Promise<ClapListener> {
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch {
    diag.rejected = 'microphone unavailable'
    return { stop: () => {} }
  }

  const ctx = new AudioContext()
  diag.audioState = ctx.state
  ctx.onstatechange = () => {
    diag.audioState = ctx.state
    onStateChange()
  }
  void ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  // Small window: we are looking for an attack, and a long FFT smears exactly
  // the sharpness that identifies one.
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0
  source.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)

  const history: number[] = []
  let floor = 0.01
  let stopped = false
  let raf = 0
  let lastRawClap = 0
  let lastWake = 0
  // Two claps make the gesture; this remembers the first one. It lives with
  // the listener, so stopping the listener forgets it.
  const gesture = createWakeGesture(COOLDOWN_MS)
  diag.pendingFirstClap = false

  /** A transient under examination, waiting to prove it decays. */
  let candidate: { at: number; peak: number } | null = null

  const rms = () => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }

  const tick = () => {
    if (stopped) return
    raf = requestAnimationFrame(tick)

    const now = performance.now()
    const level = rms()
    history.push(level)
    if (history.length > HISTORY) history.shift()

    // The floor tracks the room, and never while a candidate is in flight —
    // otherwise the clap itself raises the bar it is being measured against.
    if (!candidate && level < floor * 3) {
      floor += (level - floor) * 0.05
      floor = Math.max(floor, 0.002)
    }

    if (now - armedAt < SETTLE_MS) return

    if (candidate) {
      if (level < candidate.peak * DECAY_TO && now - candidate.at < DECAY_MS) {
        // Quiet before, instant rise, immediate collapse. That is a clap — an
        // event, not yet a decision. Two of them in a row are the decision.
        const at = candidate.at
        candidate = null
        lastRawClap = now
        diag.rawClaps++
        diag.rejected = ''
        diag.lastClapAfterArmMs = Math.round(at - armedAt)
        diag.floorAtClap = floor
        const first = gesture.pendingAt
        const result = gesture.clap(at)
        if (first !== null) diag.lastClapGapMs = Math.round(at - first)
        diag.pendingFirstClap = gesture.pendingAt !== null
        diag.recent.push({
          afterArmMs: Math.round(at - armedAt),
          peak: Math.round(diag.lastPeak * 10000) / 10000,
          floor: Math.round(floor * 10000) / 10000,
          gapMs: first === null ? 0 : Math.round(at - first),
          result,
        })
        if (diag.recent.length > RECENT_CLAPS) diag.recent.shift()
        if (result === 'wake') {
          lastWake = now
          diag.wakeGestures++
          diag.lastWakeAfterArmMs = Math.round(at - armedAt)
          onWake()
        } else {
          // Nothing happens, but diagnostics should still show it was heard.
          onStateChange()
        }
      } else if (now - candidate.at > GIVE_UP_MS) {
        // Still going. A voice, a chair, music — something with a body to it.
        diag.rejected = 'too sustained to be a clap'
        candidate = null
      } else {
        candidate.peak = Math.max(candidate.peak, level)
      }
      return
    }

    // A first clap whose partner never arrived is not half a gesture any more.
    // Not while a transient is in flight: it is timed from the strike itself,
    // which may still be inside the window while it proves it decays.
    if (gesture.expire(now)) {
      diag.pendingFirstClap = false
      onStateChange()
    }

    if (now - lastWake < COOLDOWN_MS) return
    // The tail of a clap, or its echo, can look like a fresh strike a few
    // frames later. One impulse is one clap.
    if (now - lastRawClap < DOUBLE_CLAP_MIN_MS) return
    if (level < MIN_PEAK || level < floor * PEAK_OVER_FLOOR) return

    // Was the room actually quiet a moment ago? A rise out of noise is a swell,
    // not a strike, and this is the test that rejects most of speech.
    const before = history[history.length - 1 - LOOKBACK]
    if (before === undefined || before > level * QUIET_BEFORE) {
      diag.rejected = 'no silence before it'
      return
    }

    diag.lastPeak = level
    candidate = { at: now, peak: level }
  }

  const armedAt = performance.now()
  tick()
  diag.listening = true

  return {
    stop: () => {
      stopped = true
      diag.listening = false
      gesture.reset()
      diag.pendingFirstClap = false
      cancelAnimationFrame(raf)
      try {
        source.disconnect()
        // The shared microphone stream is NOT stopped here. It belongs to
        // audio.ts and the voice loop takes it over the moment JARVIS boots;
        // stopping it would take the assistant's hearing with it.
        void ctx.close()
      } catch {
        /* already gone */
      }
    },
  }
}
