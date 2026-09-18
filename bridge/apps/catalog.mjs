/**
 * The installed-application catalogue: discovery results, cached, merged with
 * the user's own registrations, and resolved by name.
 *
 * Startup never waits on discovery. A cached catalogue is used immediately
 * (and refreshed in the background once it is a day old); with no cache the
 * first request waits for one bounded discovery pass.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, win32 } from 'node:path'
import { discoverApps } from './discover.mjs'
import { portableEntries, readRegistry } from './registry.mjs'
import { BUILTIN_ALIASES, normalizeName, resolveApp } from './resolve.mjs'

const PRIORITY = ['user', 'startmenu-user', 'startmenu-system', 'start-apps', 'app-paths', 'builtin']
/** Sources that only fill gaps: they never add a second entry for a name already known. */
const GAP_FILLERS = new Set(['app-paths', 'builtin'])

/** Squirrel-style launchers: `<root>\Update.exe --processStart <App>.exe`. */
const PROCESS_START = /(?:^|\s)--processStart(?:=|\s+)"?([^"\s]+\.exe)"?/i

const winDir = (p) => win32.dirname(String(p))
const winBase = (p) => win32.basename(String(p))

/**
 * What a row actually launches, as `<install root>|<executable>`, or '' when
 * that cannot be known. Two rows with the same identity are one installation
 * reached two ways; two with different identities are two apps, whatever
 * their names.
 *
 *   <root>\app-1.0.9256\Discord.exe               -> <root>|discord.exe
 *   <root>\Update.exe --processStart Discord.exe  -> <root>|discord.exe
 */
export function launchIdentity(row) {
  const target = row.link?.target ?? (row.type === 'exe' ? row.target : '')
  if (!/\.exe$/i.test(target)) return ''
  const via = PROCESS_START.exec(row.link?.args ?? '')
  const exe = (via ? winBase(via[1]) : winBase(target)).toLowerCase()
  let root = winDir(target).toLowerCase()
  if (!via) root = root.replace(/\\app-\d[\w.-]*$/, '')
  return `${root}|${exe}`
}

/**
 * Among equivalent rows, which one to launch. Lower is better: a direct
 * executable that exists, then registered App Paths, then any other direct
 * target, then an updater/bootstrap launcher, then packaged Start apps.
 */
export function targetRank(row) {
  if (row.source === 'builtin') return 6
  if (row.type === 'startapp') return 5
  if (row.link && PROCESS_START.test(row.link.args ?? '')) return 4
  if (row.source === 'app-paths') return 2
  if (row.link?.exists && /\.exe$/i.test(row.link.target) && !row.link.args) return 1
  if (row.type === 'exe') return 1
  return 3
}

/**
 * Raw discovery rows -> catalogue entries, highest-priority source first.
 * The same app seen by two sources (a Start Menu shortcut and a Start app) is
 * one entry; two different apps with the same name in one source (two
 * "Calendar" apps) stay two entries, so asking for it is correctly ambiguous.
 */
export function buildCatalogue(raw) {
  const rows = [...raw].sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source))
  const entries = []
  const byKey = new Map()
  const claimed = new Set()

  const attachAliases = () => {
    for (const { say, names } of BUILTIN_ALIASES) {
      const target = names.map(normalizeName).map((k) => byKey.get(k)?.[0]).find(Boolean)
      if (!target) continue
      for (const alias of say.map(normalizeName)) {
        if (alias !== target.key && !target.aliases.includes(alias)) target.aliases.push(alias)
        claimed.add(alias)
      }
    }
  }

  let aliasesAttached = false
  for (const row of rows) {
    const key = normalizeName(row.name)
    if (!key || !row.target) continue
    if (GAP_FILLERS.has(row.source)) {
      if (!aliasesAttached) {
        attachAliases()
        aliasesAttached = true
      }
      if (claimed.has(key) || byKey.has(key)) continue
    }
    const same = byKey.get(key) ?? []
    // Same name, same installation, reached two ways (a direct shortcut and an
    // updater stub): one app, launched through the better of the two.
    const identity = launchIdentity(row)
    const twin = identity && same.find((e) => e.identity === identity)
    if (twin) {
      if (targetRank(row) < twin.rank) Object.assign(twin, { type: row.type, target: row.target, source: row.source, rank: targetRank(row) })
      continue
    }
    if (same.some((e) => e.source !== row.source || e.target === row.target)) continue
    const entry = { name: row.name, key, aliases: [], type: row.type, target: row.target, source: row.source, identity, rank: targetRank(row) }
    entries.push(entry)
    byKey.set(key, [...same, entry])
    claimed.add(key)
  }
  attachAliases()
  return entries
}

