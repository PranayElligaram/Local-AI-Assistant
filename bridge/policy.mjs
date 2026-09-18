/**
 * Who may talk to the bridge.
 *
 * Pure and separately tested. (What the assistant may DO is decided by the tool
 * registry in tools.mjs: JARVIS owns every tool, and there is no general shell,
 * file or MCP surface left to gate.)
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers.
 */
export const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

/**
 * A WebSocket handshake is not subject to the same-origin policy, so any page
 * the user has open could otherwise open a socket to the bridge and drive the
 * agent. The Origin header is the only thing separating our own dev server from
 * someone else's page.
 */
export function originAllowed(origin, { extraOrigins = [], allowNoOrigin = false } = {}) {
  if (!origin) return allowNoOrigin
  const trimmed = origin.replace(/\/+$/, '')
  if (extraOrigins.includes(trimmed)) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}
