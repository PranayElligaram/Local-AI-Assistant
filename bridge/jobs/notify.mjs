/**
 * What JARVIS says about the job search. Batched: counters accumulate in the
 * store and are spoken as one update, never one line per event.
 *
 * Only verified APPLIED jobs count as submitted; "attempted" is reported
 * separately so a click that could not be confirmed is never called a
 * submission.
 */

const plural = (n, one, many = `${one}s`) => `${n === 0 ? 'no' : n === 1 ? 'one' : numberWord(n)} ${n === 1 ? one : many}`
const numberWord = (n) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][n] ?? String(n)
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** Is there anything worth interrupting for? */
export function noteworthy(c) {
  return c.qualified > 0 || c.tailored > 0 || c.submitted > 0 || c.needsInput > 0
}

/** "Job search update. I found 12 new roles. Four matched your criteria. ..." */
export function summaryText(c, { needsInputOpen = null } = {}) {
  const parts = []
  if (c.discovered) parts.push(`I found ${plural(c.discovered, 'new role')}.`)
  if (c.discovered || c.qualified) parts.push(`${cap(c.qualified ? numberWord(c.qualified) : 'none')} matched your criteria.`)
  const done = []
  if (c.tailored) done.push(`${plural(c.tailored, 'CV')} ${c.tailored === 1 ? 'has' : 'have'} been tailored`)
  if (c.submitted) done.push(`${plural(c.submitted, 'application')} ${c.submitted === 1 ? 'was' : 'were'} submitted`)
  if (done.length) parts.push(`${cap(done.join(' and '))}.`)
  const needs = needsInputOpen ?? c.needsInput
  if (needs) parts.push(`${cap(plural(needs, 'application'))} ${needs === 1 ? 'needs' : 'need'} your input.`)
  if (!parts.length) return 'Job search update. Nothing new since the last update.'
  return `Job search update. ${parts.join(' ')}`
}

/** For "Good morning": one sentence, or nothing if there is nothing to say. */
export function morningLine(c, { awaitingTailoring = 0, needsInputOpen = 0 } = {}) {
  const bits = []
  if (c.submitted) bits.push(`submitted ${plural(c.submitted, 'application')}`)
  if (c.qualified) bits.push(`found ${plural(c.qualified, 'new matching role')}`)
  if (awaitingTailoring) bits.push(`has ${plural(awaitingTailoring, 'CV')} waiting for tailoring`)
  if (needsInputOpen) bits.push(`has ${plural(needsInputOpen, 'application')} that ${needsInputOpen === 1 ? 'needs' : 'need'} you`)
  if (!bits.length) return ''
  const last = bits.pop()
  return `Your job agent ${bits.length ? `${bits.join(', ')} and ${last}` : last} since the last update.`
}
