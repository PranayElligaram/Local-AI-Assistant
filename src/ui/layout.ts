/**
 * Where the reactor sits, in CSS pixels.
 *
 * The WebGL ring and the vector instrument drawn over it have to agree to the
 * pixel, so both read this one function rather than each keeping a constant.
 * The reactor sits above centre to leave the lower third for the state readout
 * and the record; on short windows it shrinks a little and rises so the record
 * keeps at least three lines.
 */
export function reactorFrame(w: number, h: number): { y: number; d: number } {
  const short = Math.min(w, h)
  const compact = h < 960
  return {
    /** Centre, px from the top of the viewport. */
    y: Math.round(h * (compact ? 0.38 : 0.4)),
    /** Diameter of the main ring, px. */
    d: Math.round(short * (compact ? 0.42 : 0.46)),
  }
}

let motionQuery: MediaQueryList | null = null

/** Whether the user asked for less motion. Read live (it can change), and
 *  cheap enough to call per frame: the query object is made once. */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false
  motionQuery ??= matchMedia('(prefers-reduced-motion: reduce)')
  return motionQuery.matches
}
