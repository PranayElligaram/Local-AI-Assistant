import type { Phase } from '../store'
import type { VoiceMode } from './voice'

/**
 * The conversation's phase machine: standby -> wake -> listening -> answer ->
 * standby, and every key and voice event that moves it.
 *
 * It used to live inside App's closures, where it could not be tested, and it
 * had a hole there: speech starting cleared the listening deadline and nothing
 * re-armed it. With the browser recogniser (the engine whenever ElevenLabs
 * refuses transcription) speech-start fires on the first word of every
 * command, so any utterance that was then dropped - an echo, a cough, a
 * fragment - left the phase at 'listening' for the life of the page. In that
 * state "Hey Jarvis" is a command rather than a wake, so he never answered to
 * his name again.
 *
 * The rule now: a listening phase always has a deadline. Speech extends it;
 * nothing clears it except leaving the phase. That is enforced on every phase
 * change, whoever made it, not by remembering to call the right helper.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. Also how long
 *  a listening window survives after the last sign of speech. */
export const AWAIT_SPEECH_MS = 14000

/** Phases in which he owns the floor. Half-duplex: nothing heard then is a turn. */
export const BUSY: ReadonlySet<Phase> = new Set<Phase>(['thinking', 'tooling', 'speaking'])

/** Phases in which the command microphone is meant to be open. */
const LISTENING: ReadonlySet<Phase> = new Set<Phase>(['waking', 'listening'])

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
export const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
export const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

/** What the voice loop should do with what it hears, derived from phase. */
export function voiceModeFor(phase: Phase): VoiceMode {
  switch (phase) {
    case 'offline':
    case 'boot':
      return 'deaf'
    case 'dormant':
      return 'wake'
    case 'waking':
    case 'listening':
      return 'command'
    default:
      return 'guard' // thinking, tooling, speaking
  }
}

/** Why the phase last moved — shown in Diagnostics. */
export type Cause =
  | 'boot'
  | 'wake'
  | 'wake-with-command'
  | 'space'
  | 'speech'
  | 'bare-name'
  | 'command'
  | 'timeout'
  | 'escape'
  | 'answered'
  | 'other'

/** Live state of the machine, published on `window.__conversation`. */
export const convDiag = {
  phase: 'offline' as Phase,
  /** "listening -> dormant (timeout)" */
  lastTransition: '',
  lastTransitionAt: 0,
  /** When the current listening window opened, 0 outside one. */
  listeningSince: 0,
  /** When the current listening window closes unless speech extends it. */
  deadlineAt: 0,
  /** Listening windows that ran out with nothing said. */
  timeouts: 0,
  /** Stand-downs by any route: timeout, Escape, end of an answer. */
  standDowns: 0,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__conversation = convDiag
}

export type ConversationEffects = {
  getPhase: () => Phase
  setPhase: (p: Phase) => void
  /** Answer to his name: queue the spoken greeting. */
  greet: () => void
  /** Run one turn. Must leave the phase with standDown('answered') when done. */
  respond: (said: string) => void
  /** Stop whatever he is saying. */
  silence: () => void
  /** Abandon the answer in flight: tell the bridge, drop tool/music state. */
  abandonTurn: () => void
  /** Everything else standing down resets: caption, tool readout, ducking. */
  clearStage: () => void
  sfx: (name: 'wake' | 'listen') => void
  setCaption: (text: string) => void
  clearError: () => void
  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
  now?: () => number
}

export type Conversation = ReturnType<typeof createConversation>

