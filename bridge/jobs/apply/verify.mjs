/**
 * What a page proves. Two questions only:
 *
 *   blockers(page)  -> reasons a human is needed (CAPTCHA, login, 2FA, closed)
 *   evidence(page)  -> positive proof an application was received, or not
 *
 * APPLIED is a high-integrity state: a click, a navigation, a closed browser
 * or the absence of an error proves nothing. Only an explicit confirmation
 * (thank-you / received / submitted text, optionally a confirmation number)
 * counts, and not while the form is still on the page or an error is showing.
 *
 * page: { url, title, text, hasPasswordField?, captchaFrames?, formStillPresent?, errorText? }
 */

const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|turnstile|verify (that )?you('| a)re (a )?human|are you a robot|security check)\b/i
const TWO_FA = /\b(verification code|one[- ]time (pass)?code|two[- ]factor|2fa|enter the code (we )?sent|authenticat(or|ion) code)\b/i
const LOGIN = /\b(sign in to (apply|continue)|log ?in to (apply|continue)|create an account to apply|create (your )?account|register to apply)\b/i
const CLOSED = /\b(no longer (accepting applications|available|open)|position (has been )?filled|this job (is )?(closed|expired)|job not found|page not found|vacancy (has )?closed)\b/i

const SUCCESS = [
  /\bthank(s| you) for (applying|your application|submitting)\b/i,
  /\b(your )?application (has been|was) (successfully )?(received|submitted|sent)\b/i,
  /\bwe(?:'ve| have) received your application\b/i,
  /\bapplication (received|submitted|complete)\b/i,
  /\bsuccessfully (applied|submitted)\b/i,
]
const CONFIRMATION_ID = /\b(?:confirmation|reference|application)\s*(?:number|no\.?|id|#)\s*[:#]?\s*([A-Z0-9-]{4,30})\b/i
const ERROR = /\b(please (fix|correct|complete)|(this|a) field is required|is required|there (was|were) (an )?errors?|something went wrong|failed to submit|try again)\b/i

export function blockers(page) {
  const text = `${page.title ?? ''}\n${page.text ?? ''}`
  const out = []
  if ((page.captchaFrames ?? 0) > 0 || CAPTCHA.test(text)) out.push({ kind: 'captcha', reason: 'CAPTCHA on the application page' })
  if (TWO_FA.test(text)) out.push({ kind: '2fa', reason: 'the site asks for a verification / two-factor code' })
  if (page.hasPasswordField || LOGIN.test(text)) out.push({ kind: 'login', reason: 'the site requires signing in or creating an account' })
  if (CLOSED.test(text) || page.status === 404 || page.status === 410) out.push({ kind: 'closed', reason: 'the vacancy appears closed' })
  return out
}

export function evidence(page) {
  // The visible page body only: a <title> alone is not proof.
  const text = String(page.text ?? '').slice(0, 20_000)
  const hit = SUCCESS.map((re) => re.exec(text)).find(Boolean)
  if (!hit) return { verified: false, kind: 'none', detail: 'no confirmation text on the page' }
  if (page.formStillPresent) return { verified: false, kind: 'ambiguous', detail: 'confirmation-like text but the application form is still present' }
  if (page.errorText || ERROR.test(text.replace(hit[0], ''))) return { verified: false, kind: 'ambiguous', detail: 'confirmation-like text alongside an error message' }
  const id = CONFIRMATION_ID.exec(text)?.[1]
  return {
    verified: true,
    kind: id ? 'confirmation-number' : 'thank-you-page',
    detail: hit[0].slice(0, 120),
    confirmationId: id ?? '',
    url: page.url ? String(page.url).split('?')[0].slice(0, 300) : '',
    at: new Date().toISOString(),
  }
}
