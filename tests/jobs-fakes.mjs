/**
 * Test doubles for the job agent: an in-memory Google Sheet that applies the
 * batchUpdate requests the tracker module emits (so "formulas preserved" is
 * checked against real request semantics), and a fake job source.
 */

const HEADERS = ['Rank', 'Programme', 'Status', 'London?', 'Opens / surfaced', 'Deadline', 'Your eligibility', 'Fit %', 'Priority', 'Application Status', 'View', 'Tailor Queue', 'Job Description', 'JD Ready?', 'CV PDF', 'CV DOCX', 'Cover Letter Queue', 'Cover Letter PDF', 'ATS Before', 'ATS After', 'Tailor Decision', 'Key Gaps', 'Personal Statement', 'Why This Opportunity', 'Relevant Skills / Experience', 'Output Folder', 'Last Tailored', 'Automation Notes']
export const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i]))

const QUEUE = ['☐ Ignore', '🟢 Ready', '⚙ Processing', '✅ Tailored', '⚠ Review', '⛔ Skip']
const APP = ['☐ Not applied', '✅ Applied', '❌ Rejected', '🚫 Void - Deadline Passed']
const list = (values) => ({ condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) }, strict: true })

const s = (v) => ({ userEnteredValue: { stringValue: v }, formattedValue: v })
const f = (formula, shown) => ({ userEnteredValue: { formulaValue: formula }, formattedValue: shown })

/** A tracker shaped like the real one: dashboard rows, a header on row 6, formulas and dropdowns. */
export function trackerFixture({ rows = 2, extraBlankRows = 3 } = {}) {
  const main = { properties: { sheetId: 0, title: 'Active Roles', index: 0, gridProperties: { rowCount: 0, columnCount: HEADERS.length } }, rows: [] }
  main.rows.push([], [s(''), s('PRANAY — JOB APPLICATION DASHBOARD')], [s(''), s('ACTIVE ROLES')], [s(''), f('=COUNTA(B7:B)', String(rows))], [])
  main.rows.push(HEADERS.map(s))
  const role = (i, company, title, url) => {
    const r = HEADERS.map(() => ({}))
    r[COL.Rank] = f(`=ROW()-6`, String(i))
    r[COL.Programme] = s(`${company} — ${title}`)
    r[COL.Status] = s('VERIFIED OPEN — EMPLOYER ATS')
    r[COL['London?']] = s('Yes — London')
    r[COL['Fit %']] = { userEnteredValue: { stringValue: '90%' }, formattedValue: '90%' }
    r[COL['Application Status']] = { ...s('☐ Not applied'), dataValidation: list(APP) }
    r[COL.View] = f(`=HYPERLINK("${url}","Open role ↗")`, 'Open role ↗')
    r[COL['Tailor Queue']] = { ...s('☐ Ignore'), dataValidation: list(QUEUE) }
    r[COL['Automation Notes']] = s('User note: keep an eye on this one')
    return r
  }
  const seeded = [
    ['Cleary Gottlieb', 'Junior Software Engineer', 'https://careers.clearygottlieb.com/jobs/123'],
    ['Fospha', 'Graduate Software Engineer', 'https://boards.greenhouse.io/fospha/jobs/4001'],
    ['Helsing', 'Graduate AI Engineer', 'https://boards.greenhouse.io/helsing/jobs/4002'],
  ]
  for (let i = 0; i < rows; i++) main.rows.push(role(i + 1, ...seeded[i % seeded.length]))
  // Blank rows below the table that still carry the copied-down Rank formula and dropdowns.
  for (let i = 0; i < extraBlankRows; i++) {
    const r = HEADERS.map(() => ({}))
    r[COL.Rank] = f('=IF(B8="","",ROW()-6)', '')
    r[COL['Application Status']] = { dataValidation: list(APP) }
    r[COL['Tailor Queue']] = { dataValidation: list(QUEUE) }
    main.rows.push(r)
  }
  main.properties.gridProperties.rowCount = main.rows.length
  const applied = { properties: { sheetId: 11, title: 'Applied', index: 1, gridProperties: { rowCount: 3, columnCount: 3 } }, rows: [[s('Programme'), s('Outcome / Stage'), s('View')], [s('Stripe — Software Engineer, New Grad'), s('⏳ Waiting'), f('=HYPERLINK("https://stripe.com/jobs/listing/new-grad/7001","Open")', 'Open')]] }
  const config = { properties: { sheetId: 12, title: 'Config', index: 2, gridProperties: { rowCount: 3, columnCount: 3 } }, rows: [[s('Key'), s('Value'), s('Notes')], [s('Automation mode'), s('REVIEW_BEFORE_APPLY'), s('')]] }
  return { properties: { title: 'Pranay — AI & Software Job Application Tracker' }, tabs: [main, applied, config] }
}