export function createConversation(fx: ConversationEffects) {
  const setTimer = fx.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = fx.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  const now = fx.now ?? (() => Date.now())

  let deadline: unknown = null
  /** The cause to attribute to the next phase change. */
  let cause: Cause = 'other'

  const clearDeadline = () => {
    if (deadline !== null) clearTimer(deadline)
    deadline = null
    convDiag.deadlineAt = 0
  }

  /** (Re)start the listening window. Never shortens one already running. */
  const arm = (ms: number) => {
    clearDeadline()
    convDiag.deadlineAt = now() + ms
    deadline = setTimer(() => {
      deadline = null
      convDiag.deadlineAt = 0
      // Only a listening window can time out. A phase that moved on without
      // telling us is not stood down by a timer it no longer owns.
      if (!LISTENING.has(fx.getPhase())) return
      convDiag.timeouts++
      standDown('timeout')
    }, ms)
  }

  const move = (p: Phase, why: Cause) => {
    cause = why
    fx.setPhase(p)
    // Callers that do not route through the store subscription (tests, or a
    // store that does not notify synchronously) still keep the invariant.
    if (convDiag.phase !== p) phaseChanged(convDiag.phase, p)
  }

  /**
   * Every phase change, however it was made — App also feeds the store's own
   * subscription in here, so a setPhase written anywhere keeps the rule.
   */
  const phaseChanged = (from: Phase, to: Phase) => {
    if (from === to) return
    convDiag.phase = to
    convDiag.lastTransition = `${from} -> ${to} (${cause})`
    convDiag.lastTransitionAt = now()
    cause = 'other'
    if (LISTENING.has(to)) {
      if (!LISTENING.has(from)) convDiag.listeningSince = now()
      // The invariant. Whatever opened the window, it has a deadline.
      if (deadline === null) arm(AWAIT_SPEECH_MS)
    } else {
      convDiag.listeningSince = 0
      clearDeadline()
    }
  }

  /** Back to the wake word. */
  const standDown = (why: Cause) => {
    clearDeadline()
    fx.silence()
    fx.clearStage()
    convDiag.standDowns++
    move('dormant', why)
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number, why: Cause) => {
    fx.setCaption('')
    move('listening', why)
    fx.sfx('listen')
    arm(window)
  }

  const wake = (trailing: string, why: Cause = 'wake') => {
    const phase = fx.getPhase()
    if (phase === 'offline' || phase === 'boot') return
    if (BUSY.has(phase)) return

    fx.clearError()
    fx.sfx('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      cause = 'wake-with-command'
      fx.respond(trailing)
      return
    }

    move('waking', why)
    // Answer to his name. The voice loop keeps the microphone shut while the
    // greeting plays (half-duplex) and re-opens it straight after.
    fx.greet()
    listen(AWAIT_SPEECH_MS, why)
  }

  /** Someone started talking, or pressed Space over him. */
  const speechStart = (why: Cause) => {
    const phase = fx.getPhase()
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    fx.silence()
    if (BUSY.has(phase)) fx.abandonTurn()
    move('listening', why)
    // Extend, never clear: if what they are saying is then dropped (an echo,
    // a fragment), the window still closes and the wake word works again.
    arm(AWAIT_SPEECH_MS)
  }

  return {
    /** For the voice loop: read fresh on every result. */
    mode: (): VoiceMode => voiceModeFor(fx.getPhase()),

    phaseChanged,

    /** Voice: his name was heard while dormant. */
    onWake: (trailing: string) => wake(trailing, 'wake'),

    /** Voice: speech began. Half-duplex, it never interrupts him. */
    onSpeechStart: () => {
      if (BUSY.has(fx.getPhase())) return
      speechStart('speech')
    },

    /** Voice: live transcript. Real words keep the window open. */
    onPartial: (text: string) => {
      fx.setCaption(text)
      if (LISTENING.has(fx.getPhase()) && /\w/.test(text)) arm(AWAIT_SPEECH_MS)
    },

    /** Voice: a complete command. */
    onUtterance: (text: string) => {
      const phase = fx.getPhase()
      if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
      // One command, one ask: anything arriving while a turn is in flight is
      // either his own voice or a stale recogniser result.
      if (BUSY.has(phase)) return

      // "Hey Jarvis" again while he is already listening: answer to it the
      // same way as from standby, so his name always gets a reply. It used to
      // re-open the window with nothing but a click.
      if (BARE_NAME.test(text)) {
        wake('', 'bare-name')
        return
      }
      // People keep using his name as a vocative once they're already talking
      // to him. Strip it rather than sending "jarvis" to the model.
      const said = text.replace(LEADING_NAME, '').trim()
      if (!said) {
        listen(AWAIT_SPEECH_MS, 'bare-name')
        return
      }
      cause = 'command'
      fx.respond(said)
    },

    /** A turn started (respond() calls this before asking). */
    beginTurn: () => {
      clearDeadline()
      if (cause === 'other') cause = 'command'
    },

    /** A turn ended, or was abandoned: back to the wake word. */
    standDown,

    /** Escape: stand everything down, whatever is happening. */
    escape: () => {
      const phase = fx.getPhase()
      if (phase === 'offline' || phase === 'boot') return
      standDown('escape')
    },

    /** Space: start a turn without the wake word. 'power' means boot first. */
    space: (): 'power' | 'ignored' | 'listening' => {
      const phase = fx.getPhase()
      if (phase === 'offline') return 'power'
      // The boot sequence owns the phase until it finishes.
      if (phase === 'boot') return 'ignored'
      if (BUSY.has(phase)) {
        speechStart('space')
        listen(AWAIT_SPEECH_MS, 'space')
      } else {
        wake('', 'space')
      }
      return 'listening'
    },

    /** For tests and Diagnostics. */
    hasDeadline: () => deadline !== null,
  }
}
