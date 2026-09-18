/**
 * Everything the bridge is allowed to know about this machine.
 *
 * Project-local only. Settings come from the real environment, then the
 * project's own `.env.local` / `.env` (both git-ignored). Nothing outside the
 * repository is read: no global Claude Code configuration, no MCP discovery,
 * no account connectors. JARVIS does not use Claude at runtime at all - the
 * brain is a local Ollama model (see brain/).
 *
 * Secrets: the optional ElevenLabs key is never logged, never sent to the
 * browser, and never written to disk by this process.
 */

import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFiles } from './env.mjs'

/** The repository root — one level up from `bridge/`. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const ENV_FILES_LOADED = loadEnvFiles(ROOT)

/** Minimum Node this code (and Vite) need: 20.19+ or 22.12+. */
export const MIN_NODE_MAJOR = 20

export function nodeTooOld(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number)
  return !Number.isFinite(major) || major < 20 || (major === 20 && minor < 19) || major === 21 || (major === 22 && minor < 12)
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

/** Runtime files: the launcher's PID file, the bridge's run file, caches. */
export const RUN_DIR = resolve(str(process.env.JARVIS_RUN_DIR) ?? join(ROOT, '.jarvis'))

/**
 * The local brain. Defaults are the measured-good setup on this machine:
 * granite4:3b answers (about 17 tokens/s warm on CPU), qwen3.5:4b is the
 * fallback, and keep_alive holds granite in memory between questions.
 */
export function brainConfig(env = process.env) {
  const seconds = (name, fallback, max) =>
    num(name, env[name], { min: 1, max, fallback }) * 1000
  const url = str(env.JARVIS_OLLAMA_URL) ?? 'http://127.0.0.1:11434'
  let parsed = null
  try {
    parsed = new URL(url)
  } catch {
    /* reported below */
  }
  const okUrl = parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
  if (!okUrl) console.warn(`[jarvis] JARVIS_OLLAMA_URL="${url}" is not an http(s) URL - using the default.`)
  return {
    provider: (str(env.JARVIS_BRAIN_PROVIDER) ?? 'ollama').toLowerCase(),
    ollamaUrl: okUrl ? url.replace(/\/+$/, '') : 'http://127.0.0.1:11434',
    model: str(env.JARVIS_LOCAL_MODEL) ?? 'granite4:3b',
    fallbackModel: str(env.JARVIS_LOCAL_FALLBACK_MODEL) ?? 'qwen3.5:4b',
    keepAlive: str(env.JARVIS_MODEL_KEEP_ALIVE) ?? '30m',
    connectTimeoutMs: seconds('JARVIS_OLLAMA_CONNECT_TIMEOUT_S', 3, 60),
    responseTimeoutMs: seconds('JARVIS_OLLAMA_RESPONSE_TIMEOUT_S', 20, 300),
    loadTimeoutMs: seconds('JARVIS_OLLAMA_LOAD_TIMEOUT_S', 60, 600),
    maxTokens: num('JARVIS_MAX_RESPONSE_TOKENS', env.JARVIS_MAX_RESPONSE_TOKENS, {
      min: 16,
      max: 4096,
      fallback: 256,
    }),
  }
}

export const BRAIN = brainConfig()

/**
 * Applications. The user's own aliases and portable registrations live in
 * jarvis.apps.json (git-ignored); the discovered catalogue is a cache in the
 * run directory. JARVIS_LAUNCH_DRY_RUN=1 resolves without launching, for the
 * end-to-end check.
 */
export const APPS_FILE = (() => {
  const configured = str(process.env.JARVIS_APPS_FILE)
  if (!configured) return join(ROOT, 'jarvis.apps.json')
  return isAbsolute(configured) ? configured : join(ROOT, configured)
})()
export const APP_CACHE_FILE = join(RUN_DIR, 'app-catalog.json')
export const LAUNCH_DRY_RUN = flag('JARVIS_LAUNCH_DRY_RUN', process.env.JARVIS_LAUNCH_DRY_RUN, false)

/** Which search engine "search for X" opens. */
export const SEARCH_ENGINE = (() => {
  const v = (str(process.env.JARVIS_SEARCH_ENGINE) ?? 'google').toLowerCase()
  return ['google', 'bing', 'duckduckgo'].includes(v) ? v : 'google'
})()

/**
 * Safe mode is the default. Writes (effectful actions) are off unless asked
 * for twice over: the environment variable, or the
 * explicit `--writes` flag that `npm run bridge:writes` passes. The flag exists
 * because `VAR=1 node ...` is not valid on Windows PowerShell, which is the
 * primary target here.
 */
export const ALLOW_WRITES =
  flag('JARVIS_ALLOW_WRITES', process.env.JARVIS_ALLOW_WRITES, false) ||
  process.argv.includes('--writes')

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

/** The ElevenLabs API origin. Overridable only so tests can stand in for it. */
export const ELEVEN_BASE = (str(process.env.JARVIS_ELEVENLABS_BASE) ?? 'https://api.elevenlabs.io').replace(/\/+$/, '')

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
