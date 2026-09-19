/**
 * Which page owns the clap.
 *
 * Exactly one: the dedicated JARVIS window that open-ui.ps1 opens with
 * `?surface=jarvis`. The same interface in an ordinary browser tab has no
 * marker and never starts a clap listener - two pages listening to one room
 * each heard the other's microphone start as a "clap", and a clap now starts
 * the whole development workspace.
 */
export const SURFACE_PARAM = 'surface'
export const JARVIS_SURFACE = 'jarvis'

/** Sent with POST /workspace; the bridge refuses the request without it. */
export const SURFACE_HEADER = 'x-jarvis-surface'

export function isJarvisSurface(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get(SURFACE_PARAM) === JARVIS_SURFACE
}
