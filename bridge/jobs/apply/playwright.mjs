/**
 * The application browser: Playwright driving the installed Chrome with a
 * dedicated, persistent JARVIS job-agent profile (.jarvis/jobs/browser-profile)
 * — never the user's normal Chrome profile, never the JARVIS interface window.
 *
 * Launched per application and closed afterwards: no Chromium is left running
 * while the agent is idle. The launch arguments are fixed; the only input from
 * a job is the URL, which applier.mjs has already validated and which goes to
 * page.goto(), never onto a command line. Nothing here solves CAPTCHAs or
 * evades bot detection: it reads the page, and applier.mjs stops when a human
 * is needed.
 */

const COLLECT = (frameIndex) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l) return text(l)
    }
    const wrap = el.closest('label')
    if (wrap) return text(wrap)
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    const by = el.getAttribute('aria-labelledby')
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ')
    const fs = el.closest('fieldset')
    if (fs?.querySelector('legend')) return text(fs.querySelector('legend'))
    const box = el.closest('[class*="question"], [class*="field"], [class*="Field"], .form-group, li')
    const l = box?.querySelector('label, legend, [class*="label"], [class*="Label"]')
    if (l) return text(l)
    return el.getAttribute('placeholder') || el.name || ''
  }
  const out = []
  const radios = new Map()
  let i = 0
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase()
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) continue
    if (type !== 'file' && (!visible(el) || el.getAttribute('aria-hidden') === 'true')) continue
    const id = `${frameIndex}:${i++}`
    el.setAttribute('data-jarvis-idx', id)
    const label = labelFor(el).slice(0, 300)
    const required = el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\*\s/.test(label)
    if (type === 'radio') {
      const group = el.name || id
      const optionLabel = el.closest('label') ? text(el.closest('label')) : text(document.querySelector(`label[for="${CSS.escape(el.id || '_')}"]`)) || el.value
      const g = radios.get(group) ?? { id, group, type: 'radio', label: text(el.closest('fieldset')?.querySelector('legend')) || label, required, options: [], optionIds: [] }
      g.options.push(optionLabel)
      g.optionIds.push(id)
      g.required ||= required
      radios.set(group, g)
      continue
    }
    // For uploads the visible label is often just "Attach"; the section heading and the input's id/name say what it is.
    const section = type === 'file' ? text(el.closest('[class*="upload"], [class*="Upload"], fieldset, .field')?.querySelector('label, legend, [class*="label"], [class*="Label"], h3, h4')) : ''
    const field = { id, label: section && section !== label ? `${section} ${label}`.slice(0, 300) : label, hint: `${el.name || ''} ${el.id || ''}`.trim().slice(0, 80), type: el.getAttribute('role') === 'combobox' ? 'combobox' : type === 'select-one' ? 'select' : type, required }
    if (el.tagName === 'SELECT') field.options = [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|please select|--)/i.test(t))
    out.push(field)
  }
  // Yes/No questions built from buttons (Ashby) rather than inputs.
  for (const group of document.querySelectorAll('[role="radiogroup"], [class*="yesno" i], [class*="YesNo"]')) {
    const buttons = [...group.querySelectorAll('button')].filter(visible)
    if (buttons.length < 2 || group.querySelector('input[type=radio]')) continue
    const id = `${frameIndex}:${i++}`
    group.setAttribute('data-jarvis-idx', id)
    const box = group.closest('[class*="field" i], [class*="question" i], fieldset') ?? group.parentElement
    const label = text(box?.querySelector('label, legend, [class*="label" i]')) || text(box).split(buttons[0].innerText)[0]
    out.push({ id, label: label.slice(0, 300), type: 'buttons', required: /\*/.test(label) || Boolean(box?.querySelector('[class*="required" i]')), options: buttons.map(text) })
  }
  return [...out, ...radios.values()]
}

const PAGE_FACTS = () => ({
  text: (document.body?.innerText ?? '').slice(0, 20_000),
  hasPasswordField: [...document.querySelectorAll('input[type=password]')].some((e) => e.getBoundingClientRect().width > 0),
  formInputs: [...document.querySelectorAll('input:not([type=hidden]), textarea, select')].filter((e) => e.getBoundingClientRect().width > 0).length,
  fileInputs: document.querySelectorAll('input[type=file]').length,
})

export function createPlaywrightDriver({ profileDir, headless = true, timeoutMs = 45_000 }) {
  return {
    async open(url) {
      const { chromium } = await import('playwright-core')
      const context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless,
        acceptDownloads: false,
        viewport: { width: 1280, height: 900 },
        args: ['--no-first-run', '--no-default-browser-check'],
      })
      const page = context.pages()[0] ?? (await context.newPage())
      page.setDefaultTimeout(timeoutMs)
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      // Client-rendered forms (Ashby, new Greenhouse boards) appear after hydration.
      await page.waitForSelector('input:not([type=hidden]), textarea, select', { timeout: 12_000 }).catch(() => {})
      await page.waitForTimeout(1500)
      let status = response?.status() ?? 0
      const frames = () => page.frames()
      const locate = (id) => {
        const [f] = String(id).split(':')
        return frames()[Number(f)].locator(`[data-jarvis-idx="${String(id).replace(/[^0-9:]/g, '')}"]`)
      }
      let radioGroups = new Map()

      return {
        async snapshot() {
          const facts = []
          for (const f of frames()) facts.push(await f.evaluate(PAGE_FACTS).catch(() => null))
          const ok = facts.filter(Boolean)
          return {
            url: page.url(),
            title: await page.title().catch(() => ''),
            status,
            text: ok.map((x) => x.text).join('\n').slice(0, 20_000),
            hasPasswordField: ok.some((x) => x.hasPasswordField),
            captchaFrames: frames().filter((f) => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i.test(f.url())).length,
            formStillPresent: ok.some((x) => x.fileInputs > 0 || x.formInputs > 3),
          }
        },
        async fields() {
          const all = []
          const fs = frames()
          for (let i = 0; i < fs.length; i++) all.push(...((await fs[i].evaluate(COLLECT, i).catch(() => [])) ?? []))
          radioGroups = new Map(all.filter((f) => f.type === 'radio').map((f) => [f.id, f]))
          return all
        },
        async fill(id, value) {
          const el = locate(id)
          await el.fill(String(value))
          if ((await el.getAttribute('role')) === 'combobox') await el.press('Enter')
        },
        async choose(id, option) {
          const g = radioGroups.get(id)
          if (g) return locate(g.optionIds[g.options.indexOf(option)]).check()
          const el = locate(id)
          if ((await el.evaluate((n) => n.tagName)) !== 'SELECT') return el.locator('button', { hasText: option }).first().click()
          await el.selectOption({ label: option })
        },
        check: (id) => locate(id).check(),
        upload: (id, path) => locate(id).setInputFiles(path),
        async submit() {
          for (const f of frames()) {
            const btn = f.locator('button[type=submit], input[type=submit], button:has-text("Submit application"), button:has-text("Submit Application"), button:has-text("Submit")').first()
            if (await btn.count()) {
              const nav = page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
              await btn.click()
              await nav
              await page.waitForTimeout(2500)
              status = 200
              return
            }
          }
          throw new Error('no submit button found')
        },
        close: () => context.close(),
      }
    },
  }
}
