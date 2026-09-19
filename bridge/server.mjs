/**
 * JARVIS local bridge - the brain and the hands.
 *
 * The browser is the face and the voice. This process answers: a deterministic
 * router for obvious commands, JARVIS-owned tools for anything that acts on the
 * machine, and a LOCAL model (Ollama: granite4:3b, falling back to qwen3.5:4b)
 * for conversation. Nothing here needs Claude, Anthropic, a cloud account, an
 * API key or the internet; with Ollama stopped, the deterministic commands
 * still work and conversation says plainly that the brain is unavailable.
 *
 *   node bridge/server.mjs            (add --writes for the separate writes mode)
 */

import { WebSocketServer } from 'ws'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { renderPage } from './page.mjs'
import {
  ALLOW_NO_ORIGIN,
  ALLOW_WRITES,
  APP_CACHE_FILE,
  APPS_FILE,
  BRAIN,
  ELEVEN_BASE,
  ELEVEN_TIMEOUT_MS,
  ENV_FILES_LOADED,
  EXTRA_ORIGINS,
  LAUNCH_DRY_RUN,
  MIN_NODE_MAJOR,
  PORT,
  RUN_DIR,
  SEARCH_ENGINE,
  STT_TIMEOUT_MS,
  VOICE_ID,
  describeElevenSource,
  elevenKey,
  nodeTooOld,
} from './config.mjs'
import { originAllowed as allowOrigin } from './policy.mjs'
import { SYSTEM_PROMPT, createBrain } from './brain/index.mjs'
import { AppCatalogue } from './apps/catalog.mjs'
import { createTools } from './tools.mjs'
import { createWorkspace, defaultLaunchers } from './workspace.mjs'
import { createConversation, createMetrics } from './assistant.mjs'

/**
 * Several of the APIs below (structuredClone, streaming fetch with
 * FormData, AbortSignal.timeout) need a modern Node. On Windows the default
 * `node` on PATH is frequently an old one left over from another project, and
 * the failure without this check is a stack trace deep inside a dependency.
 */
if (nodeTooOld()) {
  console.error(
    `[jarvis] this is Node ${process.versions.node}; JARVIS needs Node ${MIN_NODE_MAJOR}.19+ or 22.12+.\n` +
      '        On Windows, start it with scripts\\jarvis.ps1, which finds a suitable Node for you.',
  )
  process.exit(1)
}

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive JARVIS's tools - including opening applications - and read back every
 * answer. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const originAllowed = (origin) =>
  allowOrigin(origin, {
    extraOrigins: EXTRA_ORIGINS,
    allowNoOrigin: ALLOW_NO_ORIGIN,
  })

/**
 * What the bridge has actually been doing, for `GET /diagnostics`.
 *
 * Every half of this pipeline fails silently by nature — a microphone that
 * hears nothing, a transcriber that times out and a model that never answers
 * all look identical from the outside, which is "it doesn't work" with no
 * further information. Counting the events makes each one a fact you can read
 * off a page. Nothing here holds a transcript, a key or a spoken line: only
 * counts, timestamps, and error CATEGORIES.
 */
const stats = {
  startedAt: Date.now(),
  clients: 0,
  clientsEver: 0,
  ttsRequests: 0,
  ttsFailures: 0,
  sttRequests: 0,
  sttFailures: 0,
  lastHeardAt: 0,
  lastTtsError: '',
  lastSttError: '',
  /** Asks that actually arrived over the socket - the proof a spoken command
   *  reached the bridge, whichever engine transcribed it. */
  asksReceived: 0,
  lastAskAt: 0,
  /** The page's voice loop, as it last reported it. States and times only. */
  voice: null,
}

const VOICE_STATES = new Set(['OFF', 'WAKE_LISTENING', 'COMMAND_LISTENING', 'TRANSCRIBING', 'THINKING', 'SPEAKING', 'REARMING'])

