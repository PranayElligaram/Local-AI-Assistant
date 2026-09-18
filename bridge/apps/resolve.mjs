/**
 * Turning a spoken application name into ONE catalogue entry - or refusing to.
 *
 * Priority, strictly in this order:
 *   1. exact normalized name
 *   2. alias (the user's own first, then the built-in table)
 *   3. strong token / prefix match
 *   4. conservative fuzzy match
 *
 * The rule that matters most: when several plausible candidates exist, JARVIS
 * does not guess. "Open Visual Studio" with both Visual Studio Code and Visual
 * Studio Installer present comes back as a question, not a launch. A fuzzy
 * match that is merely close comes back as "did you mean", never as a launch.
 */

/** Lowercase, accent-free, punctuation-free, single-spaced. */
export function normalizeName(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\.(exe|lnk|appref-ms)$/i, '')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Words that never distinguish one app from another. */
const VENDOR = new Set(['microsoft', 'google', 'mozilla', 'adobe', 'windows', 'the', 'app', 'application', 'desktop'])
/** Words that mark a build variant of the same app rather than a different app. */
const VARIANT = new Set(['x64', 'x86', '64', '32', 'bit', '64bit', '32bit', 'classic', 'preview'])

const tokens = (key) => key.split(' ').filter(Boolean)
const core = (key) => tokens(key).filter((t) => !VENDOR.has(t) && !VARIANT.has(t))
const variantKey = (key) => core(key).join(' ')

/**
 * Built-in aliases. Each maps spoken names to the display names they mean, in
 * preference order; the first one present in the catalogue wins. These are
 * CONVENIENCES on top of discovery, not an allowlist - an app missing from this
 * table is still found by its own name.
 */
export const BUILTIN_ALIASES = [
  { say: ['vs code', 'vscode', 'code', 'visual studio code'], names: ['Visual Studio Code'] },
  { say: ['chrome', 'google chrome'], names: ['Google Chrome', 'Chrome'] },
  { say: ['edge', 'msedge', 'microsoft edge'], names: ['Microsoft Edge'] },
  { say: ['word', 'microsoft word', 'ms word', 'winword'], names: ['Word', 'Microsoft Word'] },
  { say: ['excel', 'microsoft excel'], names: ['Excel', 'Microsoft Excel'] },
  { say: ['powerpoint', 'power point', 'microsoft powerpoint', 'powerpnt'], names: ['PowerPoint', 'Microsoft PowerPoint'] },
  { say: ['outlook', 'microsoft outlook'], names: ['Outlook', 'Microsoft Outlook', 'Outlook (classic)'] },
  { say: ['teams', 'microsoft teams'], names: ['Microsoft Teams'] },
  { say: ['terminal', 'windows terminal'], names: ['Terminal', 'Windows Terminal'] },
  { say: ['powershell', 'windows powershell'], names: ['Windows PowerShell', 'PowerShell'] },
  { say: ['cmd', 'command prompt'], names: ['Command Prompt'] },
  { say: ['calculator', 'calc'], names: ['Calculator'] },
  { say: ['explorer', 'file explorer', 'windows explorer', 'my files'], names: ['File Explorer'] },
  { say: ['paint', 'mspaint', 'ms paint'], names: ['Paint'] },
  { say: ['notepad'], names: ['Notepad'] },
  { say: ['settings', 'windows settings', 'pc settings'], names: ['Settings'] },
  { say: ['task manager', 'taskmgr'], names: ['Task Manager'] },
  { say: ['spotify', 'spotify music'], names: ['Spotify'] },
  { say: ['store', 'microsoft store', 'app store'], names: ['Microsoft Store'] },
]

