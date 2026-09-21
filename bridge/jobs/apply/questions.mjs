/**
 * Application-form questions -> answers from the approved profile, or a
 * reason JARVIS must stop and ask. There is no "best guess" branch.
 *
 * field: { label, type: 'text'|'email'|'tel'|'url'|'textarea'|'select'|'radio'|'checkbox'|'file'|..., required, options?: string[] }
 * answer(field, profile) ->
 *   { action: 'fill', value }       a configured profile value
 *   { action: 'choose', option }    an option matching a configured value
 *   { action: 'check' }             a configured consent
 *   { action: 'upload', file }      'resume' (the tailored CV)
 *   { action: 'skip' }              optional, and nothing approved to say
 *   { action: 'needs-input', reason }
 */

const norm = (s) => String(s ?? '').toLowerCase().replace(/[*:?]/g, ' ').replace(/\s+/g, ' ').trim()

const RULES = [
  // Never automatically, whatever is configured.
  { kind: 'never', reason: 'criminal record question', re: /\b(criminal|convict|conviction|offen[cs]e|dbs check|background check disclosure)\b/ },
  { kind: 'never', reason: 'health question', re: /\b(health|medical condition|illness)\b/ },
  { kind: 'never', reason: 'security clearance question', re: /\b(security clearance|sc clearance|dv clearance|clearance level)\b/ },
  // Demographic: explicit per-question answers only.
  { kind: 'demographic', key: 'disability', re: /\b(disab|neurodiver|reasonable adjustment)/ },
  { kind: 'demographic', key: 'ethnicity', re: /\b(ethnic\w*|race|racial)\b/ },
  { kind: 'demographic', key: 'socioEconomic', re: /\b(household earner|socio ?-?economic|free school meals|type of school|school did you attend|parents? (?:attend|went to) university|first generation)\b/ },
  { kind: 'demographic', key: 'sexualOrientation', re: /\bsexual orientation\b/ },
  { kind: 'demographic', key: 'religion', re: /\b(religion|belief)\b/ },
  { kind: 'demographic', key: 'veteran', re: /\b(veteran|armed forces|military service)\b/ },
  { kind: 'demographic', key: 'pronouns', re: /\bpronoun/ },
  { kind: 'demographic', key: 'gender', re: /\b(gender|sex|transgender|trans)\b/ },
  { kind: 'demographic', key: 'age', re: /\b(age range|date of birth|your age|how old)\b/ },
  // Files.
  { kind: 'file', key: 'resume', re: /\b(resume|résumé|cv|curriculum vitae)\b/ },
  { kind: 'file', key: 'coverLetter', re: /\bcover letter\b/ },
  // Consents.
  { kind: 'consent', key: 'privacyConsent', re: /\b(privacy (notice|policy)|data (protection|processing)|gdpr|i consent|consent to|collecting,? (and )?storing|process(ing)? (of )?my (personal )?(data|information))\b/ },
  { kind: 'consent', key: 'accuracyStatement', re: /\b(information (provided )?is (true|accurate|correct)|confirm (that )?(the|this|all) information|certify that)\b/ },
  // Standard profile fields.
  { kind: 'profile', key: 'sponsorship', re: /\b(sponsor|sponsorship|visa)\b/ },
  { kind: 'profile', key: 'rightToWorkUK', re: /\b(right to work|authori[sz]ed to work|eligible to work|work authori[sz]ation|legally (able|entitled) to work)\b/ },
  { kind: 'profile', key: 'salaryExpectation', re: /\b(salary|compensation|pay expectation|remuneration)\b/ },
  { kind: 'profile', key: 'noticePeriod', re: /\bnotice period\b/ },
  { kind: 'profile', key: 'availability', re: /\b(start date|when can you start|availability|available to start|earliest start)\b/ },
  { kind: 'profile', key: 'linkedinUrl', re: /\blinked ?in\b/ },
  { kind: 'profile', key: 'githubUrl', re: /\bgit ?hub\b/ },
  { kind: 'profile', key: 'portfolioUrl', re: /\b(portfolio|personal (web)?site|website)\b/ },
  { kind: 'profile', key: 'preferredName', re: /\b(preferred (first )?name)\b/ },
  { kind: 'profile', key: 'firstName', re: /\b(first name|given name|forename)\b/ },
  { kind: 'profile', key: 'lastName', re: /\b(last name|surname|family name)\b/ },
  { kind: 'profile', key: 'fullName', re: /^(full )?name$|\byour name\b|\bfull name\b/ },
  { kind: 'profile', key: 'email', re: /\be-?mail\b/ },
  { kind: 'profile', key: 'phone', re: /\b(phone|mobile|telephone|contact number)\b/ },
  { kind: 'profile', key: 'postcode', re: /\b(post ?code|zip)\b/ },
  { kind: 'profile', key: 'city', re: /\b(city|town|current location|where are you (based|located)|location)\b/ },
  { kind: 'profile', key: 'country', re: /\bcountry\b/ },
  { kind: 'profile', key: 'university', re: /\b(university|school|college|institution)\b/ },
  { kind: 'profile', key: 'degree', re: /\b(degree|discipline|field of study|major)\b/ },
  { kind: 'profile', key: 'graduationDate', re: /\b(graduation|graduate (date|year)|year of graduation)\b/ },
  { kind: 'profile', key: 'referralSource', re: /\b(how did you hear|where did you (hear|find)|referr?al source)\b/ },
]