/** Whitelist the page's voice report: no transcript text crosses this line. */
export function sanitizeVoiceReport(msg) {
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  return {
    engine: msg?.engine === 'elevenlabs' ? 'elevenlabs' : 'browser',
    voiceState: VOICE_STATES.has(msg?.voiceState) ? msg.voiceState : 'OFF',
    wakeListening: msg?.wakeListening === true,
    commandRecognitionActive: msg?.commandRecognitionActive === true,
    ttsActive: msg?.ttsActive === true,
    recognitionGeneration: num(msg?.recognitionGeneration),
    wakes: num(msg?.wakes),
    accepted: num(msg?.accepted),
    lastFinalTranscriptChars: num(msg?.lastFinalTranscriptChars),
    lastUtteranceSentAt: num(msg?.lastUtteranceSentAt),
    lastWakeAt: num(msg?.lastWakeAt),
    reportedAt: Date.now(),
  }
}


/**
 * What the ElevenLabs key can actually DO, as opposed to whether one exists.
 *
 * A key is not a capability. This machine's key carries text_to_speech but not
 * speech_to_text, and the failure that causes is the worst kind: /health says
 * transcription is available, the browser therefore picks Scribe over its own
 * recogniser, every captured segment comes back 401, and JARVIS sits there
 * having never heard a word — with a working microphone and no error anyone
 * would think to look for.
 *
 * So a hard authorisation failure is remembered, and reported. /health stops
 * claiming the capability, and the browser drops to its own recogniser rather
 * than talking to an endpoint that will refuse it every time.
 */
const eleven = { sttDenied: false, ttsDenied: false }

/** 401/403 mean "this key may not" — a fact, not a blip worth retrying. */
const denied = (status) => status === 401 || status === 403


