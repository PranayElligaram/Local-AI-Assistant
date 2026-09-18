/**
 * The user's own application settings: aliases and portable apps.
 *
 * Stored in jarvis.apps.json (git-ignored), written ONLY by the user through
 * `npm run app -- ...`. The model has no path to this file: no tool writes it,
 * so no spoken sentence can teach JARVIS a new executable.
 *
 *   {
 *     "aliases": { "ide": "Visual Studio Code", "music": "Spotify" },
 *     "apps":    { "mytool": { "path": "D:\\Portable\\MyTool\\mytool.exe" } }
 *   }
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute } from 'node:path'
import { normalizeName } from './resolve.mjs'

export const PORTABLE_TYPES = { '.exe': 'exe', '.lnk': 'shortcut', '.appref-ms': 'shortcut' }

export function readRegistry(file) {
  const empty = { aliases: {}, apps: {} }
  if (!file || !existsSync(file)) return empty
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const aliases = data?.aliases && typeof data.aliases === 'object' ? data.aliases : {}
    const apps = data?.apps && typeof data.apps === 'object' ? data.apps : {}
    return {
      aliases: Object.fromEntries(Object.entries(aliases).filter(([, v]) => typeof v === 'string')),
      apps: Object.fromEntries(Object.entries(apps).filter(([, v]) => typeof v?.path === 'string')),
    }
  } catch (err) {
    console.warn(`[jarvis] could not read ${file}: ${err.message} - ignoring it`)
    return empty
  }
}

function writeRegistry(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, file)
}

export function validateAlias(alias) {
  const key = normalizeName(alias)
  if (!key) return { ok: false, error: 'the alias is empty' }
  if (key.length > 40) return { ok: false, error: 'the alias is longer than 40 characters' }
  return { ok: true, key }
}

/** A portable target must be a real, absolute executable or shortcut. */
export function validatePortableTarget(path) {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'no path given' }
  const p = path.trim().replace(/^"(.*)"$/, '$1')
  if (!isAbsolute(p)) return { ok: false, error: 'the path must be absolute' }
  const type = PORTABLE_TYPES[extname(p).toLowerCase()]
  if (!type) return { ok: false, error: 'only .exe, .lnk or .appref-ms files can be registered' }
  let info
  try {
    info = statSync(p)
  } catch {
    return { ok: false, error: 'that file does not exist' }
  }
  if (!info.isFile()) return { ok: false, error: 'that path is not a file' }
  return { ok: true, path: p, type }
}

export function addPortable(file, alias, path) {
  const a = validateAlias(alias)
  if (!a.ok) return a
  const t = validatePortableTarget(path)
  if (!t.ok) return t
  const data = readRegistry(file)
  delete data.aliases[a.key]
  data.apps[a.key] = { path: t.path, addedAt: new Date().toISOString() }
  writeRegistry(file, data)
  return { ok: true, alias: a.key, path: t.path }
}

export function addAlias(file, alias, appName) {
  const a = validateAlias(alias)
  if (!a.ok) return a
  if (!normalizeName(appName)) return { ok: false, error: 'no application name given' }
  const data = readRegistry(file)
  delete data.apps[a.key]
  data.aliases[a.key] = String(appName).trim()
  writeRegistry(file, data)
  return { ok: true, alias: a.key, app: String(appName).trim() }
}

export function removeEntry(file, alias) {
  const key = normalizeName(alias)
  const data = readRegistry(file)
  const had = key in data.aliases || key in data.apps
  delete data.aliases[key]
  delete data.apps[key]
  if (had) writeRegistry(file, data)
  return { ok: had, alias: key, error: had ? '' : 'no such alias' }
}

/** Portable apps as catalogue raw entries. Re-validated on every read. */
export function portableEntries(registry) {
  return Object.entries(registry.apps)
    .map(([alias, { path }]) => ({ alias, t: validatePortableTarget(path) }))
    .filter(({ t }) => t.ok)
    .map(({ alias, t }) => ({ name: alias, type: t.type, target: t.path, source: 'user' }))
}
