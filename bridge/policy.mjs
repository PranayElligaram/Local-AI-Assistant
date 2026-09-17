/**
 * Who may talk to the bridge, and what the agent may do once it is talking.
 *
 * This is upstream's policy, lifted out of `server.mjs` unchanged in substance
 * so that it can be tested directly. Both functions are pure: everything they
 * depend on arrives as an argument, which is what lets a test state "with
 * writes disabled, `Bash` is refused" as a fact rather than as a hope.
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

/**
 * Both spellings of every renamed built-in are listed on purpose: the SDK
 * presents several tools under newer names, and a set holding only the old ones
 * never matches, so the tool falls through to the write branch.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])

export const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/** Servers whose entire surface is lookups or generation. */
export const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  'higgsfield', 'heygen', 'elevenlabs',
])

/** Anchored, so it reads the verb rather than the noun. */
export const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/** Unanchored: `make_outbound_call` hides its verb in the middle. */
export const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/** Tools whose names trip the veto without deserving it. */
export const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

/** JARVIS's own in-process servers: the display, the interface, the camera and
 *  the browser. They draw on our own screen or are gated elsewhere. */
export const OWN_SERVERS = new Set([
  'jarvis',
  'jarvis_ui',
  'jarvis_chrome',
  'jarvis_eyes',
])

/** MCP tools arrive as `mcp__<server>__<tool>`. */
export const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores. */
export const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * Voice is a bad interface for a confirmation dialog, so the bridge decides
 * ahead of time. Read-only and generative tools run freely; anything that
 * writes to disk, runs a shell or changes the world waits for writes to be
 * enabled explicitly.
 */
export function decideTool(name, allowWrites) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return allowWrites

  const server = mcpServerOf(name)
  if (server) {
    if (server === 'jarvis' || server === 'jarvis_ui') return true
    // The browser server gates itself at construction: the acting tools only
    // exist when writes are enabled, so anything reaching here is already
    // permitted by the same policy.
    if (server === 'jarvis_chrome') return true
    // Looking changes nothing, and the real gate is the browser's own camera
    // permission plus an indicator the user can see.
    if (server === 'jarvis_eyes') return true

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return allowWrites
    }
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : allowWrites
  }
  return allowWrites
}
