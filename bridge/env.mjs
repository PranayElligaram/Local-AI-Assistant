/**
 * Project-local environment files.
 *
 * Upstream reads its ElevenLabs key out of `~/.claude.json`, which is the one
 * file on this machine that must not be touched or depended on: it is the
 * user's global Claude Code configuration. This fork keeps every secret inside
 * the repository instead, in `.env.local` (preferred) or `.env`, both ignored
 * by git.
 *
 * Rules that matter here:
 *   - a real environment variable always wins, so `JARVIS_MODEL=... npm start`
 *     still overrides the file;
 *   - nothing in a value is ever logged — only key NAMES are reported, so a
 *     key cannot be leaked by a startup banner or a crash;
 *   - a malformed file is a warning, not a crash. Losing the voice because a
 *     line had a stray quote is the wrong trade for an assistant.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Strip one layer of matching quotes, and the `export ` prefix dotenv allows. */
function parseLine(line) {
  const text = line.trim()
  if (!text || text.startsWith('#')) return null
  const body = text.startsWith('export ') ? text.slice(7).trim() : text
  const eq = body.indexOf('=')
  if (eq <= 0) return null
  const key = body.slice(0, eq).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
  let value = body.slice(eq + 1).trim()
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1)
  } else {
    // An unquoted trailing comment is a dotenv convention, and a key that
    // silently carries " # note" on the end fails as an authentication error
    // half an hour later.
    const hash = value.indexOf(' #')
    if (hash !== -1) value = value.slice(0, hash).trim()
  }
  return [key, value]
}

/** Parse a whole file into a plain object. Exported for the tests. */
export function parseEnv(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const pair = parseLine(line)
    if (pair) out[pair[0]] = pair[1]
  }
  return out
}

/**
 * Load `.env.local` then `.env` from `dir` into `env`, without overwriting
 * anything already set. Returns the key names loaded, per file, so a caller can
 * report what it found without ever touching a value.
 */
export function loadEnvFiles(dir, env = process.env) {
  const loaded = []
  // .env.local first: it is the file meant for one machine, so when both
  // define a key the more specific one should win, and "first writer wins"
  // here is what makes that true.
  for (const name of ['.env.local', '.env']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    let values
    try {
      values = parseEnv(readFileSync(path, 'utf8'))
    } catch (err) {
      console.warn(`[jarvis] could not read ${name}: ${err.message}`)
      continue
    }
    const applied = []
    for (const [key, value] of Object.entries(values)) {
      if (env[key] !== undefined) continue
      env[key] = value
      applied.push(key)
    }
    loaded.push({ file: name, keys: applied })
  }
  return loaded
}