/**
 * ElevenLabs credentials.
 *
 * `elevenKey()` and `VOICE_ID` come from config.mjs, which reads the project's
 * own `.env.local` / `.env` and nothing else - no global configuration of
 * any other tool is read. The browser
 * never sees the key either way: it POSTs text to /tts here and gets audio
 * back, and the value is never logged, not even redacted.
 */

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    // A key is necessary but not sufficient: a capability this key has already
    // been refused for is reported as absent, so the browser uses its own
    // speech instead of an endpoint that will refuse it every time.
    const key = Boolean(elevenKey())
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        ok: true,
        tts: key && !eleven.ttsDenied,
        stt: key && !eleven.sttDenied,
      }),
    )
  }

  /**
   * The bridge half of the diagnostics panel, and the one thing you can curl
   * when the interface itself is the suspect. Deliberately free of anything
   * private: no key, no transcript, no spoken text, no file paths beyond the
   * workspace the user configured themselves.
   */
  /**
   * "Stop, please", for platforms where a signal cannot say it. Authorised by
   * the token in .jarvis/bridge.json — see the shutdown section at the end of
   * this file for why this endpoint exists at all.
   */
  if (req.method === 'POST' && req.url === '/shutdown') {
    if (req.headers['x-jarvis-token'] !== shutdownToken) {
      console.warn('[jarvis] refused a shutdown request with the wrong token')
      res.writeHead(403, cors)
      return res.end('forbidden')
    }
    res.writeHead(200, cors)
    res.end('stopping')
    setTimeout(() => shutdown('a stop request'), 50)
    return
  }

  /**
   * The clap. Takes no body: what starts, where it goes, is fixed in
   * workspace.mjs, and a second clap while one is running is dropped there.
   */
  if (req.method === 'POST' && req.url === '/workspace') {
    const r = await workspace.start({ trigger: 'clap' })
    res.writeHead(r.suppressed ? 409 : 200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: r.ok, suppressed: Boolean(r.suppressed), components: r.data ?? null }))
  }

  if (req.method === 'GET' && req.url === '/diagnostics') {
    const health = await checkBrain()
    const b = brain.diagnostics()
    const apps = catalogue.status()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify(
        {
          ok: true,
          bridge: {
            port: PORT,
            uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
            node: process.versions.node,
            pid: process.pid,
            clients: stats.clients,
            clientsEver: stats.clientsEver,
            runFile: RUN_FILE,
            ownsRunFile,
          },
          brain: {
            mode: 'local',
            provider: b.provider,
            endpoint: b.endpoint,
            keepAlive: brain.primary.keepAlive,
            primary: { model: brain.primary.model, ...health.primary },
            fallback: brain.fallback ? { model: brain.fallback.model, ...health.fallback } : null,
            lastModel: b.last?.model ?? null,
            lastFallbackUsed: b.last?.fallbackUsed ?? false,
            lastLatencyMs: b.last?.latencyMs ?? null,
            lastFirstTokenMs: b.last?.firstTokenMs ?? null,
            lastError: b.last?.error || metrics.lastError || '',
            aiTurns: metrics.aiTurns,
            routerTurns: metrics.routerTurns,
            unavailableTurns: metrics.unavailableTurns,
            cancelledTurns: metrics.cancelledTurns,
            lastSource: metrics.lastSource,
            lastTurnAt: metrics.lastTurnAt,
            cloudRequired: false,
            claudeRuntime: 'none',
          },
          tools: {
            mode: tools.mode,
            writes: ALLOW_WRITES,
            available: tools.names(),
            last: tools.state.last,
            lastResult: tools.state.lastResult,
            lastOk: tools.state.lastOk,
            lastOrigin: tools.state.lastOrigin,
            executed: tools.state.executed,
            rejected: tools.state.rejected,
          },
          apps: {
            ...apps,
            dryRun: LAUNCH_DRY_RUN,
            lastRequested: tools.state.app.requested,
            lastResolved: tools.state.app.resolved,
            resolutionMethod: tools.state.app.method,
            lastLaunch: tools.state.app.launch,
          },
          workspace: workspace.diagnostics(),
          speech: {
            elevenlabsConfigured: Boolean(elevenKey()),
            // A key that exists but has been refused: the difference between
            // "not configured" and "configured and not permitted".
            elevenlabsTtsDenied: eleven.ttsDenied,
            elevenlabsSttDenied: eleven.sttDenied,
            voiceId: VOICE_ID,
            timeoutMs: ELEVEN_TIMEOUT_MS,
            ttsRequests: stats.ttsRequests,
            ttsFailures: stats.ttsFailures,
            sttRequests: stats.sttRequests,
            sttFailures: stats.sttFailures,
            lastHeardAt: stats.lastHeardAt,
            lastTtsError: stats.lastTtsError,
            lastSttError: stats.lastSttError,
          },
          voice: {
            asksReceived: stats.asksReceived,
            lastAskAt: stats.lastAskAt,
            ...(stats.voice ?? { voiceState: 'unreported' }),
          },
          isolation: {
            globalClaudeConfigRead: false,
            mcpServers: [],
            cloudRequired: false,
          },
          env: {
            // Key NAMES that came from the project env files. Never values.
            files: ENV_FILES_LOADED,
          },
        },
        null,
        2,
      ),
    )
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // Already refused once: do not keep calling an endpoint that will refuse
    // again. The browser falls back to its own voice.
    if (eleven.ttsDenied) {
      res.writeHead(403, cors)
      return res.end('elevenlabs speech is not permitted for this key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    /**
     * One bounded wait, and no retries.
     *
     * Carried over from the previous implementation, where an unbounded speech
     * request was a real failure mode: the assistant stood silent with nothing
     * to report while a socket hung. The clock covers the wait for headers;
     * once audio is flowing it is re-armed generously, because cutting a
     * sentence in half mid-stream would be its own bug.
     */
    const ac = new AbortController()
    let timer = setTimeout(() => ac.abort(), ELEVEN_TIMEOUT_MS)
    try {
      const upstream = await fetch(
        `${ELEVEN_BASE}/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
          signal: ac.signal,
        },
      )
      clearTimeout(timer)
      timer = setTimeout(() => ac.abort(), ELEVEN_TIMEOUT_MS * 6)
      if (!upstream.ok) {
        stats.ttsFailures++
        if (denied(upstream.status)) {
          eleven.ttsDenied = true
          console.warn(
            '[jarvis] this ElevenLabs key may not generate speech —' +
              ' falling back to the browser voice from here on',
          )
        }
        // Deliberately not logging the body: an ElevenLabs error can echo the
        // request, and the request carries the line about to be spoken.
        console.warn(`[jarvis] elevenlabs speech refused the request (${upstream.status})`)
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      stats.ttsRequests++

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      stats.ttsFailures++
      const timedOut = err?.name === 'AbortError' || ac.signal.aborted
      stats.lastTtsError = timedOut ? 'timed out' : String(err?.message ?? err)
      console.warn(`[jarvis] speech generation failed: ${stats.lastTtsError}`)
      if (res.headersSent) return res.destroy()
      res.writeHead(504, cors)
      // The browser treats any non-200 here as "fall back to the local voice",
      // so a dead ElevenLabs costs the better voice and nothing else.
      return res.end(timedOut ? 'elevenlabs timed out' : 'elevenlabs unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    if (eleven.sttDenied) {
      req.resume()
      res.writeHead(403, cors)
      return res.end('elevenlabs transcription is not permitted for this key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch(`${ELEVEN_BASE}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
        // Bounded, for the same reason /tts is: a transcription that never
        // returns is a segment of the conversation silently lost, and the
        // browser's queue would stall behind it.
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      })
      if (!upstream.ok) {
        stats.sttFailures++
        stats.lastSttError = `http ${upstream.status}`
        if (denied(upstream.status)) {
          // The measured case: a key with text_to_speech but not
          // speech_to_text. Said once, plainly, because the alternative is an
          // assistant that never hears anything and never says why.
          eleven.sttDenied = true
          console.warn(
            '[jarvis] this ElevenLabs key may not transcribe (missing the' +
              ' speech_to_text permission) — the browser recogniser will be used instead',
          )
        }
        console.warn(`[jarvis] transcription refused the request (${upstream.status})`)
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      stats.sttRequests++
      stats.lastHeardAt = Date.now()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      stats.sttFailures++
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      stats.lastSttError = timedOut ? 'timed out' : String(err?.message ?? err)
      console.warn(`[jarvis] transcription failed: ${stats.lastSttError}`)
      res.writeHead(timedOut ? 504 : 502, cors)
      return res.end(stats.lastSttError)
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
/**
 * Only one bridge at a time.
 *
 * Two of them fighting over 8787 is the confusing kind of broken: the second
 * one dies, the first one is still answering, and which of the two terminals
 * you are looking at decides what you believe. Say plainly which it is.
 */
// ws forwards HTTP server errors before later HTTP listeners run. Handle both.
wss.on('error', () => {})
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `[jarvis] port ${PORT} is already in use — JARVIS is probably already running.\n` +
        '        Stop it with scripts\\stop.ps1, or set JARVIS_BRIDGE_PORT to another port.',
    )
    process.exit(1)
  }
  console.error('[jarvis] the bridge could not start:', err)
  process.exit(1)
})


