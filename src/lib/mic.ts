/**
 * Choosing a microphone, and keeping one.
 *
 * Upstream opens `getUserMedia({ audio: true })` once and trusts it for the
 * life of the page. On a laptop that is usually right and occasionally the
 * whole failure: the default device is a webcam array pointing at the ceiling,
 * or a headset that gets unplugged mid-conversation, and the symptom in both
 * cases is an assistant that looks perfectly alive and never hears a word.
 *
 * The previous implementation had rules for exactly this, and they are the
 * rules kept here:
 *
 *   - a configured device may be an INDEX or part of a NAME;
 *   - a name that matches more than one device is refused rather than guessed
 *     at, because picking one at random is how you end up debugging the wrong
 *     microphone;
 *   - a preference that no longer matches falls back to the system default,
 *     but never SILENTLY: `selection.fallback` says so and the diagnostics
 *     panel prints it. Deafness is worse than the wrong device, so the
 *     fallback happens; not knowing which device you are on is what made the
 *     old bug expensive, so it is stated.
 *
 * Device labels are only readable after permission has been granted, so the
 * first open is always the default device and the preference is applied on the
 * second pass. That is one extra open at boot, and it is the only way the
 * browser will tell us what the devices are called.
 */

export type MicSelection = {
  /** deviceId actually opened, or '' for "whatever the system says". */
  deviceId: string
  /** Device label, once permission makes labels readable. */
  label: string
  /** Why this device: 'default' | 'index' | 'name' | 'fallback'. */
  reason: 'default' | 'index' | 'name' | 'fallback'
  /** Set when a configured preference could not be honoured. */
  fallback: string
}

export type MicDevice = { deviceId: string; label: string }

/**
 * Resolve a configured preference against the devices the browser reports.
 * Pure, so the rules can be tested without a microphone.
 */
export function chooseMic(
  devices: MicDevice[],
  preference: string,
): MicSelection {
  const wanted = preference.trim()
  if (!wanted) {
    return { deviceId: '', label: devices[0]?.label ?? '', reason: 'default', fallback: '' }
  }

  // An index, the way the previous implementation accepted one.
  if (/^\d+$/.test(wanted)) {
    const index = Number(wanted)
    const device = devices[index]
    if (device) {
      return { deviceId: device.deviceId, label: device.label, reason: 'index', fallback: '' }
    }
    return {
      deviceId: '',
      label: '',
      reason: 'fallback',
      fallback: `microphone ${index} does not exist (${devices.length} available) — using the system default`,
    }
  }

  const needle = wanted.toLowerCase()
  const matches = devices.filter((d) => d.label.toLowerCase().includes(needle))
  if (matches.length === 1) {
    return {
      deviceId: matches[0].deviceId,
      label: matches[0].label,
      reason: 'name',
      fallback: '',
    }
  }
  if (matches.length > 1) {
    return {
      deviceId: '',
      label: '',
      reason: 'fallback',
      fallback: `"${wanted}" matches ${matches.length} microphones — name it more precisely; using the system default`,
    }
  }
  return {
    deviceId: '',
    label: '',
    reason: 'fallback',
    fallback: `no microphone matches "${wanted}" — using the system default`,
  }
}

/** Backoff for reacquiring a lost device: quick at first, then patient. */
export function retryDelay(attempt: number): number {
  const steps = [250, 500, 1000, 2000, 4000]
  return steps[Math.min(attempt, steps.length - 1)]
}
