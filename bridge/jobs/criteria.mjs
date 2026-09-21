/**
 * The canonical job-search requirements, as code.
 *
 * evaluate(job) -> {
 *   decision: 'QUALIFIED' | 'REJECTED',
 *   fitScore,        0-100 in steps of 5: genuine fit, not keyword overlap
 *   rankScore,       fit adjusted for how likely an interview/offer is and how
 *                    cheap the application is (freshness, ease, interview
 *                    burden, salary, start date)
 *   fitReasons, exclusionReasons, experience, roleFamily, location,
 *   applicationDifficulty, interviewDifficulty, salary, ...
 * }
 *
 * Rules that are easy to get wrong, and are therefore tested:
 *   - "2+ years preferred" is not "2+ years required". Experience mentions are
 *     classified per sentence and per section heading as mandatory, preferred
 *     or ambiguous. More than 2 MANDATORY years is a hard reject; an ambiguous
 *     mention is treated conservatively, as mandatory.
 *   - "PhD" under preferred/optional qualifications is not a rejection.
 *   - Unknown salary and unknown interview process are UNKNOWN, never guessed.
 *   - Low salary and heavy interviews move the rank; they do not reject.
 */

import { normalizeKey } from './text.mjs'

export const DEFAULT_SKILLS = [
  'python', 'django', 'rest', 'api', 'backend', 'git', 'github', 'github actions', 'ci/cd', 'automated testing',
  'unit test', 'pytest', 'machine learning', 'ai', 'tensorflow', 'keras', 'reinforcement learning', 'llm',
  'generative ai', 'full-stack', 'full stack', 'webhook', 'ros2', 'ros 2', 'moveit', 'prototyp', 'sql',
]

// --- sentence classification ------------------------------------------------

