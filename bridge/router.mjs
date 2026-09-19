/**
 * The deterministic intent layer: obvious requests never reach a model.
 *
 * "What time is it", "open Spotify", "search Google for X", "restart Jarvis" -
 * each has one correct action, and asking a language model to rediscover it
 * costs seconds and can only add ways to be wrong. So: normalise the sentence,
 * run a short list of small parsers, and hand back a tool call. Anything no
 * parser claims is conversational and goes to the local brain.
 *
 * route(text) -> { tool, args } | null
 */

import { safeUrl } from './tools.mjs'

/** Lowercase, wake phrase and politeness removed, punctuation trimmed. */
export function normalizeUtterance(text, { keepName = false } = {}) {
  let s = String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[?!。]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // "Hey Jarvis, ..." / "Jarvis ..." at the front.
  s = s.replace(/^(?:(?:hey|ok|okay|hi|yo)\s+)?jarvis\b[\s,.:;-]*/, '')
  // Politeness that changes nothing about the request.
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/^(?:please|so|um+|uh+|and|now|right|okay|ok)\b[\s,]*/, '')
      .replace(/^(?:could|can|would|will) you(?: please)?\s+/, '')
      .replace(/^(?:i want you to|i'd like you to|i would like you to|go ahead and|just)\s+/, '')
  }
  // A trailing "Jarvis" is usually just address ("what time is it, Jarvis"),
  // except where it is the object: "stop Jarvis" is not the same as "stop".
  const trailing = keepName ? /[\s,]+(?:please|for me|thanks|thank you)(?=[\s,.]*$)/g : /[\s,]+(?:please|for me|thanks|thank you|jarvis)(?=[\s,.]*$)/g
  s = s
    .replace(trailing, '')
    .replace(trailing, '')
    .replace(/[.,;:\s]+$/, '')
    .trim()
  return s
}

// --- small parsers, each owning one intent -------------------------------

