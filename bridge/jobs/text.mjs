/**
 * Plain text out of job-board HTML. Deliberately small: tags become breaks or
 * spaces, the common entities are decoded, scripts and styles are dropped.
 * Nothing here executes or renders anything.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', pound: '£', euro: '€', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', bull: '•' }

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function htmlToText(html, maxChars = 60_000) {
  let s = String(html ?? '')
  // Greenhouse returns its content entity-encoded once.
  if (/&lt;[a-z/]/i.test(s) && !/<[a-z/]/i.test(s)) s = decodeEntities(s)
  s = s
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s.length > maxChars ? s.slice(0, maxChars) : s
}

/** Lowercase, punctuation-free, single-spaced: for comparisons, never for display. */
export function normalizeKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Short stable hash (FNV-1a, 32-bit) for fingerprints and ids. Not security-relevant. */
export function fnv1a(s) {
  let h = 0x811c9dc5
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}