const PREFERRED = /\b(prefer(?:red|ably)?|nice[- ]to[- ]have|bonus|desirable|ideally|a plus|advantageous|would be (?:great|nice|beneficial)|beneficial|not (?:required|essential|necessary|mandatory)|optional|helpful|great if|plus if|an advantage|good to have)\b/i
const MANDATORY = /\b(required|requirement|must|minimum|at least|essential|mandatory|need(?:s|ed)? to have|you (?:will )?(?:have|bring|need)|we require|necessary|proven)\b/i
const PREFERRED_HEADING = /^(?:[•*-]\s*)?(?:nice[- ]to[- ]haves?|bonus(?: points)?|preferred(?: qualifications| skills| experience)?|desirable(?: skills| criteria)?|(?:it'?s )?great if you (?:also )?have|good to have|what would be nice|additional|optional)\b[^.\n]{0,40}:?$/i
const MANDATORY_HEADING = /^(?:[•*-]\s*)?(?:requirements|required(?: qualifications| skills| experience)?|essential(?: skills| criteria)?|minimum qualifications|what (?:you'?ll|you will) need|what we(?:'re| are) looking for|who you are|about you|you (?:have|will have|bring)|must haves?|qualifications|skills (?:and|&) experience|key requirements)\b[^.\n]{0,40}:?$/i
const ANY_HEADING = /^[^.•\n]{2,60}:?$/

const WORD_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const YEARS = /\b(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s*)?(?:\+\s*)?(?:years?|yrs?)(?:'|’)?\b/gi
const EXPERIENCE_CONTEXT = /\b(experience|experienced|commercial|professional|industry|industrial|work(?:ing)?|in (?:a|an) (?:similar|engineering|software))\b/i
const NOT_CANDIDATE = /\b(we(?:'ve| have) been|founded|history|company|for over|years? old|anniversary|track record of (?:the|our)|our (?:team|company|clients?))\b/i

const toNum = (s) => (s == null ? null : /^\d+$/.test(s) ? Number(s) : WORD_NUM[String(s).toLowerCase()] ?? null)

/** Split into sentence-ish units, remembering the section heading each sits under. */
export function units(description) {
  const out = []
  let section = 'none'
  for (const rawLine of String(description ?? '').split(/\n+/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (ANY_HEADING.test(line) && !/\d/.test(line.replace(/\d+\s*(?:years?|yrs?)/i, ''))) {
      if (PREFERRED_HEADING.test(line)) section = 'preferred'
      else if (MANDATORY_HEADING.test(line)) section = 'mandatory'
      else if (!/^[•*-]/.test(line) && line.length < 60 && !/\byears?\b/i.test(line)) section = 'none'
      if (!/\byears?\b/i.test(line)) continue
    }
    for (const sentence of line.split(/(?<=[.;!?])\s+(?=[A-Z•])/)) out.push({ text: sentence, section })
  }
  return out
}

/** Classify one unit: 'mandatory' | 'preferred' | 'ambiguous'. */
export function classifyUnit({ text, section }) {
  if (PREFERRED.test(text)) return 'preferred'
  if (MANDATORY.test(text)) return 'mandatory'
  if (section === 'preferred') return 'preferred'
  if (section === 'mandatory') return 'mandatory'
  return 'ambiguous'
}

/**
 * Years of experience asked for. Each mention takes the lower bound of its
 * range ("2-4 years" asks for 2).
 */
export function parseExperience(description) {
  const mentions = []
  for (const u of units(description)) {
    if (!EXPERIENCE_CONTEXT.test(u.text) || NOT_CANDIDATE.test(u.text)) continue
    for (const m of u.text.matchAll(YEARS)) {
      const years = toNum(m[1])
      if (years == null || years > 20) continue
      mentions.push({ years, kind: classifyUnit(u), text: u.text.slice(0, 160) })
    }
  }
  const max = (kind) => {
    const ys = mentions.filter((m) => m.kind === kind).map((m) => m.years)
    return ys.length ? Math.max(...ys) : null
  }
  const mandatoryYears = max('mandatory')
  const preferredYears = max('preferred')
  const ambiguousYears = max('ambiguous')
  // Conservative: an unqualified "3+ years of experience" is read as required.
  const effectiveRequired = Math.max(mandatoryYears ?? -1, ambiguousYears ?? -1)
  return {
    mandatoryYears,
    preferredYears,
    ambiguousYears,
    requiredYears: effectiveRequired < 0 ? null : effectiveRequired,
    mentions: mentions.slice(0, 8),
  }
}

// --- title / role family ----------------------------------------------------

const SENIOR_TITLE = /\b(senior|sr|lead|staff|principal|head of|director|vp|vice president|chief|manager|architect|distinguished|expert)\b/
const JUNIOR_TITLE = /\b(graduate|grad|junior|jr|entry[ -]level|entry|new grad|early careers?|associate|trainee|apprentice|intern(?:ship)?|placement|level 1|l1|i)\b/
const MID_TITLE = /\b(ii|iii|iv|mid|mid level|intermediate|experienced|level 2|level 3|l2|l3)\b/

const FAMILIES = [
  { family: 'ai-engineering', strong: true, re: /\b(ai|a i|artificial intelligence|llm|genai|generative ai|gen ai|applied ai|machine learning|ml|deep learning|nlp|agentic|ai native)\b.*\b(engineer|developer|programmer)\b|\b(engineer|developer)\b.*\b(ai|llm|genai|machine learning|ml)\b/ },
  { family: 'software-engineering', strong: true, re: /\b(software|backend|back end|full stack|fullstack|full-stack|python|django|api|platform|web|application|applications)\b.*\b(engineer|developer|programmer)\b|\bswe\b|\bsde\b|\bsoftware development engineer\b/ },
  { family: 'robotics-software', strong: true, re: /\brobotics?\b.*\b(software|engineer|developer)\b/ },
  { family: 'rnd-prototyping', strong: true, re: /\b(r and d|r&d|research and development|prototyping|prototype)\b.*\b(engineer|developer)\b/ },
  { family: 'automation', strong: false, re: /\b(automation|intelligent automation|rpa)\b.*\b(engineer|developer)\b/ },
  { family: 'general-engineering', strong: false, re: /\b(engineer|developer|programmer)\b/ },
]

const EXCLUDED_FAMILIES = [
  { reason: 'pure data analyst role', re: /\b(data|bi|business intelligence|insights?|reporting|product|marketing) analyst\b/, unless: /\b(engineer|developer)\b/ },
  { reason: 'pure business analyst role', re: /\bbusiness analyst\b/, unless: /\b(engineer|developer)\b/ },
  { reason: 'sales role', re: /\b(sales|account executive|account manager|business development|bdr|sdr|pre sales|presales|solutions consultant)\b/ },
  { reason: 'customer support role', re: /\b(customer support|customer success|support specialist|support engineer|technical support|help ?desk|service desk|support analyst)\b/ },
  { reason: 'manual QA-only role', re: /\b(manual (?:qa|tester|testing|test)|qa tester|test analyst|qa analyst)\b/, unless: /\bautomation\b/ },
  { reason: 'research scientist role', re: /\b(research scientist|researcher|research fellow|postdoc|post doctoral)\b/ },
  { reason: 'data scientist role (not a target family)', re: /\bdata scientist\b/ },
  { reason: 'heavy production MLOps/SRE role', re: /\b(mlops|ml ops|ml platform|site reliability|sre|devops|infrastructure engineer)\b/, unless: /\b(graduate|junior|entry)\b/ },
]

export function classifyTitle(title) {
  const t = normalizeKey(title)
  const excluded = []
  if (SENIOR_TITLE.test(t)) excluded.push('senior/lead/manager title')
  for (const x of EXCLUDED_FAMILIES) if (x.re.test(t) && !(x.unless && x.unless.test(t))) excluded.push(x.reason)
  const seniority = JUNIOR_TITLE.test(t) ? 'junior' : MID_TITLE.test(t) ? 'mid' : 'unspecified'
  const fam = FAMILIES.find((f) => f.re.test(t))
  return { seniority, family: fam?.family ?? null, strongFamily: Boolean(fam?.strong), excluded, isIntern: /\bintern(?:ship)?\b|\bplacement\b/.test(t) }
}

// --- location ---------------------------------------------------------------

const LONDON = /\b(london|greater london|city of london|shoreditch|canary wharf|kings cross|king's cross|farringdon|clerkenwell|islington|camden|southwark|westminster|hammersmith|white city|stratford|holborn|soho|bermondsey|croydon|wimbledon|paddington|old street|liverpool street|mayfair|aldgate|ec[1-4][a-z]?|wc[12][a-z]?|e1[0-9]?|n1|se1|sw1|w1)\b/i
const UK = /\b(uk|u\.k\.|united kingdom|england|great britain|gb|britain|scotland|wales)\b/i
const REMOTE = /\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b/i
const HYBRID = /\bhybrid\b/i

export function classifyLocation(location, workplaceType, description = '') {
  const loc = String(location ?? '')
  const wp = String(workplaceType ?? '').toLowerCase()
  if (!loc.trim() && !wp) return { fit: 'unknown', label: 'Location not stated' }
  const london = LONDON.test(loc)
  const remote = wp === 'remote' || (REMOTE.test(loc) && !london)
  if (london) {
    const hybrid = wp === 'hybrid' || HYBRID.test(loc) || HYBRID.test(String(description).slice(0, 4000))
    return { fit: hybrid ? 'london-hybrid' : 'london', label: hybrid ? 'Yes — London hybrid' : 'Yes — London' }
  }
  if (remote && (UK.test(loc) || /\b(uk|united kingdom)\b/i.test(String(description).slice(0, 4000)) || !loc.replace(REMOTE, '').trim())) {
    // "Remote" with nothing else could be anywhere; only an explicit UK signal counts.
    if (UK.test(loc) || /\bremote\b[^.\n]{0,40}\b(uk|united kingdom)\b|\b(uk|united kingdom)\b[^.\n]{0,40}\bremote\b/i.test(String(description).slice(0, 6000))) {
      return { fit: 'uk-remote', label: 'UK remote' }
    }
    return { fit: 'unknown-remote', label: 'Remote, country unclear' }
  }
  return { fit: 'elsewhere', label: loc.slice(0, 80) }
}

// --- salary -----------------------------------------------------------------

const SALARY = /£\s?(\d{2,3}(?:[,.]\d{3})?|\d{2,3}(?:\.\d)?\s?k)\s*(?:k\b)?(?:\s*(?:-|–|to)\s*£?\s?(\d{2,3}(?:[,.]\d{3})?|\d{2,3}(?:\.\d)?\s?k)\s*(?:k\b)?)?/i

function toPounds(raw) {
  const s = String(raw).toLowerCase().replace(/\s/g, '')
  if (s.endsWith('k')) return Math.round(parseFloat(s) * 1000)
  const n = Number(s.replace(/[,.]/g, ''))
  return n < 1000 ? n * 1000 : n
}

/** { min, max, currency, known } — from structured data when the source has it, else the text. */
export function parseSalary(job) {
  if (job.salary && Number.isFinite(job.salary.min)) {
    return { min: job.salary.min, max: job.salary.max ?? job.salary.min, currency: job.salary.currency ?? job.currency ?? 'GBP', known: true }
  }
  const text = String(job.description ?? '')
  const m = SALARY.exec(text)
  if (!m) return { min: null, max: null, currency: null, known: false }
  const context = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)
  if (/\b(per|an|a) (hour|day)\b|\/\s?(hr|hour|day)\b|daily rate|hourly/i.test(context)) return { min: null, max: null, currency: null, known: false }
  const min = toPounds(m[1])
  const max = m[2] ? toPounds(m[2]) : min
  if (min < 10_000 || min > 400_000) return { min: null, max: null, currency: null, known: false }
  return { min, max, currency: 'GBP', known: true }
}

// --- application and interview burden --------------------------------------

const HEAVY_INTERVIEW = [
  ['leetcode-style', /\bleet ?code|hackerrank|codility|codesignal|competitive programming\b/i],
  ['algorithms/DSA', /\b(data structures (?:and|&) algorithms|algorithmic (?:interview|test|challenge)|dsa)\b/i],
  ['system design', /\bsystem design (?:interview|round|stage)\b/i],
  ['take-home', /\btake[- ]home\b/i],
  ['assessment centre', /\bassessment (?:centre|center|day)\b/i],
  ['online test', /\b(online (?:test|assessment)|numerical reasoning|verbal reasoning|psychometric|situational judg(?:e)?ment)\b/i],
]
const LIGHT_INTERVIEW = [
  ['project discussion', /\b(discuss (?:a |your )?(?:past |previous )?projects?|project (?:discussion|walkthrough|deep[- ]dive))\b/i],
  ['practical coding', /\b(pair programming|practical (?:coding|exercise|session)|debugging (?:session|exercise))\b/i],
  ['behavioural', /\b(behaviou?ral interview|values interview|culture (?:fit|interview))\b/i],
  ['short process', /\b(two|2)[- ](?:stage|step|round)s? (?:interview|process)|(?:interview|hiring) process[^.]{0,40}\b(two|2) (?:stages|steps|rounds)\b|no (?:coding|technical) test|no take[- ]home\b/i],
]

export function interviewBurden(description) {
  const text = String(description ?? '')
  const heavy = HEAVY_INTERVIEW.filter(([, re]) => re.test(text)).map(([n]) => n)
  const light = LIGHT_INTERVIEW.filter(([, re]) => re.test(text)).map(([n]) => n)
  const rounds = /\b(\d|four|five|six)\s*(?:-|–)?\s*(?:stage|round|step)s?\b/i.exec(text)
  const n = rounds ? toNum(rounds[1]) : null
  if (n != null && n >= 4) heavy.push(`${n} rounds`)
  if (!heavy.length && !light.length) return { level: 'UNKNOWN', signals: [] }
  if (heavy.length >= 2 || heavy.includes('assessment centre')) return { level: 'HEAVY', signals: [...heavy, ...light] }
  if (heavy.length) return { level: 'MODERATE', signals: [...heavy, ...light] }
  return { level: 'LIGHT', signals: light }
}

const STANDARD_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'teamtailor', 'smartrecruiters', 'recruitee', 'personio'])

export function applicationDifficulty(job) {
  const text = String(job.description ?? '')
  const negatives = []
  if (/\bcover letter (?:is )?(?:required|mandatory|must)\b|\bmust (?:include|submit|attach) a cover letter\b/i.test(text)) negatives.push('cover letter required')
  if (/\bassessment (?:centre|center|day)\b/i.test(text)) negatives.push('assessment centre')
  if (/\b(coding challenge|technical test|online (?:test|assessment)|hackerrank|codility|take[- ]home)\b/i.test(text)) negatives.push('assessment/test')
  if (/\b(personal statement|essay|motivational letter|written (?:questions|responses))\b/i.test(text)) negatives.push('written answers')
  if (/\bworkday|taleo|successfactors|oracle cloud|icims|brassring\b/i.test(String(job.applicationUrl ?? ''))) negatives.push('complex portal / account creation')
  const freeText = Number(job.formQuestions?.freeTextRequired ?? 0)
  if (freeText >= 3) negatives.push(`${freeText} required free-text questions`)
  const standard = STANDARD_ATS.has(String(job.source ?? '').split(':')[0])
  if (negatives.length >= 2 || negatives.includes('assessment centre')) return { level: 'HARD', signals: negatives }
  if (negatives.length === 1) return { level: 'MEDIUM', signals: negatives }
  if (standard) return { level: 'EASY', signals: ['standard ATS form'] }
  return { level: 'UNKNOWN', signals: [] }
}

// --- start date -------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

export function startTiming(description, now = new Date()) {
  const text = String(description ?? '')
  if (/\b(start(?:ing)? (?:immediately|asap|as soon as possible)|immediate start)\b/i.test(text)) return { timing: 'immediate', monthsAway: 0 }
  const m = /\b(?:start(?:ing|s)?|join(?:ing)?|intake|cohort|commenc\w*)\b[^.\n]{0,40}?\b(january|february|march|april|may|june|july|august|september|october|november|december|summer|autumn|spring|winter)\s+(20\d\d)\b/i.exec(text)
  if (!m) return { timing: 'unknown', monthsAway: null }
  const season = { summer: 6, autumn: 8, spring: 2, winter: 11 }
  const month = MONTHS.indexOf(m[1].toLowerCase())
  const idx = month >= 0 ? month : season[m[1].toLowerCase()]
  const monthsAway = (Number(m[2]) - now.getFullYear()) * 12 + (idx - now.getMonth())
  return { timing: monthsAway > 9 ? 'distant' : monthsAway < -1 ? 'past' : 'near', monthsAway }
}

// --- the evaluation ---------------------------------------------------------

const JUNIOR_TEXT = /\b(graduates?|new grads?|recent grad(?:uate)?s?|early[- ]careers?|entry[- ]level|junior|0\s*(?:-|–|to)\s*[12] years?|no (?:prior |commercial )?experience (?:is )?(?:required|necessary)|first (?:engineering |software )?role)\b/i
const MENTORING_JUNIORS = /\b(?:mentor|mentoring|mentors|coach|coaching|support|supporting|guide|guiding|lead|leading|manage|managing|grow|growing)\b[^.\n]{0,30}\bjunior\b/gi
const PHD = /\b(ph\.?\s?d|doctorate|doctoral)\b/i
const MASTERS = /\b(master'?s|msc|m\.sc|postgraduate degree)\b/i
const OWNERSHIP = /\b(own(?:ing)? the (?:technical )?(?:architecture|roadmap|technical direction)|set(?:ting)? (?:the )?technical direction|technical ownership of|lead the (?:design|architecture)|architect(?:ing)? (?:our|the) (?:platform|systems?)|mentor(?:ing|s)? (?:junior|other|more junior|less experienced)\b)\b/gi
const OTHER_LANGS = /\b(java|c\+\+|c#|golang|go|rust|scala|kotlin|swift|ruby|php|elixir|haskell|ocaml)\b/i
const CLEARANCE = /\b(sc|dv|security) clearance\b[^.\n]{0,40}\b(required|must|essential|eligible)|\b(must|required to) (?:hold|obtain) (?:sc|dv|security) clearance\b/i

// Capped at 95: a keyword-derived score never claims a perfect fit.
const round5 = (n) => Math.max(0, Math.min(95, Math.round(n / 5) * 5))

/**
 * @param {object} job   a normalised job record (see types.mjs)
 * @param {{ minFitScore?: number, maxJobAgeDays?: number, now?: Date, skills?: string[] }} [opts]
 */
export function evaluate(job, opts = {}) {
  const { minFitScore = 70, maxJobAgeDays = 90, now = new Date(), skills = DEFAULT_SKILLS } = opts
  const description = String(job.description ?? '')
  const lower = description.toLowerCase()
  const exclusions = []
  const reasons = []

  // Title and family
  const title = classifyTitle(job.title)
  exclusions.push(...title.excluded)
  if (!title.family) exclusions.push('not a target engineering role family')

  // Experience
  const exp = parseExperience(description)
  if (exp.mandatoryYears != null && exp.mandatoryYears > 2) exclusions.push(`requires ${exp.mandatoryYears}+ years mandatory experience`)
  else if (exp.ambiguousYears != null && exp.ambiguousYears > 2) exclusions.push(`asks for ${exp.ambiguousYears}+ years experience without saying it is optional (treated as required)`)

  // PhD: only when genuinely required.
  const phdUnits = units(description).filter((u) => PHD.test(u.text))
  const phdRequired = phdUnits.some((u) => classifyUnit(u) === 'mandatory' && !/\bor (?:equivalent|a (?:bachelor|master|bsc|msc)|bachelor|master)|\b(?:bachelor|bsc|master|msc)[^.]{0,30}\bor ph\.?\s?d/i.test(u.text))
  if (phdRequired) exclusions.push('PhD required')
  if (/\b(first[- ]author|publication record|publications? (?:at|in) (?:top|leading)|neurips|icml|iclr)\b/i.test(description) && /\bresearch\b/i.test(job.title ?? '')) exclusions.push('research-scientist level (publication record expected)')

  // Unpaid
  if (/\bunpaid\b|\bvoluntary (?:role|position)\b|\bexpenses only\b/i.test(`${job.title} ${description}`)) exclusions.push('unpaid role')

  // Architecture ownership expected
  const ownership = description.match(OWNERSHIP) ?? []
  if (ownership.length >= 2 && title.seniority !== 'junior') exclusions.push('expects major architecture / technical ownership')

  // Freshness: age is a ranking factor; only a very old posting is excluded
  // (usually an evergreen pipeline requisition rather than a real opening).
  if (job.postedDate) {
    const ageDays = (now - new Date(job.postedDate)) / 86_400_000
    if (Number.isFinite(ageDays) && ageDays > maxJobAgeDays) exclusions.push(`posted ${Math.round(ageDays)} days ago (older than ${maxJobAgeDays})`)
  }
  if (job.open === false) exclusions.push('vacancy closed')

  // Location
  const loc = classifyLocation(job.location, job.workplaceType, description)
  if (loc.fit === 'elsewhere') exclusions.push(`location outside London (${loc.label})`)
  if (loc.fit === 'unknown' || loc.fit === 'unknown-remote') exclusions.push('location not clearly London or UK')

  // --- fit components (sum to 100) ---
  let seniority
  if (title.seniority === 'junior') seniority = 20
  else if (title.seniority === 'mid') seniority = 5
  else seniority = exp.requiredYears == null ? 10 : exp.requiredYears <= 1 ? 14 : 10
  if (title.isIntern) seniority = Math.min(seniority, 12)

  let experience = 15
  if (exp.requiredYears === 2) experience = 10
  else if (exp.requiredYears != null && exp.requiredYears > 2) experience = 0
  if (exp.preferredYears != null && exp.preferredYears >= 3) experience -= 3

  const family = title.family ? (title.strongFamily ? 20 : title.family === 'automation' && /\bpython\b/.test(lower) ? 16 : 12) : 0

  const matched = skills.filter((s) => (s.length <= 3 ? new RegExp(`\\b${s.replace(/[/]/g, '\\/')}\\b`, 'i').test(description) : lower.includes(s)))
  let technical = Math.min(25, 7 + matched.length * 3)
  const langUnits = units(description).filter((u) => OTHER_LANGS.test(u.text) && classifyUnit(u) === 'mandatory' && !/\bpython\b/i.test(u.text))
  if (langUnits.length && !/\bpython\b/i.test(description)) technical -= 10
  if (!description.trim()) technical = 5

  const location = { london: 10, 'london-hybrid': 10, 'uk-remote': 6 }[loc.fit] ?? 0

  let education = 5
  const mastersRequired = units(description).some((u) => MASTERS.test(u.text) && classifyUnit(u) === 'mandatory' && !/\bor\b/i.test(u.text))
  if (mastersRequired) education = 2
  if (phdRequired) education = 0

  let mandatory = 5
  if (CLEARANCE.test(description)) mandatory -= 3
  if (ownership.length === 1) mandatory -= 2

  let fitScore = round5(seniority + Math.max(0, experience) + family + Math.max(0, technical) + location + education + Math.max(0, mandatory))

  // The target is graduate/junior. A title that does not say so needs the
  // description to (or an explicit <=2-year requirement); a II/III title is mid-level.
  // "Mentor junior engineers" is a seniority signal, not a junior one.
  const juniorSignals = JUNIOR_TEXT.test(description.replace(MENTORING_JUNIORS, ' '))
  if (title.seniority === 'mid') {
    fitScore = Math.min(fitScore, 60)
    reasons.push('mid-level title (II/III)')
  } else if (title.seniority === 'unspecified' && !juniorSignals && exp.requiredYears == null) {
    fitScore = Math.min(fitScore, 65)
    reasons.push('seniority not stated as graduate/junior')
  } else if (title.seniority === 'unspecified' && juniorSignals) {
    reasons.push('description targets graduates/early careers')
  }

  // UK remote is retained only for unusually strong roles.
  if (loc.fit === 'uk-remote' && fitScore < 85) exclusions.push('UK remote, and not strong enough to justify a non-London role')

  // --- rank: probability of interview/offer, and cost of applying ---
  const salary = parseSalary(job)
  const interview = interviewBurden(description)
  const ease = applicationDifficulty(job)
  const start = startTiming(description, now)
  let rank = fitScore
  const rankNotes = []
  const add = (n, note) => {
    rank += n
    rankNotes.push(`${n > 0 ? '+' : ''}${n} ${note}`)
  }
  if (job.postedDate) {
    const age = (now - new Date(job.postedDate)) / 86_400_000
    if (age <= 7) add(8, 'posted this week')
    else if (age <= 14) add(4, 'posted within two weeks')
    else if (age > 60) add(-10, 'posted over two months ago')
    else if (age > 30) add(-5, 'older posting')
  }
  add({ EASY: 6, MEDIUM: 0, HARD: -8, UNKNOWN: 0 }[ease.level], `application ${ease.level.toLowerCase()}`)
  add({ LIGHT: 5, MODERATE: -3, HEAVY: -8, UNKNOWN: 0 }[interview.level], `interview ${interview.level.toLowerCase()}`)
  if (salary.known) {
    if (salary.max >= 45_000) add(4, 'competitive salary')
    else if (salary.max <= 27_000) add(-12, 'unusually low salary')
    else if (salary.max < 35_000) add(-4, 'below-typical salary')
  }
  if (start.timing === 'immediate') add(3, 'immediate start')
  else if (start.timing === 'near') add(1, 'near-term start')
  else if (start.timing === 'distant') add(-5, 'distant start date')

  if (title.seniority === 'junior') reasons.push('graduate/junior positioning')
  if (title.strongFamily) reasons.push(`target family: ${title.family}`)
  if (exp.requiredYears == null) reasons.push('no mandatory experience stated')
  else reasons.push(`${exp.requiredYears} year(s) mandatory experience`)
  if (exp.preferredYears != null) reasons.push(`${exp.preferredYears} year(s) preferred (not required)`)
  if (matched.length) reasons.push(`technical overlap: ${matched.slice(0, 6).join(', ')}`)
  reasons.push(loc.label)
  if (phdUnits.length && !phdRequired) reasons.push('PhD mentioned only as optional')

  const qualified = exclusions.length === 0 && fitScore >= minFitScore
  if (!exclusions.length && fitScore < minFitScore) exclusions.push(`fit ${fitScore}% below ${minFitScore}% threshold`)

  return {
    decision: qualified ? 'QUALIFIED' : 'REJECTED',
    fitScore,
    rankScore: Math.round(rank),
    fitReasons: reasons,
    exclusionReasons: exclusions,
    components: { seniority, experience: Math.max(0, experience), family, technical: Math.max(0, technical), location, education, mandatory: Math.max(0, mandatory) },
    experience: exp,
    roleFamily: title.family,
    seniority: title.seniority,
    location: loc,
    salary,
    applicationDifficulty: ease.level,
    applicationSignals: ease.signals,
    interviewDifficulty: interview.level,
    interviewSignals: interview.signals,
    start,
    rankNotes,
  }
}

/** Highest rank first; ties by fit then freshness. */
export function rankJobs(jobs) {
  return [...jobs].sort(
    (a, b) =>
      (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
      (b.fitScore ?? 0) - (a.fitScore ?? 0) ||
      String(b.postedDate ?? '').localeCompare(String(a.postedDate ?? '')),
  )
}