/** An in-memory Sheets/Drive double over a fixture. */
export function fakeGoogle(fixture = trackerFixture(), { files = [{ id: 'SHEET_ID_123456', name: fixture.properties.title }] } = {}) {
  const calls = []
  const tab = (sheetId) => fixture.tabs.find((t) => t.properties.sheetId === sheetId)
  const ensureCell = (t, r, c) => {
    while (t.rows.length <= r) t.rows.push([])
    while (t.rows[r].length <= c) t.rows[r].push({})
    return t.rows[r][c]
  }
  const setValue = (t, r, c, v) => {
    const cell = ensureCell(t, r, c)
    cell.userEnteredValue = v
    cell.formattedValue = v.stringValue ?? (v.numberValue != null ? String(v.numberValue) : '')
  }
  return {
    calls,
    fixture,
    async getSpreadsheet() {
      calls.push(['get'])
      return {
        properties: fixture.properties,
        sheets: fixture.tabs.map((t) => ({ properties: { ...t.properties, gridProperties: { ...t.properties.gridProperties, rowCount: Math.max(t.properties.gridProperties.rowCount, t.rows.length) } }, data: [{ startRow: 0, rowData: t.rows.map((r) => ({ values: r.map((c) => structuredClone(c)) })) }] })),
      }
    },
    async batchUpdate(id, requests) {
      calls.push(['batchUpdate', requests])
      for (const q of requests) {
        if (q.updateCells) {
          assert(q.updateCells.fields === 'userEnteredValue', 'only userEnteredValue is ever written')
          const { sheetId, rowIndex, columnIndex } = q.updateCells.start
          q.updateCells.rows.forEach((row, ri) => row.values.forEach((v, ci) => setValue(tab(sheetId), rowIndex + ri, columnIndex + ci, v.userEnteredValue)))
        } else if (q.appendCells) {
          const t = tab(q.appendCells.sheetId)
          for (const row of q.appendCells.rows) {
            const r = t.rows.length
            row.values.forEach((v, ci) => setValue(t, r, ci, v.userEnteredValue))
          }
        } else if (q.addSheet) {
          const p = q.addSheet.properties
          fixture.tabs.push({ properties: { sheetId: p.sheetId, title: p.title, index: p.index, gridProperties: { rowCount: 1, columnCount: p.gridProperties.columnCount } }, rows: [] })
        } else if (q.insertDimension) {
          const t = tab(q.insertDimension.range.sheetId)
          const at = q.insertDimension.range.startIndex
          const inherit = (t.rows[at - 1] ?? []).map((c) => (c.dataValidation ? { dataValidation: structuredClone(c.dataValidation) } : {}))
          t.rows.splice(at, 0, inherit)
          t.properties.gridProperties.rowCount++
        } else if (q.copyPaste) {
          const { source: src, destination: dst } = q.copyPaste
          const cell = tab(src.sheetId).rows[src.startRowIndex][src.startColumnIndex]
          const target = ensureCell(tab(dst.sheetId), dst.startRowIndex, dst.startColumnIndex)
          target.userEnteredValue = structuredClone(cell.userEnteredValue)
        } else throw new Error(`unexpected request ${Object.keys(q)[0]}`)
      }
      return {}
    },
    async findSpreadsheetsByName(name) {
      calls.push(['find', name])
      return files.filter((x) => x.name === name)
    },
    async getFile(id) {
      return { id, name: 'x', trashed: false }
    },
    async download() {
      return { name: 'cv.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 fake') }
    },
  }
}

function assert(ok, msg) {
  if (!ok) throw new Error(msg)
}

export const JD = `About the role
Join our London team building Python and Django REST APIs and backend services. You'll use Git, GitHub Actions and automated testing (pytest), and help prototype LLM and machine learning features with TensorFlow.
We work in a hybrid pattern, three days in our London office.

Requirements
A degree in Computer Science or a related subject.
Solid Python and REST API fundamentals, and experience with Git.
You will be curious, pragmatic and keen to learn from senior engineers through code review and pairing.

Nice to have
Exposure to reinforcement learning or ROS2.
2 years of commercial experience is preferred but not required.`

/** A fake ATS source over fixed postings. */
export function fakeSource(postings, { id = 'greenhouse:acme', open = () => true, fail = false } = {}) {
  const calls = { discover: 0, verify: 0 }
  return {
    kind: id.split(':')[0],
    id,
    calls,
    async discover(http) {
      calls.discover++
      await http.json('https://example.invalid/list')
      if (fail) throw Object.assign(new Error('boom'), { category: 'HTTP' })
      return postings
    },
    fetchJob: async (_http, job) => job,
    async verifyOpen(_http, job) {
      calls.verify++
      return { open: open(job) }
    },
  }
}

/** An http budget object that never touches the network. */
export function fakeHttp(max = 50) {
  let used = 0
  return {
    async json() {
      used++
      return {}
    },
    get used() {
      return used
    },
    get remaining() {
      return max - used
    },
  }
}

export const posting = (over = {}) => ({
  title: 'Graduate Software Engineer',
  company: 'Acme AI',
  location: 'London, UK',
  workplaceType: 'hybrid',
  source: 'greenhouse:acme',
  sourceJobId: '9001',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/9001',
  applicationUrl: 'https://boards.greenhouse.io/acme/jobs/9001',
  postedDate: '2026-09-19T00:00:00Z',
  description: JD,
  ...over,
})
