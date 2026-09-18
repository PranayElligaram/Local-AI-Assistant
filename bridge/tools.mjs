/**
 * JARVIS's tools. The model may SELECT one; only this file EXECUTES one.
 *
 *   tool request -> known name? -> callable by this caller? -> arguments valid?
 *                -> permitted in this mode? -> JARVIS's own implementation
 *                -> structured result { ok, say, data }
 *
 * There is deliberately no shell tool, no "run command" tool and no tool that
 * accepts a path. open_application takes a NAME, which is resolved against the
 * installed-application catalogue; the model never supplies what is executed,
 * and nothing it says is ever interpolated into a command line.
 */

import os from 'node:os'
import { launchApp, openUrl, signOut } from './apps/launch.mjs'
import { knownSite } from './router.mjs'
import { searchUrl } from './web.mjs'

/** Minimal JSON-schema check: exactly what the tool schemas below use. */
export function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object'
  const props = schema.properties ?? {}
  for (const key of Object.keys(args)) {
    if (!(key in props)) return `unexpected argument "${key}"`
  }
  for (const key of schema.required ?? []) {
    if (!(key in args)) return `missing argument "${key}"`
  }
  for (const [key, rule] of Object.entries(props)) {
    if (!(key in args)) continue
    const v = args[key]
    if (rule.type === 'string') {
      if (typeof v !== 'string') return `"${key}" must be a string`
      if (rule.minLength != null && v.trim().length < rule.minLength) return `"${key}" is too short`
      if (rule.maxLength != null && v.length > rule.maxLength) return `"${key}" is too long`
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(v)) return `"${key}" contains characters that are not allowed`
      if (rule.enum && !rule.enum.includes(v)) return `"${key}" is not an allowed value`
    }
  }
  return null
}

/** A spoken application name, not a path and not a command line. */
const APP_NAME_PATTERN = "^[\\p{L}\\p{N} .+#&'()_\\u00ae\\u2122-]+$"
const SCRIPT_EXT = /\.(?:bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|py|pyw|msi|scr|hta|reg)$/i
const looksLikeArguments = (s) =>
  /(^|\s)[-/]\S/.test(s) || // a flag: -c, --version, /c
  s.trim().split(/\s+/).some((word, i, all) => (i < all.length - 1 && /\.(?:exe|lnk)$/i.test(word)) || SCRIPT_EXT.test(word))

/** http(s) only, no embedded credentials. Bare domains get https://. */
export function safeUrl(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!url.hostname || !/[a-z0-9]/i.test(url.hostname)) return null
  return url.href
}

/**
 * "Start today": opened in order. Targets are names in the trusted site
 * table, looked up rather than composed; add safe sites here.
 */
export const DAILY_START_ROUTINE = [
  { type: 'url', target: 'google calendar' },
  { type: 'url', target: 'gmail' },
]
/** How long "Good night" waits for "confirm good night". */
const SIGN_OUT_TTL_MS = 2 * 60 * 1000

const spokenTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
const spokenDate = (d) =>
  d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

/**
 * @param {object} deps
 * @param {import('./apps/catalog.mjs').AppCatalogue} deps.catalogue
 * @param {boolean} [deps.dryRun]        resolve and validate, but do not launch
 * @param {boolean} [deps.allowWrites]   the separate writes mode
 * @param {string}  [deps.searchEngine]
 * @param {(op: string, args?: object) => void} [deps.ui]   push to the interface
 * @param {{ restart: () => void, stop: () => void }} [deps.lifecycle]
 * @param {() => Promise<object>} [deps.systemStatus]
 * @param {() => Date} [deps.now]
 * @param {object} [deps.launcher]      { launchApp, openUrl, signOut } - injectable for tests
 */
