/**
 * Two claps, not one.
 *
 * clap.ts decides what a clap SOUNDS like. This decides what a clap MEANS, and
 * the answer is: on its own, nothing. A single sharp transient is a mug on a
 * desk, a door, a knuckle on a table — the detector is good but a room is full
 * of impulses, and the clap now starts three monitors' worth of workspace. So
 * the wake gesture is two of them, close together and deliberate: something a
 * room does not do by accident but a pair of hands does without thinking.
 *
 * No timers live in here. The caller reports claps and ticks the clock, so a
 * listener that stops takes the pending state with it.
 */

/**
 * Closer than this and it is one impulse heard twice — the tail of a clap, or
 * its echo off a wall — not two hands.
 */
export const DOUBLE_CLAP_MIN_MS = 100
/**
 * Further apart than this and it was two separate events that happened to
 * land near each other. Two intentional claps sit comfortably inside this;
 * the false transients seen in a quiet room were seconds apart.
 */
export const DOUBLE_CLAP_MAX_MS = 650

/** What a clap did: started a gesture, completed one, or was thrown away. */
export type ClapResult = 'armed' | 'wake' | 'too-soon' | 'cooldown'

export type WakeGesture = {
  /** Report a clap-shaped event. Only 'wake' means "power on". */
  clap: (at: number) => ClapResult
  /** Called every frame: drops a first clap whose partner never came. */
  expire: (now: number) => boolean
  /** Forget everything — the listener is stopping or restarting. */
  reset: () => void
  /** When the first clap of a half-finished gesture landed, if any. */
  readonly pendingAt: number | null
}

/**
 * @param cooldownMs how long after a completed gesture claps are ignored, so
 *   one pair of hands cannot wake him twice.
 */
export function createWakeGesture(cooldownMs: number): WakeGesture {
  let pendingAt: number | null = null
  let lastWakeAt = -Infinity

  return {
    clap(at) {
      if (at - lastWakeAt < cooldownMs) {
        pendingAt = null
        return 'cooldown'
      }
      const first = pendingAt
      pendingAt = null
      // No first clap, or one too stale to still be part of this gesture: this
      // clap is the start of a new one.
      if (first === null || at - first > DOUBLE_CLAP_MAX_MS) {
        pendingAt = at
        return 'armed'
      }
      if (at - first < DOUBLE_CLAP_MIN_MS) return 'too-soon'
      lastWakeAt = at
      return 'wake'
    },
    expire(now) {
      if (pendingAt === null || now - pendingAt <= DOUBLE_CLAP_MAX_MS) return false
      pendingAt = null
      return true
    },
    reset() {
      pendingAt = null
    },
    get pendingAt() {
      return pendingAt
    },
  }
}
