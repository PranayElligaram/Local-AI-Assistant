/**
 * The user-owned application profile: the ONLY source of answers for standard
 * application-form questions.
 *
 * It lives in `jarvis.jobs.profile.json` (git-ignored) and is written by the
 * user, never by JARVIS. Nothing is inferred from the repository, the
 * conversation, the browser or a model: a field is answerable only when the
 * user has put a value in it. Sensitive categories (health, criminal record,
 * security clearance) are never answered automatically at all, and
 * demographic questions only from explicit per-question answers.
 *
 * The audit reports field NAMES and whether each is configured — never values.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Standard fields, with what they answer. */
export const PROFILE_FIELDS = {
  firstName: 'First name',
  lastName: 'Last name',
  preferredName: 'Preferred name',
  email: 'Email address',
  phone: 'Phone number',
  city: 'City / current location',
  postcode: 'Postcode',
  country: 'Country of residence',
  linkedinUrl: 'LinkedIn URL',
  githubUrl: 'GitHub URL',
  portfolioUrl: 'Portfolio / personal website',
  noticePeriod: 'Notice period',
  availability: 'Earliest start date / availability',
  rightToWorkUK: 'Right to work in the UK (Yes/No)',
  requiresSponsorship: 'Requires visa sponsorship (Yes/No)',
  salaryExpectation: 'Salary expectation (text you are happy to submit)',
  university: 'University',
  degree: 'Degree',
  graduationDate: 'Graduation date',
  referralSource: '"How did you hear about us?" answer',
}

/** Needed before live applications may be switched on. */
export const REQUIRED_FOR_LIVE = ['firstName', 'lastName', 'email', 'phone', 'city', 'rightToWorkUK', 'requiresSponsorship']

/** Answered only from explicit per-question entries in profile.demographics.answers. */
export const DEMOGRAPHIC_KEYS = ['gender', 'pronouns', 'ethnicity', 'disability', 'veteran', 'sexualOrientation', 'religion', 'age', 'socioEconomic']

/** Never auto-answered, whatever the profile says. */
export const NEVER_AUTO = ['health / medical conditions', 'criminal record / convictions', 'security clearance', 'legal declarations beyond the configured accuracy/privacy consent']

const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 300) : typeof v === 'boolean' ? v : undefined)

export function loadProfile(root, file = 'jarvis.jobs.profile.json') {
  const path = isAbsolute(file) ? file : join(root, file)
  if (!existsSync(path)) return normalizeProfile({}, { missing: true, path })
  try {
    return normalizeProfile(JSON.parse(readFileSync(path, 'utf8')), { path })
  } catch (err) {
    return normalizeProfile({}, { error: `profile unreadable: ${err.message.slice(0, 80)}`, path })
  }
}

export function normalizeProfile(raw, meta = {}) {
  const fields = {}
  for (const k of Object.keys(PROFILE_FIELDS)) {
    const v = clean(raw?.fields?.[k])
    if (typeof v === 'string' && v) fields[k] = v
  }
  for (const k of ['rightToWorkUK', 'requiresSponsorship']) {
    if (fields[k] && !/^(yes|no)$/i.test(fields[k])) delete fields[k] // must be an explicit Yes/No
    if (fields[k]) fields[k] = /^yes$/i.test(fields[k]) ? 'Yes' : 'No'
  }
  const demo = raw?.demographics ?? {}
  const answers = {}
  for (const k of DEMOGRAPHIC_KEYS) {
    const v = clean(demo.answers?.[k])
    if (typeof v === 'string' && v) answers[k] = v
  }
  return {
    fields,
    demographics: {
      // 'skip': leave optional ones blank (default). 'decline': pick a "prefer not to say"
      // option where one exists. Either way a configured per-question answer wins.
      policy: demo.policy === 'decline' ? 'decline' : 'skip',
      answers,
    },
    declarations: {
      // Tick "I confirm this information is accurate" style boxes only if true.
      accuracyStatement: raw?.declarations?.accuracyStatement === true,
      // Tick a privacy-notice / data-processing consent only if true.
      privacyConsent: raw?.declarations?.privacyConsent === true,
    },
    meta,
  }
}

/** Which answers JARVIS may give, which are missing, which it never gives. No values. */
export function auditProfile(profile, cfg = {}) {
  const configured = Object.keys(profile.fields)
  const missingRequired = REQUIRED_FOR_LIVE.filter((k) => !profile.fields[k])
  const blockers = []
  if (profile.meta?.missing) blockers.push(`no profile file (${profile.meta.path}) — copy jarvis.jobs.profile.example.json`)
  if (profile.meta?.error) blockers.push(profile.meta.error)
  if (missingRequired.length) blockers.push(`required fields not configured: ${missingRequired.join(', ')}`)
  return {
    applicationMode: cfg.applicationMode ?? 'dry-run',
    autoAnswerable: configured.map((k) => ({ field: k, label: PROFILE_FIELDS[k] })),
    notConfigured: Object.keys(PROFILE_FIELDS).filter((k) => !profile.fields[k]),
    unresolvedRequiredForLive: missingRequired,
    demographics: {
      policy: profile.demographics.policy,
      explicitlyConfigured: Object.keys(profile.demographics.answers),
      note: 'Unconfigured demographic questions are left blank when optional and need your input when required.',
    },
    declarations: profile.declarations,
    neverAutoAnswered: NEVER_AUTO,
    alwaysNeedsInput: ['CAPTCHA', 'login / account creation', 'two-factor codes', 'required free-text questions', 'required cover letter', 'any required question not listed above'],
    liveModeAllowed: blockers.length === 0,
    blockers,
  }
}