export class AppCatalogue {
  constructor({
    cacheFile,
    registryFile,
    discover = discoverApps,
    maxAgeMs = 24 * 3600_000,
    missRefreshAfterMs = 10 * 60_000,
  } = {}) {
    this.cacheFile = cacheFile
    this.registryFile = registryFile
    this.discover = discover
    this.maxAgeMs = maxAgeMs
    this.missRefreshAfterMs = missRefreshAfterMs
    this.raw = []
    this.sources = {}
    this.builtAt = 0
    this.error = ''
    this.refreshing = null
    this.merged = null
    this.mergedFor = ''
  }

  /** Read the cache, if any. Synchronous and cheap; safe at startup. */
  load() {
    if (!this.cacheFile || !existsSync(this.cacheFile)) return false
    try {
      const data = JSON.parse(readFileSync(this.cacheFile, 'utf8'))
      if (data?.version !== 1 || !Array.isArray(data.raw)) return false
      this.raw = data.raw
      this.sources = data.sources ?? {}
      this.builtAt = data.builtAt ?? 0
      this.merged = null
      return true
    } catch {
      return false
    }
  }

  stale(now = Date.now()) {
    return !this.builtAt || now - this.builtAt > this.maxAgeMs
  }

  /** One discovery pass at a time; concurrent callers share it. */
  refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const { entries, sources } = await this.discover()
        this.raw = entries
        this.sources = sources
        this.builtAt = Date.now()
        this.error = ''
        this.merged = null
        if (this.cacheFile) {
          mkdirSync(dirname(this.cacheFile), { recursive: true })
          writeFileSync(
            this.cacheFile,
            JSON.stringify({ version: 1, builtAt: this.builtAt, sources, raw: entries }),
          )
        }
      } catch (err) {
        this.error = String(err?.message ?? err)
      } finally {
        this.refreshing = null
      }
      return this.status()
    })()
    return this.refreshing
  }

  /** Make sure something usable exists; refresh a stale cache in the background. */
  async ensure() {
    if (!this.builtAt) this.load()
    if (!this.builtAt) await this.refresh()
    else if (this.stale()) void this.refresh()
  }

  registry() {
    let stamp = 'none'
    try {
      if (this.registryFile && existsSync(this.registryFile)) stamp = String(statSync(this.registryFile).mtimeMs)
    } catch {
      /* treated as absent */
    }
    return { stamp, data: stamp === 'none' ? { aliases: {}, apps: {} } : readRegistry(this.registryFile) }
  }

  /** Discovered entries plus the user's portable apps, rebuilt when either changes. */
  entries() {
    const { stamp, data } = this.registry()
    const token = `${this.builtAt}:${stamp}`
    if (!this.merged || this.mergedFor !== token) {
      this.merged = { list: buildCatalogue([...portableEntries(data), ...this.raw]), aliases: data.aliases }
      this.mergedFor = token
    }
    return this.merged
  }

  async resolve(name) {
    await this.ensure()
    let { list, aliases } = this.entries()
    let result = resolveApp(name, list, aliases)
    // Something installed since the last scan? One refresh, if the catalogue
    // is not brand new, then one more try.
    if (result.status === 'not_found' && Date.now() - this.builtAt > this.missRefreshAfterMs) {
      await this.refresh()
      ;({ list, aliases } = this.entries())
      result = resolveApp(name, list, aliases)
    }
    return result
  }

  status() {
    const count = this.builtAt ? this.entries().list.length : 0
    return {
      status: this.refreshing ? 'refreshing' : this.error && !this.builtAt ? 'error' : this.builtAt ? 'ready' : 'empty',
      count,
      builtAt: this.builtAt,
      sources: this.sources,
      error: this.error,
    }
  }
}