/** Edit distance, for the conservative fuzzy tier. */
export function similarity(a, b) {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

/** Launch without asking at or above this; suggest (never launch) above SUGGEST. */
export const FUZZY_LAUNCH = 0.88
export const FUZZY_SUGGEST = 0.7

/** One entry per distinct app: same name AND same target. Two "Calendar" apps stay two. */
const unique = (entries) => [...new Map(entries.map((e) => [`${e.key}|${e.target}`, e])).values()]

/**
 * When the best matches are really one app in several builds ("Windows
 * PowerShell" and "Windows PowerShell (x86)"), take the plainest. When they are
 * different apps, or different versions ("Python 3.12" and "Python 3.13"), ask.
 */
function settle(candidates, method) {
  const list = unique(candidates)
  if (list.length === 1) return { status: 'found', app: list[0], method }
  const groups = new Set(list.map((e) => variantKey(e.key)))
  // Identical names with different targets are different apps that happen to
  // share a name (two "Calendar"s) - never variants of one.
  const sameName = new Set(list.map((e) => e.key)).size < list.length
  if (groups.size === 1 && !sameName) {
    const plainest = [...list].sort((a, b) => a.key.length - b.key.length)[0]
    return { status: 'found', app: plainest, method }
  }
  return { status: 'ambiguous', candidates: list.map((e) => e.name).slice(0, 5), method }
}

/**
 * @param {string} query            what the user said the app was called
 * @param {Array} entries           catalogue entries: { name, key, aliases[] }
 * @param {Record<string,string>} [userAliases]  alias -> app name (jarvis.apps.json)
 */
export function resolveApp(query, entries, userAliases = {}) {
  const q = normalizeName(query)
  if (!q) return { status: 'not_found', query }

  // 1. exact name
  const exact = entries.filter((e) => e.key === q)
  if (exact.length) return settle(exact, 'exact')

  // 2. aliases: the user's, then entry aliases (which carry the built-ins)
  for (const [alias, target] of Object.entries(userAliases)) {
    if (normalizeName(alias) !== q) continue
    const t = normalizeName(target)
    const hit = entries.filter((e) => e.key === t || e.aliases?.includes(t))
    if (hit.length) return settle(hit, 'user-alias')
  }
  const aliased = entries.filter((e) => e.aliases?.includes(q))
  if (aliased.length) return settle(aliased, 'alias')

  // 3. strong token / prefix match: every meaningful word said is a word of
  //    the name, scored by how much of the name it covers.
  const said = core(q).length ? core(q) : tokens(q)
  const scored = []
  for (const e of entries) {
    const words = tokens(e.key)
    const meaningful = core(e.key).length ? core(e.key) : words
    const allPresent = said.every((t) => words.includes(t))
    const prefix = e.key.startsWith(q + ' ')
    if (!allPresent && !prefix) continue
    scored.push({ e, score: said.filter((t) => meaningful.includes(t)).length / meaningful.length })
  }
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0].score
    const top = scored.filter((s) => s.score === best).map((s) => s.e)
    const runnerUp = scored.find((s) => s.score < best)?.score ?? 0
    // Clear winner: the whole meaningful name was said, or it covers much
    // more of its name than anything else does.
    if (best === 1 || best - runnerUp >= 0.34) return settle(top, 'token')
    return {
      status: 'ambiguous',
      candidates: unique(scored.map((s) => s.e)).map((e) => e.name).slice(0, 5),
      method: 'token',
    }
  }

  // 4. fuzzy, for mis-hearings ("spotfy"). Launch only when it is both close
  //    and unique; otherwise at most a suggestion.
  const fuzzy = entries
    .map((e) => ({ e, score: Math.max(similarity(q, e.key), ...(e.aliases ?? []).map((a) => similarity(q, a))) }))
    .filter((s) => s.score >= FUZZY_SUGGEST)
    .sort((a, b) => b.score - a.score)
  if (fuzzy.length) {
    const [first, second] = fuzzy
    const clear = !second || first.score - second.score >= 0.08
    if (first.score >= FUZZY_LAUNCH && clear) return { status: 'found', app: first.e, method: 'fuzzy' }
    return { status: 'suggest', candidates: unique(fuzzy.map((s) => s.e)).map((e) => e.name).slice(0, 3), method: 'fuzzy' }
  }
  return { status: 'not_found', query }
}