// ---------------------------------------------------------------------------
// The brain, the hands, and the catalogue of things the hands may open.
// ---------------------------------------------------------------------------

const brain = createBrain(BRAIN)
const metrics = createMetrics()
const catalogue = new AppCatalogue({ cacheFile: APP_CACHE_FILE, registryFile: APPS_FILE })

/** Ollama health, cached briefly so a diagnostics poll is not a request storm. */
let brainHealth = null
let brainHealthAt = 0
async function checkBrain(maxAgeMs = 5000) {
  if (brainHealth && Date.now() - brainHealthAt < maxAgeMs) return brainHealth
  brainHealth = await brain.health()
  brainHealthAt = Date.now()
  return brainHealth
}

/** Pushes to every open interface, e.g. "open the diagnostics panel". */
const broadcastUi = (op, args = {}) => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(JSON.stringify({ type: 'ui', op, args }))
  }
}

/**
 * Restart and stop by voice. Delayed a few seconds so the spoken
 * acknowledgement (which the browser may fetch from /tts here) gets out first.
 * Exit code 75 asks the launcher to start a fresh bridge.
 */
const RESTART_EXIT_CODE = 75
const lifecycle = {
  restart: () => setTimeout(() => shutdown('a restart request', RESTART_EXIT_CODE), 3000).unref(),
  stop: () => setTimeout(() => shutdown('a stop request'), 3000).unref(),
}

