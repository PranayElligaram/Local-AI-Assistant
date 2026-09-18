import type { Phase } from '../store'

/**
 * What the interface says JARVIS is doing.
 *
 * The app's phase describes the conversation; the voice loop's own state says
 * whether the microphone is actually open. They disagree on purpose in two
 * places — the greeting after the wake word plays while the phase is already
 * 'listening', and the short re-arm after he stops talking — and in both the
 * microphone is closed. Showing LISTENING there would be a lie, so the display
 * is derived from both.
 */
export type Display =
  | 'offline'
  | 'boot'
  | 'dormant'
  | 'wake'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'rearming'

/** Whether the command microphone is open, and why not. */
export type Mic = 'off' | 'wake' | 'live' | 'paused'

/** voice.ts diag.voiceState values. Plain strings: that module owns them. */
export type VoiceState =
  | 'OFF'
  | 'WAKE_LISTENING'
  | 'COMMAND_LISTENING'
  | 'TRANSCRIBING'
  | 'THINKING'
  | 'SPEAKING'
  | 'REARMING'
  | string

export function deriveDisplay(phase: Phase, voice: VoiceState): Display {
  switch (phase) {
    case 'offline':
      return 'offline'
    case 'boot':
      return 'boot'
    case 'dormant':
      // T (audio test) and a late greeting both speak from dormant.
      if (voice === 'SPEAKING') return 'speaking'
      if (voice === 'REARMING') return 'rearming'
      return 'dormant'
    case 'waking':
      return 'wake'
    case 'listening':
      // The greeting is still playing, or the mic is re-arming after it.
      if (voice === 'SPEAKING' || voice === 'REARMING') return 'wake'
      if (voice === 'TRANSCRIBING') return 'transcribing'
      return 'listening'
    case 'thinking':
      return 'thinking'
    case 'tooling':
      return 'working'
    case 'speaking':
      return 'speaking'
  }
}

export function micFor(display: Display): Mic {
  switch (display) {
    case 'offline':
    case 'boot':
      return 'off'
    case 'dormant':
      return 'wake'
    case 'listening':
      return 'live'
    default:
      return 'paused'
  }
}

/** The headline under the reactor. */
export const displayLabel: Record<Display, string> = {
  offline: 'Offline',
  boot: 'Coming online',
  dormant: 'Standing by',
  wake: 'Online',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  working: 'Working',
  speaking: 'JARVIS speaking',
  rearming: 'Re-arming',
}

/** The line under the headline: what the user can do, or why they can't. */
export const micLabel: Record<Mic, string> = {
  off: 'Microphone off',
  wake: 'Waiting for “Hey Jarvis”',
  live: 'Microphone live — speak now',
  paused: 'Microphone paused',
}

/** "open_application" -> "Open application". */
export function humanTool(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : s
}
