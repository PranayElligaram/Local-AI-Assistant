/**
 * The job agent from a terminal. Uses the same configuration, state and run
 * lock as the bridge's scheduler, so the two can never run at once.
 *
 *   npm run jobs -- status               diagnostics (non-sensitive)
 *   npm run jobs -- auth                 one-time Google consent (DPAPI-stored token)
 *   npm run jobs -- resolve              find the tracker, show tabs and column mapping
 *   npm run jobs -- discover [--limit N] DRY RUN: discover + evaluate, write nothing
 *   npm run jobs -- queue-one --yes      add at most ONE qualified role and queue it for tailoring
 *   npm run jobs -- watch                one tracker watch pass (tailoring detection)
 *   npm run jobs -- audit                application-profile answer audit
 *   npm run jobs -- apply-check <jobId>  dry-run an application form (never submits)
 */

import { ROOT, RUN_DIR } from '../bridge/config.mjs'
import { jobsConfig } from '../bridge/jobs/config.mjs'
import { createJobAgent, tokenFile } from '../bridge/jobs/agent.mjs'
import { createAuth, createTokenStore } from '../bridge/jobs/google/oauth.mjs'
import { createGoogle } from '../bridge/jobs/google/api.mjs'
import { mappingProblems, parseSpreadsheet, resolveTracker, trackerRecords, metaRecords } from '../bridge/jobs/tracker.mjs'
import { join } from 'node:path'
import { openUrl } from '../bridge/apps/launch.mjs'

// Application automation is loaded only by the commands that use it.
const applyModules = async () => ({ ...(await import('../bridge/jobs/profile.mjs')), ...(await import('../bridge/jobs/apply/applier.mjs')) })

const [cmd = 'status', ...rest] = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : fallback
}
const has = (name) => rest.includes(`--${name}`)
const base = jobsConfig()

function google() {
  const auth = createAuth({ clientId: base.googleClientId, clientSecret: base.googleClientSecret, tokens: createTokenStore(tokenFile(RUN_DIR)) })
  return { auth, api: auth.authorised() ? createGoogle({ accessToken: () => auth.accessToken() }) : null }
}

function setupHelp() {
  console.log(`
Google is not set up yet. One-time steps (see docs/job-agent.md):
  1. Google Cloud console -> new project -> enable "Google Sheets API" and "Google Drive API".
  2. OAuth consent screen: External, add yourself as a test user.
  3. Credentials -> Create OAuth client ID -> Application type "Desktop app".
  4. In .env.local:  JOBS_GOOGLE_CLIENT_ID=...   JOBS_GOOGLE_CLIENT_SECRET=...
  5. npm run jobs -- auth`)
}

const print = (x) => console.log(JSON.stringify(x, null, 2))

