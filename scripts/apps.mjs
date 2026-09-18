#!/usr/bin/env node
/**
 * `npm run app -- <command>` - the user's side of the application resolver.
 *
 *   list [filter]            discovered + registered applications
 *   refresh                  rescan the machine now
 *   resolve <name>           what "open <name>" would do, without opening it
 *   aliases                  your aliases and portable apps
 *   alias <alias> <app name> e.g.  alias ide "Visual Studio Code"
 *   add <alias> <path>       register a portable app (absolute .exe/.lnk path)
 *   remove <alias>           remove an alias or portable app
 *
 * This is the ONLY way an executable path enters JARVIS: typed by you, here.
 * No spoken request and no model output can register one.
 */

import { APP_CACHE_FILE, APPS_FILE } from '../bridge/config.mjs'
import { AppCatalogue } from '../bridge/apps/catalog.mjs'
import { addAlias, addPortable, readRegistry, removeEntry } from '../bridge/apps/registry.mjs'

const [command = 'help', ...rest] = process.argv.slice(2)
const catalogue = new AppCatalogue({ cacheFile: APP_CACHE_FILE, registryFile: APPS_FILE })
const out = (s = '') => console.log(s)

async function main() {
  switch (command) {
    case 'list': {
      await catalogue.ensure()
      const filter = rest.join(' ').toLowerCase()
      const { list } = catalogue.entries()
      const rows = list
        .filter((e) => !filter || e.name.toLowerCase().includes(filter) || e.aliases.some((a) => a.includes(filter)))
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const e of rows) {
        out(`${e.name.padEnd(48)} ${e.source.padEnd(17)} ${e.aliases.length ? `aka ${e.aliases.join(', ')}` : ''}`)
      }
      const s = catalogue.status()
      out(`\n${rows.length} shown · ${s.count} known · built ${s.builtAt ? new Date(s.builtAt).toLocaleString() : 'never'}`)
      return 0
    }
    case 'refresh': {
      const s = await catalogue.refresh()
      if (s.error) {
        out(`Refresh failed: ${s.error}`)
        return 1
      }
      out(`Found ${s.count} applications.`)
      for (const [source, n] of Object.entries(s.sources)) out(`  ${source.padEnd(18)} ${n}`)
      return 0
    }
    case 'resolve': {
      const name = rest.join(' ')
      if (!name) return usage()
      const r = await catalogue.resolve(name)
      if (r.status === 'found') out(`"${name}" -> ${r.app.name} (${r.method}; ${r.app.source}; ${r.app.type} ${r.app.target})`)
      else if (r.status === 'ambiguous') out(`"${name}" is ambiguous: ${r.candidates.join(' | ')}`)
      else if (r.status === 'suggest') out(`"${name}" not found; did you mean: ${r.candidates.join(' | ')}`)
      else out(`"${name}" not found`)
      return r.status === 'found' ? 0 : 1
    }
    case 'aliases': {
      const reg = readRegistry(APPS_FILE)
      out(`File: ${APPS_FILE}`)
      out('\nAliases:')
      for (const [a, t] of Object.entries(reg.aliases)) out(`  ${a.padEnd(20)} -> ${t}`)
      if (!Object.keys(reg.aliases).length) out('  (none)')
      out('\nPortable applications:')
      for (const [a, { path }] of Object.entries(reg.apps)) out(`  ${a.padEnd(20)} -> ${path}`)
      if (!Object.keys(reg.apps).length) out('  (none)')
      return 0
    }
    case 'alias': {
      const [alias, ...name] = rest
      if (!alias || !name.length) return usage()
      const r = addAlias(APPS_FILE, alias, name.join(' '))
      if (!r.ok) return fail(r.error)
      const check = await catalogue.resolve(r.alias)
      out(`Alias "${r.alias}" -> ${r.app}` + (check.status === 'found' ? ` (resolves to ${check.app.name})` : ' (warning: that name does not currently resolve to one app)'))
      return 0
    }
    case 'add': {
      const [alias, ...path] = rest
      if (!alias || !path.length) return usage()
      const r = addPortable(APPS_FILE, alias, path.join(' '))
      if (!r.ok) return fail(r.error)
      out(`Registered "${r.alias}" -> ${r.path}`)
      return 0
    }
    case 'remove': {
      if (!rest.length) return usage()
      const r = removeEntry(APPS_FILE, rest.join(' '))
      if (!r.ok) return fail(r.error)
      out(`Removed "${r.alias}".`)
      return 0
    }
    default:
      return usage()
  }
}

function usage() {
  out(`Usage: npm run app -- <command>

  list [filter]              discovered + registered applications
  refresh                    rescan installed applications now
  resolve <name>             show what "open <name>" would open (opens nothing)
  aliases                    list your aliases and portable apps
  alias <alias> <app name>   e.g.  npm run app -- alias ide "Visual Studio Code"
  add <alias> <path>         e.g.  npm run app -- add mytool "D:\\Tools\\mytool.exe"
  remove <alias>             remove an alias or portable app`)
  return command === 'help' ? 0 : 1
}

function fail(message) {
  console.error(`Error: ${message}`)
  return 1
}

process.exitCode = await main()