const TIME = /^(?:what(?:'s| is)? the (?:current )?time(?: (?:now|right now))?|what time is it(?: now| right now)?|what time it is|tell me the time|(?:the )?(?:current )?time|got the time|do you have the time|time check)$/
const DATE =
  /^(?:what(?:'s| is)? (?:the |today's )?date(?: today)?|what date is it(?: today)?|what(?:'s| is) today(?:'s date)?|what day is (?:it|today)(?: today)?|which day is it|tell me the date|today's date|(?:the )?date(?: today)?)$/
const DIAGNOSTICS = /^(?:(?:show|open|display|run|bring up|pull up)(?: me)? (?:the )?(?:system )?diagnostics(?: panel)?|(?:system )?diagnostics)$/
const STATUS = /^(?:(?:system|systems) status|status report|how are (?:your|the) systems|(?:give me a |run a )?systems? check)$/
const GOOD_MORNING = /^(?:good morning|morning)$/
const START_TODAY = /^(?:start (?:today|the day|my day)|start my daily routine)$/
const START_WORKSPACE = /^start (?:my |the )?workspace$/
const GOOD_NIGHT = /^good night$/
const CONFIRM_GOOD_NIGHT = /^(?:confirm good night|good night confirmed)$/
const CANCEL_GOOD_NIGHT = /^(?:cancel good night|cancel (?:the )?sign ?out|don'?t sign (?:me )?out)$/
const RESTART = /^(?:restart|reboot|reload) (?:jarvis|yourself|the assistant)$/
const STOP = /^(?:(?:stop|shut down|shutdown|quit|exit|close|turn off) (?:jarvis|yourself|the assistant)|jarvis (?:shut down|shutdown|stop))$/
const REFRESH_APPS = /^(?:refresh|rescan|reload|update) (?:the |my )?(?:app|apps|application|applications|programs)(?: list| catalogue| catalog)?$/

const OPEN = /^(?:open|launch|start|run|fire up|bring up|load|start up|boot up) (?:up )?(.+)$/
const SEARCH = [
  /^(?:search|look up|lookup) (?:google|bing|the web|the internet|online|the net) for (.+)$/,
  /^(?:search|look) (?:for |up )?(.+?) (?:on|in|with) (?:google|bing|the web|the internet)$/,
  /^google (?:for )?(.+)$/,
  /^(?:search|search for|search the web for|web search|search online for|do a search for) (.+)$/,
]
const RESEARCH = /^(?:research|find out about|summari[sz]e the latest(?: on)?|what(?:'s| is) the latest (?:news )?(?:on|about|with)?|latest news (?:on|about)?) ?(.+)$/

/** "example dot com" -> "example.com", which is how speech recognition writes it. */
const spokenDomain = (s) => s.replace(/\s+dot\s+/g, '.').replace(/\s+slash\s+/g, '/').replace(/\s+/g, '')
const DOMAIN = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?$/i

/**
 * Websites JARVIS opens by name. A fixed, trusted table: the URL is looked up,
 * never composed, so an unknown name can't become an invented address.
 */
const KNOWN_SITES = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  'google drive': 'https://drive.google.com',
  'google calendar': 'https://calendar.google.com',
  'google maps': 'https://maps.google.com',
  github: 'https://github.com',
  reddit: 'https://www.reddit.com',
}
const SITE_ALIASES = {
  'you tube': 'youtube',
  'google mail': 'gmail',
  drive: 'google drive',
  calendar: 'google calendar',
  maps: 'google maps',
  'git hub': 'github',
}
/** "... in Google", "... in Chrome", "... in the browser" name where, not what. */
const IN_BROWSER = /\s+(?:in|on|using|with) (?:the |my )?(?:google chrome|google|chrome|(?:web )?browser)$/

/** The trusted URL for a spoken site name, or null. */
export function knownSite(name) {
  const key = String(name ?? '').toLowerCase().replace(IN_BROWSER, '').replace(/^(?:the|my)\s+/, '').replace(/\s+(?:website|site|app)$/, '').trim()
  return KNOWN_SITES[SITE_ALIASES[key] ?? key] ?? null
}

function cleanAppName(raw) {
  return raw
    .replace(/^(?:the|my|a|an|up)\s+/, '')
    .replace(/\s+(?:app|application|program|for me|now|up|please)$/, '')
    .replace(/\s+(?:app|application|program)$/, '')
    .trim()
}

/** The original text, with its capitalisation, for things said back aloud. */
function tail(original, normalizedTail) {
  const idx = original.toLowerCase().lastIndexOf(normalizedTail)
  return idx >= 0 ? original.slice(idx, idx + normalizedTail.length) : normalizedTail
}

export function route(text) {
  const original = String(text ?? '').trim()
  const s = normalizeUtterance(original)
  if (!s) return null

  const named = normalizeUtterance(original, { keepName: true })
  if (GOOD_MORNING.test(s)) return { tool: 'good_morning', args: {} }
  if (START_TODAY.test(s)) return { tool: 'start_today', args: {} }
  if (START_WORKSPACE.test(s)) return { tool: 'start_workspace', args: {} }
  if (GOOD_NIGHT.test(s)) return { tool: 'good_night', args: {} }
  if (CONFIRM_GOOD_NIGHT.test(s)) return { tool: 'confirm_good_night', args: {} }
  if (CANCEL_GOOD_NIGHT.test(s)) return { tool: 'cancel_good_night', args: {} }
  if (TIME.test(s)) return { tool: 'get_time', args: {} }
  if (DATE.test(s)) return { tool: 'get_date', args: {} }
  if (DIAGNOSTICS.test(s)) return { tool: 'show_diagnostics', args: {} }
  if (STATUS.test(s)) return { tool: 'get_system_status', args: {} }
  if (RESTART.test(named)) return { tool: 'restart_jarvis', args: {} }
  if (STOP.test(named)) return { tool: 'stop_jarvis', args: {} }
  if (REFRESH_APPS.test(s)) return { tool: 'refresh_applications', args: {} }

  let m = RESEARCH.exec(s)
  if (m && m[1]) return { tool: 'research_web', args: { query: tail(original, m[1]) } }

  for (const re of SEARCH) {
    m = re.exec(s)
    if (m && m[1]) return { tool: 'search_web', args: { query: tail(original, m[1]) } }
  }

  // "open YouTube" / "open Gmail in Chrome" / "go to Google Drive"
  m = /^(?:go to|visit|browse to|navigate to) (.+)$/.exec(s) ?? OPEN.exec(s)
  const site = m && knownSite(cleanAppName(m[1]))
  if (site) return { tool: 'open_url', args: { url: site } }

  // "go to example.com" / "open example dot com"
  m = /^(?:go to|visit|browse to|navigate to|open) (.+)$/.exec(s)
  if (m) {
    const candidate = spokenDomain(m[1])
    if (DOMAIN.test(candidate) && safeUrl(candidate)) return { tool: 'open_url', args: { url: candidate } }
  }

  m = OPEN.exec(s)
  if (m) {
    const name = cleanAppName(m[1])
    if (/^(?:the )?(?:system )?diagnostics$/.test(name)) return { tool: 'show_diagnostics', args: {} }
    // Keep the phrasing obvious: a short name, not a sentence ("start thinking
    // about dinner" is conversation, not a launch).
    if (name && name.split(' ').length <= 5 && !/\b(?:and|then|with|about|if|when|because)\b/.test(name)) {
      return { tool: 'open_application', args: { name: tail(original, name) } }
    }
  }
  return null
}

/**
 * The answer to a "which one?" question. Given the candidates JARVIS just
 * offered, does this utterance pick exactly one?
 */
export function pickChoice(text, candidates) {
  const s = normalizeUtterance(text)
    .replace(/^(?:open|launch|start|the|use)\s+/, '')
    .replace(/^(?:the )/, '')
    .trim()
  if (!s || !candidates?.length) return null
  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth']
  const ord = ordinals.findIndex((o) => s === o || s === `${o} one`)
  if (ord >= 0 && ord < candidates.length) return candidates[ord]
  if (/^(?:no|none|neither|cancel|never mind|forget it)\b/.test(s)) return false
  const lower = candidates.map((c) => c.toLowerCase())
  const exact = lower.indexOf(s)
  if (exact >= 0) return candidates[exact]
  const partial = candidates.filter((c, i) => lower[i].includes(s))
  return partial.length === 1 ? partial[0] : null
}