/** By label; for an unlabelled upload, by the input's id/name ("resume", "cover_letter"). */
export function classify(label, hint = '') {
  const l = norm(label)
  for (const r of RULES) if (r.re.test(l)) return r
  const h = norm(String(hint).replace(/[_-]+/g, ' '))
  if (h) for (const r of RULES) if (r.kind === 'file' && r.re.test(h)) return r
  return { kind: 'unknown' }
}

const DECLINE = /\b(prefer not|decline|don'?t wish|do not wish|rather not|not to (say|disclose|answer))\b/i

/** The option whose text matches a configured value, or null. */
function matchOption(options, value) {
  const v = norm(value)
  const exact = options.find((o) => norm(o) === v)
  if (exact) return exact
  if (/^(yes|no)$/.test(v)) return options.find((o) => new RegExp(`^${v}\\b`).test(norm(o))) ?? null
  const partial = options.filter((o) => norm(o).includes(v) || v.includes(norm(o)))
  return partial.length === 1 ? partial[0] : null
}

export function answer(field, profile) {
  const rule = classify(field.label, field.type === 'file' ? field.hint : '')
  const req = Boolean(field.required)
  const ask = (reason) => ({ action: 'needs-input', reason, question: String(field.label).slice(0, 200) })
  const optional = () => (req ? ask(`required question not in the approved profile: "${String(field.label).slice(0, 120)}"`) : { action: 'skip' })
  const choice = Array.isArray(field.options) && field.options.length > 0

  const give = (value) => {
    if (value == null || value === '') return null
    if (choice) {
      const option = matchOption(field.options, value)
      return option ? { action: 'choose', option } : ask(`no option on the form matches the configured answer for "${String(field.label).slice(0, 80)}"`)
    }
    if (field.type === 'checkbox') return ask(`checkbox "${String(field.label).slice(0, 80)}" is not a configured consent`)
    return { action: 'fill', value }
  }

  switch (rule.kind) {
    case 'never':
      return req ? ask(`${rule.reason} — never answered automatically`) : { action: 'skip' }
    case 'demographic': {
      const configured = profile.demographics.answers[rule.key]
      if (configured) return give(configured) ?? optional()
      if (profile.demographics.policy === 'decline' && choice) {
        const decline = field.options.find((o) => DECLINE.test(o))
        if (decline) return { action: 'choose', option: decline }
      }
      // A searchable dropdown whose options are not listed: type the configured
      // decline wording; if the form has no such option the submission shows an
      // error and is never recorded as applied.
      if (profile.demographics.policy === 'decline' && field.type === 'combobox') return { action: 'fill', value: 'Prefer not to say' }
      return req ? ask(`demographic question "${String(field.label).slice(0, 80)}" needs your explicit choice`) : { action: 'skip' }
    }
    case 'file':
      if (field.type !== 'file') return optional() // "tell us about something on your CV" is a question, not an upload
      if (rule.key === 'resume') return { action: 'upload', file: 'resume' }
      return req ? ask('a cover letter is required and none is generated automatically') : { action: 'skip' }
    case 'consent':
      if (field.type !== 'checkbox' && !choice) return optional()
      if (profile.declarations[rule.key]) return choice ? give('Yes') ?? optional() : { action: 'check' }
      return req ? ask(`declaration "${String(field.label).slice(0, 100)}" is not configured`) : { action: 'skip' }
    case 'profile': {
      const f = profile.fields
      if (rule.key === 'sponsorship') {
        if (!f.requiresSponsorship) return req ? ask('sponsorship answer is not configured') : { action: 'skip' }
        return give(f.requiresSponsorship) ?? optional()
      }
      if (rule.key === 'fullName') {
        const full = f.firstName && f.lastName ? `${f.firstName} ${f.lastName}` : null
        return give(full) ?? optional()
      }
      if (rule.key === 'salaryExpectation' && !f.salaryExpectation) return req ? ask('salary question and no salary answer is configured') : { action: 'skip' }
      if (field.type === 'textarea' && !['referralSource', 'availability', 'noticePeriod'].includes(rule.key)) {
        // A free-text box asking for a profile fact is still fine; an essay is not.
        if (String(field.label).length > 120) return optional()
      }
      return give(f[rule.key]) ?? optional()
    }
    default:
      // Free text we have no approved answer for, or anything unrecognised.
      return optional()
  }
}

/** Plan every field. unresolved = the questions that stop an application. */
export function planAnswers(fields, profile) {
  const plan = fields.map((f) => ({ field: f, ...answer(f, profile) }))
  return { plan, unresolved: plan.filter((p) => p.action === 'needs-input'), uploads: plan.filter((p) => p.action === 'upload') }
}