export function createTools(deps) {
  const {
    catalogue,
    dryRun = false,
    allowWrites = false,
    searchEngine = 'google',
    ui = () => {},
    lifecycle = { restart() {}, stop() {} },
    systemStatus = async () => ({}),
    now = () => new Date(),
    launcher = { launchApp, openUrl, signOut },
    routine = DAILY_START_ROUTINE,
  } = deps

  const state = {
    last: '',
    lastOk: null,
    lastResult: '',
    lastOrigin: '',
    executed: 0,
    rejected: 0,
    lastRejection: '',
    app: { requested: '', resolved: '', method: '', launch: '' },
  }
  // When "Good night" was said; sign-out needs a confirmation after it.
  let signOutPendingAt = 0

  const openInBrowser = async (href, say) => {
    const r = await launcher.openUrl(href, { dryRun })
    return r.ok
      ? { ok: true, say, data: { url: href, dryRun: Boolean(r.dryRun) } }
      : { ok: false, say: "I couldn't open the browser.", data: { error: r.error } }
  }

  const defs = [
    {
      name: 'get_time',
      description: 'Get the current local time from the system clock.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'safe',
      model: true,
      run: async () => {
        const d = now()
        return { ok: true, say: `It's ${spokenTime(d)}.`, data: { iso: d.toISOString() } }
      },
    },
    {
      name: 'get_date',
      description: "Get today's date and day of the week from the system clock.",
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'safe',
      model: true,
      run: async () => {
        const d = now()
        return { ok: true, say: `Today is ${spokenDate(d)}.`, data: { iso: d.toISOString() } }
      },
    },
    {
      name: 'open_application',
      description:
        'Open an installed application on this Windows PC by its name, for example "Spotify", "Visual Studio Code" or "Calculator". Pass only the application name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The application name only.', minLength: 1, maxLength: 80, pattern: APP_NAME_PATTERN },
        },
        required: ['name'],
      },
      permission: 'safe',
      model: true,
      extraCheck: (a) => (looksLikeArguments(a.name) ? 'application names cannot carry arguments or paths' : null),
      run: async ({ name }) => {
        const asked = name.trim()
        state.app = { requested: asked, resolved: '', method: '', launch: '' }
        const r = await catalogue.resolve(asked)
        state.app.method = r.method ?? r.status
        if (r.status === 'ambiguous') {
          state.app.launch = 'ambiguous'
          return {
            ok: false,
            needsChoice: r.candidates,
            say: `I found more than one match: ${listOf(r.candidates)}. Which one should I open?`,
            data: r,
          }
        }
        if (r.status === 'suggest') {
          state.app.launch = 'suggested'
          return {
            ok: false,
            needsChoice: r.candidates,
            say: `I couldn't find ${asked}. Did you mean ${listOf(r.candidates, 'or')}?`,
            data: r,
          }
        }
        if (r.status !== 'found') {
          state.app.launch = 'not found'
          return { ok: false, say: `I couldn't find an application called ${asked}.`, data: r }
        }
        state.app.resolved = r.app.name
        const launched = await launcher.launchApp(r.app, { dryRun })
        state.app.launch = launched.ok ? (launched.dryRun ? 'ok (dry run)' : 'ok') : `failed: ${launched.error}`
        return launched.ok
          ? { ok: true, say: `Opening ${r.app.name}.`, data: { app: r.app.name, source: r.app.source, method: r.method, dryRun: Boolean(launched.dryRun) } }
          : { ok: false, say: `I found ${r.app.name}, but it didn't start.`, data: { app: r.app.name, error: launched.error } }
      },
    },
    {
      name: 'open_url',
      description: 'Open a web address (http or https) in the default browser.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', minLength: 3, maxLength: 2048 } },
        required: ['url'],
      },
      permission: 'safe',
      model: true,
      extraCheck: (a) => (safeUrl(a.url) ? null : 'only http and https addresses can be opened'),
      run: async ({ url }) => {
        const href = safeUrl(url)
        return openInBrowser(href, `Opening ${new URL(href).hostname.replace(/^www\./, '')}.`)
      },
    },
    {
      name: 'search_web',
      description:
        "Open a web search in the user's browser. Only for an explicit request to search or look something up online, or for live information (today's news, weather, sports scores, prices). Never for general knowledge you can answer yourself.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 300 } },
        required: ['query'],
      },
      permission: 'safe',
      model: true,
      run: async ({ query }) => {
        const href = searchUrl(query, searchEngine)
        return openInBrowser(href, `Searching for ${query.trim()}.`)
      },
    },
    {
      name: 'research_web',
      description: 'Find and summarise current information. Live retrieval is not available in this build.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 300 } },
        required: ['query'],
      },
      permission: 'safe',
      model: false,
      run: async ({ query }) => {
        // No WebSearchProvider is configured (see bridge/web.mjs), so JARVIS
        // says so rather than letting a local model invent current events.
        const href = searchUrl(query, searchEngine)
        return openInBrowser(href, "I can't read live web results yet, so I've opened a search for it.")
      },
    },
    {
      name: 'get_system_status',
      description: "Report JARVIS's own status: local brain, memory use and uptime.",
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'safe',
      model: true,
      run: async () => {
        const s = await systemStatus()
        const mem = Math.round((1 - os.freemem() / os.totalmem()) * 100)
        const brain = s.brainOnline ? `The local brain is online with ${s.model}.` : 'The local brain is offline.'
        return { ok: true, say: `${brain} Memory use is ${mem} percent.`, data: { ...s, memoryPercent: mem } }
      },
    },
    {
      name: 'show_diagnostics',
      description: 'Show the diagnostics panel on screen.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'safe',
      model: true,
      run: async () => {
        ui('diagnostics', { open: true })
        return { ok: true, say: 'Diagnostics are on screen.' }
      },
    },
    {
      name: 'refresh_applications',
      description: 'Rescan the installed applications.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'lifecycle',
      model: false,
      run: async () => {
        const s = await catalogue.refresh()
        return s.error
          ? { ok: false, say: "I couldn't rescan the applications.", data: s }
          : { ok: true, say: `I know ${s.count} applications now.`, data: s }
      },
    },
    {
      name: 'good_morning',
      description: 'Greet the user.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'safe',
      model: false,
      run: async () => ({ ok: true, say: `Good morning. It's ${spokenDate(now())}. JARVIS is online and ready.` }),
    },
    {
      name: 'start_today',
      description: 'Open the daily workspace.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'safe',
      model: false,
      run: async () => {
        const opened = []
        const failed = []
        for (const item of routine) {
          const href = item.type === 'url' ? knownSite(item.target) : null
          const r = href ? await launcher.openUrl(href, { dryRun }).catch((err) => ({ ok: false, error: err.message })) : { ok: false }
          ;(r.ok ? opened : failed).push(item.target)
        }
        return failed.length
          ? { ok: false, say: `The daily routine finished with an issue: I couldn't open ${listOf(failed)}.`, data: { opened, failed } }
          : { ok: true, say: 'Your daily workspace is ready.', data: { opened, failed } }
      },
    },
    {
      name: 'good_night',
      description: 'Ask to sign out of Windows; nothing happens until confirmed.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'lifecycle',
      model: false,
      run: async () => {
        signOutPendingAt = Date.now()
        return { ok: true, say: "Good night. Say 'confirm good night' to sign out of Windows." }
      },
    },
    {
      name: 'confirm_good_night',
      description: 'Sign out of Windows, after good_night.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'lifecycle',
      model: false,
      run: async () => {
        const pending = signOutPendingAt && Date.now() - signOutPendingAt < SIGN_OUT_TTL_MS
        signOutPendingAt = 0
        if (!pending) return { ok: false, say: "Say 'good night' first if you want to sign out." }
        const r = await launcher.signOut({ dryRun })
        return r.ok
          ? { ok: true, say: 'Signing out. Good night.', data: { dryRun: Boolean(r.dryRun) } }
          : { ok: false, say: "I couldn't sign out.", data: { error: r.error } }
      },
    },
    {
      name: 'cancel_good_night',
      description: 'Cancel a pending sign-out.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'safe',
      model: false,
      run: async () => {
        const had = Boolean(signOutPendingAt)
        signOutPendingAt = 0
        return { ok: true, say: had ? "Sign-out cancelled. I'll stay on." : 'There was no sign-out to cancel.' }
      },
    },
    {
      name: 'restart_jarvis',
      description: 'Restart JARVIS.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'lifecycle',
      model: false,
      run: async () => {
        lifecycle.restart()
        return { ok: true, say: 'Restarting.' }
      },
    },
    {
      name: 'stop_jarvis',
      description: 'Shut JARVIS down.',
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'lifecycle',
      model: false,
      run: async () => {
        lifecycle.stop()
        return { ok: true, say: 'Shutting down.' }
      },
    },
  ]

  const byName = new Map(defs.map((d) => [d.name, d]))

  const reject = (name, origin, reason) => {
    state.rejected++
    state.last = String(name ?? '(none)').slice(0, 60)
    state.lastOk = false
    state.lastResult = `rejected: ${reason}`
    state.lastOrigin = origin
    state.lastRejection = reason
    console.warn(`[jarvis] tool ${state.last} from ${origin} rejected: ${reason}`)
    return { ok: false, rejected: true, tool: state.last, error: reason, say: "I can't do that." }
  }

  /**
   * @param {unknown} name
   * @param {unknown} rawArgs  object, or a JSON string from a model
   * @param {{ origin: 'router' | 'model' }} ctx
   */
  async function execute(name, rawArgs, { origin }) {
    if (typeof name !== 'string' || !byName.has(name)) return reject(name, origin, 'unknown tool')
    const def = byName.get(name)
    if (origin === 'model' && !def.model) return reject(name, origin, 'not available to the model')
    if (def.permission === 'write' && !allowWrites) return reject(name, origin, 'writes are disabled')
    let args = rawArgs ?? {}
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : {}
      } catch {
        return reject(name, origin, 'malformed arguments')
      }
    }
    const invalid = validateArgs(def.parameters, args) ?? def.extraCheck?.(args) ?? null
    if (invalid) return reject(name, origin, invalid)

    let result
    try {
      result = await def.run(args)
    } catch (err) {
      result = { ok: false, say: "That didn't work.", data: { error: String(err?.message ?? err) } }
    }
    state.executed++
    state.last = name
    state.lastOk = result.ok
    state.lastOrigin = origin
    state.lastResult = result.ok ? 'ok' : `failed${result.data?.error ? `: ${result.data.error}` : ''}`
    console.log(`[jarvis] tool ${name} (${origin}) -> ${result.ok ? 'ok' : 'not ok'}`)
    return { tool: name, ...result }
  }

  /** The model's menu: Ollama/OpenAI function-tool format, model-callable tools only. */
  const modelSchemas = () =>
    defs
      .filter((d) => d.model)
      .map((d) => ({
        type: 'function',
        function: {
          name: d.name,
          description: d.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(d.parameters.properties).map(([k, v]) => [k, { type: v.type, ...(v.description ? { description: v.description } : {}) }]),
            ),
            required: d.parameters.required,
          },
        },
      }))

  /** Would open_application find exactly one app for this name? Nothing is launched. */
  const canOpen = async (name) => {
    try {
      return (await catalogue.resolve(String(name))).status === 'found'
    } catch {
      return false
    }
  }

  return {
    execute,
    canOpen,
    modelSchemas,
    state,
    names: () => defs.map((d) => d.name),
    mode: allowWrites ? 'writes' : 'safe',
  }
}

function listOf(items, joiner = 'and') {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`
}
