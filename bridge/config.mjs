/**
 * Everything the bridge is allowed to know about this machine.
 *
 * Upstream reads the user's global Claude Code configuration (`~/.claude.json`)
 * for two things: the list of MCP servers to hand the agent, and an ElevenLabs
 * key. Both are deliberately removed here.
 *
 *   - MCP servers. Importing every globally configured server means the voice
 *     assistant silently inherits whatever was installed for something else —
 *     mail, calendars, payment tools — and the first time anyone notices is
 *     when a spoken sentence reaches one of them. This fork starts with none,
 *     and reads an OPT-IN, project-local `jarvis.mcp.json` if (and only if) the
 *     user writes one. Nothing outside the repository is read, and nothing
 *     outside the repository is ever written.
 *
 *   - Secrets. The ElevenLabs key comes from the project's own `.env.local` or
 *     `.env`, both ignored by git. The key itself is never logged, never sent
 *     to the browser, and never written to disk by this process.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFiles } from './env.mjs'

/** The repository root — one level up from `bridge/`. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const ENV_FILES_LOADED = loadEnvFiles(ROOT)

/** Minimum Node the Agent SDK and this code need. */
export const MIN_NODE_MAJOR = 20

export function nodeTooOld(version = process.versions.node) {
  const major = Number(String(version).split('.')[0])
  return Number.isFinite(major) ? major < MIN_NODE_MAJOR : false
}

// --- small parsers ---------------------------------------------------------

const str = (raw) => {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

/** Strict booleans, the way the previous implementation did it: a typo in a
 *  flag should be visible, not silently "off". */
export function flag(name, raw, fallback) {
  const value = str(raw)?.toLowerCase()
  if (value === undefined) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  console.warn(`[jarvis] ${name}="${value}" is not a boolean — using ${fallback}.`)
  return fallback
}

/** A number inside a range, or the default with one warning. */
export function num(name, raw, { min, max, fallback }) {
  const value = str(raw)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[jarvis] ${name}="${value}" is not a number between ${min} and ${max} — using ${fallback}.`,
    )
    return fallback
  }
  return parsed
}

// --- the settings themselves ----------------------------------------------

export const PORT = num('JARVIS_BRIDGE_PORT', process.env.JARVIS_BRIDGE_PORT, {
  min: 1,
  max: 65535,
  fallback: 8787,
})

export const MODEL = str(process.env.JARVIS_MODEL) ?? 'claude-opus-5'
export const EFFORT = str(process.env.JARVIS_EFFORT) ?? 'medium'

/**
 * Writes are off unless asked for twice over: the environment variable, or the
 * explicit `--writes` flag that `npm run bridge:writes` passes. The flag exists
 * because `VAR=1 node ...` is not valid on Windows PowerShell, which is the
 * primary target here.
 */
export const ALLOW_WRITES =
  flag('JARVIS_ALLOW_WRITES', process.env.JARVIS_ALLOW_WRITES, false) ||
  process.argv.includes('--writes')

/**
 * The user's own Chrome, driven through the Claude browser extension. Upstream
 * has this always on; here it is opt-in, because a voice assistant that can
 * read every signed-in tab is a capability to grant deliberately rather than
 * inherit from a clone.
 */
export const ENABLE_CHROME = flag(
  'JARVIS_ENABLE_CHROME',
  process.env.JARVIS_ENABLE_CHROME,
  false,
)

/** The camera. Gated by the browser's own permission prompt as well. */
export const ENABLE_CAMERA = flag(
  'JARVIS_ENABLE_CAMERA',
  process.env.JARVIS_ENABLE_CAMERA,
  true,
)

export const EXTRA_ORIGINS = (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)

export const ALLOW_NO_ORIGIN = flag(
  'JARVIS_ALLOW_NO_ORIGIN',
  process.env.JARVIS_ALLOW_NO_ORIGIN,
  false,
)

export const VOICE_ID =
  str(process.env.JARVIS_VOICE_ID) ??
  str(process.env.ELEVENLABS_VOICE_ID) ??
  'JBFqnCBsd6RMkjVDRZzb'

/**
 * Bounded generation, carried over from the previous implementation: a speech
 * request that never returns used to leave the assistant standing silent with
 * no error to show for it. One wait, no retries, and the fallback voice takes
 * over when it expires.
 */
export const ELEVEN_TIMEOUT_MS =
  num('ELEVENLABS_TIMEOUT_S', process.env.ELEVENLABS_TIMEOUT_S, {
    min: 1,
    max: 60,
    fallback: 10,
  }) * 1000

/** Transcription gets its own, longer budget: the audio has to upload first. */
export const STT_TIMEOUT_MS = Math.max(ELEVEN_TIMEOUT_MS, 20_000)

/**
 * The key, from this project only.
 *
 * Returned, never printed. Callers report `Boolean(elevenKey())` and nothing
 * more; `describeElevenSource()` is the one thing allowed near a log line.
 */
export function elevenKey(env = process.env) {
  return str(env.ELEVENLABS_API_KEY) ?? null
}

export function describeElevenSource(env = process.env) {
  return elevenKey(env)
    ? 'ElevenLabs key present (from the project .env — value never logged)'
    : 'no ElevenLabs key — browser speech will be used'
}

/**
 * Where the agent runs. A directory inside the repository rather than the home
 * directory, so a spoken "what's in this folder" lands somewhere expected and
 * project-scoped configuration elsewhere on the machine cannot apply.
 */
export const WORKSPACE = (() => {
  const configured = str(process.env.JARVIS_WORKSPACE)
  const path = configured
    ? isAbsolute(configured)
      ? configured
      : join(ROOT, configured)
    : join(ROOT, 'workspace')
  try {
    mkdirSync(path, { recursive: true })
  } catch (err) {
    console.warn(`[jarvis] could not create the workspace directory: ${err.message}`)
  }
  return path
})()

/**
 * MCP servers, opt-in and project-local.
 *
 * `jarvis.mcp.json` (git-ignored) may hold `{ "mcpServers": { ... } }` in the
 * same shape Claude Code uses. Absent — the normal case — JARVIS runs with only
 * its own in-process servers: the display, the interface controls, and the
 * camera. The global `~/.claude.json` is never read, in any case, for any
 * reason.
 */
export function mcpConfigPath(env = process.env) {
  const configured = str(env.JARVIS_MCP_CONFIG)
  if (!configured) return join(ROOT, 'jarvis.mcp.json')
  return isAbsolute(configured) ? configured : join(ROOT, configured)
}

export function projectServers(env = process.env) {
  const path = mcpConfigPath(env)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const servers = parsed?.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      console.warn(`[jarvis] ${path} has no "mcpServers" object — ignoring it.`)
      return {}
    }
    return servers
  } catch (err) {
    // A broken opt-in file must not take the assistant down with it.
    console.warn(`[jarvis] could not read ${path}: ${err.message}`)
    return {}
  }
}