/**
 * The clap-started development workspace. Its targets are fixed in
 * workspace.mjs; the terminal it opens does not inherit keys from JARVIS's own
 * env files.
 */
const projectKeys = new Set(ENV_FILES_LOADED.flatMap(({ keys }) => keys))
const workspace = createWorkspace({
  dryRun: LAUNCH_DRY_RUN,
  launchers: defaultLaunchers({
    catalogue,
    interfaceConnected: () => stats.clients > 0,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !projectKeys.has(k))),
  }),
})

const tools = createTools({
  catalogue,
  workspace,
  dryRun: LAUNCH_DRY_RUN,
  allowWrites: ALLOW_WRITES,
  searchEngine: SEARCH_ENGINE,
  ui: broadcastUi,
  lifecycle,
  systemStatus: async () => {
    const h = await checkBrain()
    return {
      brainOnline: Boolean(h.primary?.ok || h.fallback?.ok),
      model: h.primary?.ok ? brain.primary.model : brain.fallback?.model,
    }
  },
})

server.listen(PORT, '127.0.0.1', () => {
  writeRunFile()
  console.log(`[jarvis] bridge listening on ws://localhost:${PORT} (loopback only)`)
  for (const { file, keys } of ENV_FILES_LOADED) {
    // Names only. A value never reaches a log line in this process.
    console.log(
      `[jarvis] read ${file}: ${keys.length ? keys.join(', ') : 'nothing new'}`,
    )
  }
  console.log(`[jarvis] ${describeElevenSource()}`)
  console.log(
    `[jarvis] brain: local Ollama at ${BRAIN.ollamaUrl} · primary ${BRAIN.model}` +
      (brain.fallback ? ` · fallback ${brain.fallback.model}` : '') +
      ` · keep_alive ${BRAIN.keepAlive} · no cloud, no Claude`,
  )
  console.log(
    `[jarvis] mode ${ALLOW_WRITES ? 'WRITES' : 'safe (read-only)'}` +
      (LAUNCH_DRY_RUN ? ' · application launches are DRY RUN' : ''),
  )
  console.log(
    '[jarvis] accepting local dev origins' +
      (EXTRA_ORIGINS.length ? ` plus ${EXTRA_ORIGINS.join(', ')}` : '') +
      (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
  )
  // Neither of these blocks startup. The catalogue loads its cache now and
  // rescans in the background when stale; the model is loaded so the first
  // question is not a cold start. Both degrade quietly if unavailable.
  catalogue
    .ensure()
    .then(() => {
      const s = catalogue.status()
      console.log(`[jarvis] applications: ${s.count} known (${s.status})`)
    })
    .catch((err) => console.warn(`[jarvis] application catalogue unavailable: ${err.message}`))
  void checkBrain(0).then((h) => {
    const describe = (name, x) =>
      x ? `${name} ${x.ok ? (x.loaded ? 'ready (loaded)' : 'ready') : `UNAVAILABLE - ${x.error}`}` : ''
    console.log(
      `[jarvis] ${[describe(BRAIN.model, h.primary), describe(brain.fallback?.model, h.fallback)].filter(Boolean).join(' · ')}`,
    )
    if (h.primary?.ok && !h.primary.loaded && process.env.JARVIS_WARM_MODEL !== '0') void brain.warm()
  })
})

/**
 * Shutting down on purpose.
 *
 * Ctrl-C, `stop.ps1`, a spoken "stop Jarvis", or the launcher taking the other
 * half down: in every case in-flight turns are cancelled and the sockets are
 * closed, or a restart lands on a port still held by a process nobody can see.
 * A real stop also asks Ollama to release the model; a restart keeps it warm.
 */
let shuttingDown = false
const sessions = new Set()

function shutdown(signal, code = 0) {
  if (shuttingDown) {
    return // stdin end and close can both arrive during normal shutdown
  }
  shuttingDown = true
  console.log(`[jarvis] ${signal} — shutting down.`)
  for (const end of sessions) {
    try {
      end()
    } catch {
      /* the session is going away regardless */
    }
  }
  for (const client of wss.clients) {
    try {
      client.close(1001, 'bridge shutting down')
    } catch {
      /* already gone */
    }
  }
  wss.close()
  const keepLoaded = code === RESTART_EXIT_CODE || process.env.JARVIS_UNLOAD_ON_EXIT === '0'
  const released = keepLoaded ? Promise.resolve() : brain.unload()
  const closed = new Promise((resolve) => server.close(resolve))
  void Promise.all([released, closed]).then(() => process.exit(code))
  // A socket that refuses to close must not hold the port for ever; the
  // restart is what the user is waiting for.
  setTimeout(() => process.exit(code), 2000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

/**
 * Stopping cleanly on Windows, which SIGTERM cannot do.
 *
 * On Windows `process.kill(pid, 'SIGTERM')` is TerminateProcess: the handler
 * above never runs, the sockets are never closed, and in-flight model requests
 * are never cancelled. So there are two more ways in, both of which reach the
 * same graceful path:
 *
 *   1. stdin closing. The launcher owns this pipe, so when `npm start` goes
 *      away, so does the bridge — no PID files, no signals.
 *   2. POST /shutdown carrying the token written to .jarvis/bridge.json. The
 *      file is in the user's own directory, so holding the token means already
 *      being the user; it exists so stop.ps1 can ask rather than kill.
 */
const shutdownToken = randomUUID()
const RUN_FILE = join(RUN_DIR, 'bridge.json')

/**
 * Only the instance that actually got the port owns this file.
 *
 * Written from the listen callback rather than at startup, and removed only by
 * whoever wrote it. A second bridge that loses the race for port 8787 must not
 * overwrite the running instance's token on the way in, nor delete its file on
 * the way out — that would leave the real JARVIS running and unstoppable by
 * anything except a kill.
 */
let ownsRunFile = false

function writeRunFile() {
  try {
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(
      RUN_FILE,
      JSON.stringify({ pid: process.pid, port: PORT, token: shutdownToken }, null, 2),
    )
    ownsRunFile = true
  } catch (err) {
    console.warn(`[jarvis] could not write ${RUN_FILE}: ${err.message}`)
  }
}

process.on('exit', () => {
  if (!ownsRunFile) return
  try {
    rmSync(RUN_FILE, { force: true })
  } catch {
    /* nothing to clean up */
  }
})

// The launcher pipes stdin; a bare `npm run bridge` in a terminal does not,
// and an interactive stdin must not be treated as a shutdown request the
// moment it reports end-of-file.
if (!process.stdin.isTTY) {
  process.stdin.on('end', () => shutdown('the launcher exited'))
  process.stdin.on('close', () => shutdown('the launcher exited'))
  process.stdin.resume()
}

/**
 * One conversation per connected interface. The conversation (history, the
 * turn in flight, a pending "which one?") lives here and ends with the socket.
 */
wss.on('connection', (socket) => {
  stats.clients++
  stats.clientsEver++
  console.log('[jarvis] client connected')

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  // Labels for the HUD's systems rail.
  send({ type: 'ready', servers: [`local · ${BRAIN.model}`, 'apps'] })

  const conversation = createConversation({ brain, tools, systemPrompt: SYSTEM_PROMPT, send, metrics })

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg?.type === 'ask' && typeof msg.text === 'string') {
      const id = typeof msg.id === 'string' ? msg.id : null
      stats.asksReceived++
      stats.lastAskAt = Date.now()
      // A new question supersedes the one in flight (barge-in): the old turn
      // is aborted, its model request cancelled, and any late frame it
      // produces carries the old id, which the browser ignores.
      conversation.ask(msg.text.slice(0, 2000), id).catch((err) => {
        console.error('[jarvis] turn failed:', err)
        send({ type: 'error', message: 'That turn failed inside JARVIS.', ask: id })
      })
    } else if (msg?.type === 'interrupt') {
      conversation.interrupt()
    } else if (msg?.type === 'voice') {
      stats.voice = sanitizeVoiceReport(msg)
    }
  })

  const endSession = () => conversation.close()
  sessions.add(endSession)

  socket.on('close', () => {
    stats.clients = Math.max(0, stats.clients - 1)
    console.log('[jarvis] client disconnected')
    sessions.delete(endSession)
    endSession()
  })
})
