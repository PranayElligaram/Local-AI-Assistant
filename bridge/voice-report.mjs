/**
 * The page reports its voice loop to the bridge once a second. Only states,
 * codes and times are kept: nothing the microphone heard crosses this line.
 */

const VOICE_STATES = new Set(['OFF', 'WAKE_LISTENING', 'COMMAND_LISTENING', 'TRANSCRIBING', 'THINKING', 'SPEAKING', 'REARMING'])
const VOICE_MODES = new Set(['OFF', 'STANDBY', 'WAKE', 'COMMAND', 'THINKING', 'SPEAKING'])
const DROP_CODES = new Set(['not-wake', 'debounced', 'echo', 'stale', 'closed', 'empty', 'stt-failed', 'unreachable'])
/** "listening -> dormant (timeout)": phase names and a cause, nothing else. */
const PHASE_TRANSITION = /^[a-z]+ -> [a-z]+ \([a-z-]+\)$/
/** Recogniser error names ("network", "no-speech", "stt 401"), never free text. */
const ERROR_CODE = /^[a-z0-9 -]{1,32}$/

/** Whitelist the page's voice report: no transcript text crosses this line. */
export function sanitizeVoiceReport(msg) {
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  return {
    engine: msg?.engine === 'elevenlabs' ? 'elevenlabs' : 'browser',
    voiceState: VOICE_STATES.has(msg?.voiceState) ? msg.voiceState : 'OFF',
    voiceMode: VOICE_MODES.has(msg?.voiceMode) ? msg.voiceMode : 'OFF',
    micCapturing: msg?.micCapturing === true,
    restarts: num(msg?.restarts),
    dropCode: DROP_CODES.has(msg?.dropCode) ? msg.dropCode : '',
    wakeRejectCode: DROP_CODES.has(msg?.wakeRejectCode) ? msg.wakeRejectCode : '',
    lastWakeRejectionAt: num(msg?.lastWakeRejectionAt),
    lastTransitionAt: num(msg?.lastTransitionAt),
    commandSince: num(msg?.commandSince),
    lastError: typeof msg?.lastError === 'string' && ERROR_CODE.test(msg.lastError) ? msg.lastError : msg?.lastError ? 'other' : '',
    phaseTransition: typeof msg?.phaseTransition === 'string' && PHASE_TRANSITION.test(msg.phaseTransition) ? msg.phaseTransition : '',
    listeningSince: num(msg?.listeningSince),
    listenTimeouts: num(msg?.listenTimeouts),
    wakeListening: msg?.wakeListening === true,
    commandRecognitionActive: msg?.commandRecognitionActive === true,
    ttsActive: msg?.ttsActive === true,
    recognitionGeneration: num(msg?.recognitionGeneration),
    wakes: num(msg?.wakes),
    accepted: num(msg?.accepted),
    lastFinalTranscriptChars: num(msg?.lastFinalTranscriptChars),
    lastUtteranceSentAt: num(msg?.lastUtteranceSentAt),
    lastWakeAt: num(msg?.lastWakeAt),
    wakeToListenMs: num(msg?.wakeToListenMs),
    wakeToMicMs: num(msg?.wakeToMicMs),
    reportedAt: Date.now(),
  }
}