async function main() {
  switch (cmd) {
    case 'status': {
      print(createJobAgent({ cfg: base, root: ROOT, runDir: RUN_DIR }).diagnostics())
      break
    }
    case 'auth': {
      const { auth } = google()
      if (!auth.configured()) return setupHelp()
      const r = await auth.authorise({ openUrl: (u) => openUrl(u) })
      console.log(`[jobs] authorised. Scopes granted: ${r.scope}`)
      console.log('[jobs] the refresh token is stored with Windows DPAPI in .jarvis/jobs/google-token.dpapi (never printed).')
      break
    }
    case 'resolve': {
      const { api } = google()
      if (!api) return setupHelp()
      const r = await resolveTracker({ google: api, configuredId: base.trackerSpreadsheetId, name: base.trackerName })
      if (!r.ok) {
        console.log(`[jobs] ${r.category}: ${r.message}`)
        process.exitCode = 1
        return
      }
      const parsed = parseSpreadsheet(await api.getSpreadsheet(r.id), { mainTab: base.mainTab })
      const recs = trackerRecords(parsed)
      print({
        spreadsheetId: r.id,
        resolvedBy: r.source,
        title: parsed.title,
        tabs: parsed.sheets.map((t) => ({ title: t.title, headerRow: t.headerRow == null ? null : t.headerRow + 1, rows: t.rowCount })),
        mainTab: parsed.main?.title ?? null,
        mapping: parsed.main ? Object.fromEntries(Object.entries(parsed.main.cols).map(([k, c]) => [k, parsed.main.headers[c]])) : null,
        problems: mappingProblems(parsed),
        roleRows: recs.length,
        jarvisRows: recs.filter((x) => x.jobId).length,
        metaTab: Boolean(parsed.meta),
        metaRows: metaRecords(parsed).length,
        // Read-only check that the master CV is reachable; it is never modified.
        masterCv: base.masterCvFileId ? await api.getFile(base.masterCvFileId).then((f) => ({ found: !f.trashed, name: f.name }), (e) => ({ found: false, error: e.category })) : 'JOBS_MASTER_CV_FILE_ID not set',
      })
      if (r.persist && !base.trackerSpreadsheetId) console.log(`\n[jobs] tip: pin it with JOBS_TRACKER_SPREADSHEET_ID=${r.id} in .env.local`)
      break
    }
    case 'discover':
    case 'queue-one': {
      const live = cmd === 'queue-one'
      if (live && !has('yes')) {
        console.log('queue-one writes ONE row to your tracker and queues it for CV tailoring. Re-run with --yes to confirm.')
        return
      }
      if (live && !google().api) return setupHelp() // never "queue" without the tracker to dedupe against
      const limit = Number(arg('limit', live ? 1 : 10))
      const cfg = { ...base, enabled: true, trackerWrites: live, maxNewQualifiedPerRun: live ? 1 : limit, maxTailorQueuedPerRun: live ? 1 : base.maxTailorQueuedPerRun, maxSourceRequestsPerRun: Number(arg('requests', base.maxSourceRequestsPerRun)) }
      const agent = createJobAgent({ cfg, root: ROOT, runDir: RUN_DIR, log: (m) => console.log(m) })
      const r = await agent.search()
      if (r.skipped) return console.log(`[jobs] skipped: ${r.skipped}`)
      const { run, candidates } = r
      print({ run })
      const passed = candidates.filter((c) => !['REJECTED'].includes(c.status))
      console.log(`\n=== ${passed.length} passed / ${candidates.length - passed.length} rejected (of ${run.discovered} new, ${run.duplicates} already known) ===`)
      for (const c of passed) console.log(`\nPASS [${c.status}] ${c.company} — ${c.title} (${c.location})\n  fit ${c.fitScore}% rank ${c.rankScore} · application ${c.applicationDifficulty} · interview ${c.interviewDifficulty}\n  ${c.url}\n  why: ${c.fitReasons?.join('; ')}${c.rankNotes ? `\n  rank: ${c.rankNotes.join(', ')}` : ''}${c.wouldQueue ? '\n  -> would queue for tailoring' : ''}`)
      const shown = has('all') ? candidates : candidates.filter((c) => c.status === 'REJECTED' && c.fitScore != null)
      for (const c of shown.filter((x) => x.status === 'REJECTED')) console.log(`\nREJECT ${c.company} — ${c.title} (${c.location})${c.fitScore != null ? ` fit ${c.fitScore}%` : ''}\n  ${c.exclusionReasons?.join('; ')}`)
      const pre = candidates.filter((c) => c.status === 'REJECTED' && c.fitScore == null).length
      if (!has('all') && pre) console.log(`\n(${pre} more rejected on title/location alone; --all to list them)`)
      break
    }
    case 'watch': {
      const { createApplier, loadProfile } = await applyModules()
      const agent = createJobAgent({ cfg: { ...base, enabled: true }, root: ROOT, runDir: RUN_DIR, log: (m) => console.log(m), createApplier: (ctx) => createApplier({ ...ctx, profile: loadProfile(ROOT, base.profileFile), cvDir: join(RUN_DIR, 'jobs', 'cv') }) })
      print((await agent.watch()).run)
      break
    }
    case 'audit': {
      const { auditProfile, loadProfile } = await applyModules()
      print(auditProfile(loadProfile(ROOT, base.profileFile), base))
      break
    }
    case 'apply-check': {
      const jobId = rest[0]
      if (!/^jb_[a-z0-9]+$/.test(String(jobId))) return console.log('usage: npm run jobs -- apply-check <jobId>')
      const agent = createJobAgent({ cfg: { ...base, applicationMode: 'dry-run' }, root: ROOT, runDir: RUN_DIR })
      const job = agent.store.job(jobId)
      if (!job) return console.log(`[jobs] no job ${jobId} in local state`)
      const { api } = google()
      const { createApplier, loadProfile } = await applyModules()
      const applier = createApplier({ cfg: { ...base, applicationMode: 'dry-run' }, store: agent.store, google: api, profile: loadProfile(ROOT, base.profileFile), cvDir: join(RUN_DIR, 'jobs', 'cv'), log: (m) => console.log(m) })
      print(await applier.inspect(job))
      break
    }
    default:
      console.log('usage: npm run jobs -- status|auth|resolve|discover|queue-one --yes|watch|audit|apply-check <jobId>')
  }
}

main().catch((err) => {
  // Category and message only; never a token or response body.
  console.error(`[jobs] ${err.category ? `${err.category}: ` : ''}${err.message}`)
  process.exitCode = 1
})
