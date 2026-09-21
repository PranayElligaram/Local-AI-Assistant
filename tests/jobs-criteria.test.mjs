/**
 * The canonical job-search requirements: seniority, experience (mandatory vs
 * preferred), exclusions, location, and the ranking factors that must move a
 * role up or down without rejecting it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, parseExperience, rankJobs } from '../bridge/jobs/criteria.mjs'
import { normalizeJob } from '../bridge/jobs/job.mjs'

const NOW = new Date('2026-09-21T12:00:00Z')

const BODY = `About the role
You will build Python and Django REST APIs and backend services, with Git, GitHub Actions and automated testing (pytest).
You will help prototype LLM and machine learning features with TensorFlow.

Requirements
A degree in Computer Science or a related subject.
Solid Python and REST API fundamentals.
Experience with Git.`

function job(title, extra = {}) {
  return normalizeJob(
    {
      title,
      company: extra.company ?? 'Acme AI',
      location: extra.location ?? 'London, UK',
      workplaceType: extra.workplaceType ?? 'hybrid',
      source: extra.source ?? 'greenhouse:acme',
      sourceJobId: extra.sourceJobId ?? String(Math.random()).slice(2, 9),
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      postedDate: extra.postedDate ?? '2026-09-18T00:00:00Z',
      description: extra.description ?? BODY,
      salary: extra.salary ?? null,
    },
    NOW,
  )
}
const ev = (j, o = {}) => evaluate(j, { now: NOW, ...o })

// --- search criteria ---------------------------------------------------------

test('1. a London graduate AI role passes', () => {
  const r = ev(job('Graduate AI Engineer'))
  assert.equal(r.decision, 'QUALIFIED', r.exclusionReasons.join('; '))
  assert.ok(r.fitScore >= 70)
  assert.ok(r.fitReasons.some((x) => /graduate\/junior/.test(x)))
})

test('2. a London junior backend role passes', () => {
  const r = ev(job('Junior Backend Engineer (Python)', { workplaceType: 'onsite' }))
  assert.equal(r.decision, 'QUALIFIED', r.exclusionReasons.join('; '))
  assert.equal(r.roleFamily, 'software-engineering')
})

test('3. 3+ years required is rejected', () => {
  const r = ev(job('Software Engineer', { description: `${BODY}\nYou must have 3+ years of commercial experience with Python.` }))
  assert.equal(r.decision, 'REJECTED')
  assert.ok(r.exclusionReasons.some((x) => /3\+ years mandatory/.test(x)))
})

test('4. a senior role is rejected', () => {
  for (const t of ['Senior Software Engineer', 'Lead AI Engineer', 'Staff Engineer', 'Principal ML Engineer', 'Engineering Manager']) {
    const r = ev(job(t))
    assert.equal(r.decision, 'REJECTED', t)
    assert.ok(r.exclusionReasons.includes('senior/lead/manager title'), t)
  }
})

test('5. a PhD-required role is rejected', () => {
  const r = ev(job('Graduate Machine Learning Engineer', { description: `${BODY}\nA PhD in Machine Learning is required.` }))
  assert.equal(r.decision, 'REJECTED')
  assert.ok(r.exclusionReasons.includes('PhD required'))
})

test('6. PhD preferred alone is not a rejection', () => {
  const r = ev(job('Graduate Machine Learning Engineer', { description: `${BODY}\nNice to have: a PhD or publications in ML.` }))
  assert.equal(r.decision, 'QUALIFIED', r.exclusionReasons.join('; '))
  assert.ok(r.fitReasons.includes('PhD mentioned only as optional'))
})

test('7. a pure Data Analyst role is rejected', () => {
  const r = ev(job('Graduate Data Analyst'))
  assert.equal(r.decision, 'REJECTED')
  assert.ok(r.exclusionReasons.includes('pure data analyst role'))
})

test('8. an unpaid internship is rejected', () => {
  const r = ev(job('Software Engineering Intern', { description: `${BODY}\nThis is an unpaid internship; travel expenses covered.` }))
  assert.equal(r.decision, 'REJECTED')
  assert.ok(r.exclusionReasons.includes('unpaid role'))
})

test('9. UK remote is kept only when the fit is unusually strong', () => {
  const strong = ev(job('Graduate AI Engineer', { location: 'Remote - United Kingdom', workplaceType: 'remote' }))
  assert.equal(strong.location.fit, 'uk-remote')
  assert.equal(strong.decision, 'QUALIFIED', strong.exclusionReasons.join('; '))
  const weak = ev(job('Automation Engineer', { location: 'Remote - United Kingdom', workplaceType: 'remote', description: 'Automation of spreadsheets. Excel and VBA.' }))
  assert.equal(weak.decision, 'REJECTED')
  const elsewhere = ev(job('Graduate AI Engineer', { location: 'Manchester, UK', workplaceType: 'onsite' }))
  assert.equal(elsewhere.decision, 'REJECTED')
  assert.ok(elsewhere.exclusionReasons.some((x) => /outside London/.test(x)))
})

test('10. a low salary lowers the rank but does not reject', () => {
  const low = ev(job('Graduate Software Engineer', { salary: { min: 25000, max: 26000, currency: 'GBP' } }))
  const good = ev(job('Graduate Software Engineer', { salary: { min: 45000, max: 54000, currency: 'GBP' } }))
  assert.equal(low.decision, 'QUALIFIED')
  assert.equal(low.fitScore, good.fitScore)
  assert.ok(low.rankScore < good.rankScore - 10)
})

test('11. an unknown salary is unknown, and neither rewarded nor punished', () => {
  const r = ev(job('Graduate Software Engineer'))
  assert.equal(r.salary.known, false)
  assert.equal(r.decision, 'QUALIFIED')
  assert.ok(!r.rankNotes.some((n) => /salary/.test(n)))
})

test('salary is read from the description when the source has none', () => {
  const r = ev(job('Graduate Software Engineer', { description: `${BODY}\nSalary: £45,000 - £54,000 plus benefits.` }))
  assert.deepEqual([r.salary.min, r.salary.max], [45000, 54000])
})

test('12. an easy application ranks above an otherwise identical hard one', () => {
  const easy = ev(job('Graduate Software Engineer'))
  const hard = ev(job('Graduate Software Engineer', { description: `${BODY}\nA cover letter is required. Shortlisted candidates attend an assessment centre.` }))
  assert.equal(easy.applicationDifficulty, 'EASY')
  assert.equal(hard.applicationDifficulty, 'HARD')
  assert.ok(easy.rankScore > hard.rankScore)
})

test('13. a heavy technical interview lowers the rank without rejecting', () => {
  const heavy = ev(job('Graduate Software Engineer', { description: `${BODY}\nOur process: a HackerRank test, a take-home assignment and a system design interview.` }))
  const light = ev(job('Graduate Software Engineer', { description: `${BODY}\nInterview process: a two-stage process with a project discussion and a behavioural interview.` }))
  assert.equal(heavy.decision, 'QUALIFIED')
  assert.equal(heavy.interviewDifficulty, 'HEAVY')
  assert.equal(light.interviewDifficulty, 'LIGHT')
  assert.ok(light.rankScore > heavy.rankScore)
})

// The real Helsing "Software Engineer (Early Careers)" posting (Greenhouse, 21 Sep 2026), as extracted.
const HELSING_PROCESS = `The process
At the core of our technical interview philosophy is Bring Something Awesome (BSA) . A dedicated session where candidates present an ambitious technical project they have designed, built, or contributed to.
With BSA2A , we are bringing this step to the very front of the application. Instead of an initial CV and recruiter screen, you apply by submitting a short (maximum 10-minute) prerecorded video walkthrough of something technically compelling you have built. We look for:
•
Engineering depth & craft: High-quality code, solid architectural choices, and systems-level thinking.
Candidates selected through BSA2A move into an accelerated, streamlined technical assessment:
•
Video Submission: Eligible candidates receive a private link with detailed guidance to upload their 10-minute BSA walkthrough.
•
Technical Interviews (2 × 60 mins):
•
Round 1: BSA Deep Dive & Systems Design . An interactive, technical exploration of your project and system trade-offs.
•
Round 2: Live Coding . Practical, real-world algorithmic and problem-solving assessment.
•
Final Interview (30 mins): A conversation with engineering leadership focused on mission alignment, collaboration, and how you work.
Why apply via this route?
Accelerated timeline: A focused, high-signal path that bypasses standard preliminary screens and reduces the overall interview cycle by two full stages.`
const HELSING = `${BODY}\nYou enjoy collaborating with others, including reviewing code and pair programming.\n\n${HELSING_PROCESS}`
const burden = (text) => ev(job('Graduate Software Engineer', { description: `${BODY}\n\n${text}` })).interviewDifficulty

test('the Helsing process (BSA deep dive + systems design, live coding, 2 × technical interviews) is HEAVY', () => {
  const r = ev(job('Software Engineer (Early Careers)', { location: 'Berlin; London; Munich', description: HELSING }))
  assert.equal(r.interviewDifficulty, 'HEAVY')
  for (const s of ['live coding', 'system design', 'project deep dive / walkthrough', 'multiple technical interviews', 'prerecorded technical submission']) assert.ok(r.interviewSignals.includes(s), s)
  assert.ok(!r.interviewSignals.includes('practical coding'), 'a culture line about pair programming is not an interview stage')
  // Independent of the (easy) application form, and never a rejection by itself.
  assert.equal(r.applicationDifficulty, 'EASY')
  assert.equal(r.decision, 'QUALIFIED', r.exclusionReasons.join('; '))
  assert.ok(r.fitScore >= 70)
  // Ranked below the same role with a light process.
  const light = ev(job('Software Engineer (Early Careers)', { location: 'Berlin; London; Munich', description: `${BODY}\n\nInterview process: a recruiter screen, then a behavioural interview with the hiring manager.` }))
  assert.equal(light.interviewDifficulty, 'LIGHT')
  assert.equal(light.fitScore, r.fitScore)
  assert.equal(light.rankScore - r.rankScore, 13)
})

test('interview-process indicators', () => {
  assert.equal(burden('Round 2 is a live coding session.'), 'HEAVY')
  assert.equal(burden('The second stage is a systems design interview.'), 'HEAVY')
  assert.equal(burden('Shortlisted candidates complete a take-home assignment.'), 'HEAVY')
  assert.equal(burden('Successful applicants are invited to an assessment centre.'), 'HEAVY')
  assert.equal(burden('Our process includes a Codility coding test.'), 'HEAVY')
  assert.equal(burden('Interview stages: 1. recruiter call 2. technical interview 3. technical interview 4. final.'), 'HEAVY')
  assert.equal(burden('Interview process: a recruiter screen followed by a behavioural interview.'), 'LIGHT')
  assert.equal(burden('Our interview is a relaxed technical chat about a project you are proud of. No take-home, no live coding.'), 'LIGHT')
  assert.equal(burden('There is one technical interview.'), 'MODERATE')
  assert.equal(burden('You will contribute to system design and enjoy pair programming.'), 'UNKNOWN', 'duties are not a selection process')
})

test('14. an unknown interview process stays UNKNOWN', () => {
  const r = ev(job('Graduate Software Engineer'))
  assert.equal(r.interviewDifficulty, 'UNKNOWN')
  assert.deepEqual(r.interviewSignals, [])
})

// --- mandatory vs preferred -------------------------------------------------

test('15. "2 years required" is accepted but scored below 0-1 years', () => {
  const two = ev(job('Junior Software Engineer', { description: `${BODY}\n2 years of professional Python experience is required.` }))
  const none = ev(job('Junior Software Engineer'))
  assert.equal(two.experience.mandatoryYears, 2)
  assert.equal(two.decision, 'QUALIFIED')
  assert.ok(two.components.experience < none.components.experience)
})

test('16. "2 years preferred" is not a requirement', () => {
  const e = parseExperience('2 years of commercial experience is preferred.')
  assert.equal(e.mandatoryYears, null)
  assert.equal(e.preferredYears, 2)
  assert.equal(e.requiredYears, null)
})

test('17. "3+ years preferred" does not reject', () => {
  const r = ev(job('Junior Software Engineer', { description: `${BODY}\n\nNice to have\n3+ years of industry experience with cloud platforms.` }))
  assert.equal(r.experience.preferredYears, 3)
  assert.equal(r.experience.mandatoryYears, null)
  assert.equal(r.decision, 'QUALIFIED', r.exclusionReasons.join('; '))
})

test('18. an ambiguous experience mention is treated conservatively, as required', () => {
  const e = parseExperience('3+ years experience building web services.')
  assert.equal(e.ambiguousYears, 3)
  assert.equal(e.requiredYears, 3)
  const r = ev(job('Software Engineer', { description: `3+ years experience building web services.\n${BODY}` }))
  assert.equal(r.decision, 'REJECTED')
  assert.ok(r.exclusionReasons.some((x) => /treated as required/.test(x)))
})

test('a requirements heading makes its bullets mandatory; company history is not experience', () => {
  const e = parseExperience('What you will need:\n• 4 years of Python experience\nWe have been building software for 20 years of experience in fintech.')
  assert.equal(e.mandatoryYears, 4)
})

test('a title that is not graduate/junior needs the description to say so', () => {
  const neutral = ev(job('Software Engineer'))
  assert.equal(neutral.decision, 'REJECTED')
  assert.ok(neutral.fitReasons.includes('seniority not stated as graduate/junior'))
  const grads = ev(job('Software Engineer', { description: `${BODY}\nThis role is open to recent graduates.` }))
  assert.equal(grads.decision, 'QUALIFIED', grads.exclusionReasons.join('; '))
  const mentor = ev(job('Full-Stack Software Engineer', { description: `${BODY}\nMentor junior and mid-level engineers through code reviews.` }))
  assert.equal(mentor.decision, 'REJECTED', 'mentoring juniors is not a junior signal')
  const mid = ev(job('Software Engineer II'))
  assert.equal(mid.decision, 'REJECTED')
  assert.ok(mid.fitScore <= 60)
})

test('an older but open posting is ranked down, not rejected; a very old one is excluded', () => {
  const older = ev(job('Graduate Software Engineer', { postedDate: '2026-07-20T00:00:00Z' }))
  assert.equal(older.decision, 'QUALIFIED')
  assert.ok(older.rankNotes.some((n) => /over two months/.test(n)))
  const ancient = ev(job('Graduate Software Engineer', { postedDate: '2025-01-01T00:00:00Z' }))
  assert.equal(ancient.decision, 'REJECTED')
})

test('rankJobs puts the better opportunity first', () => {
  const a = { ...job('Graduate Software Engineer'), ...ev(job('Graduate Software Engineer')) }
  const b = { ...job('Graduate Software Engineer'), ...ev(job('Graduate Software Engineer', { description: `${BODY}\nAssessment centre and HackerRank test.` })) }
  assert.equal(rankJobs([b, a])[0], a)
})
