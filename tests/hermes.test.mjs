import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesBrain, BrainChain, createBrain, SYSTEM_PROMPT, HERMES_PERSONA } from '../bridge/brain/index.mjs'
import { hermesMessages, hermesSystemAddendum, needsCurrentFacts, PRIMING_MESSAGE, SEARCH_NUDGE } from '../bridge/brain/hermes.mjs'
import { brainConfig } from '../bridge/config.mjs'

// Wire format as served by Hermes Agent v0.21.6 (gateway/platforms/api_server*.py).
const ID = 'chatcmpl-0123456789abcdef0123456789abc' // shape of a real completion id
const frame = (chunk, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(chunk)}\n\n`
const chunk = (delta, finish_reason = null, extra = {}) =>
  ({ id: ID, object: 'chat.completion.chunk', model: 'hermes-agent', choices: [{ index: 0, delta, finish_reason }], ...extra })
const toolsets = (enabled = {}) => ({
  object: 'list', platform: 'api_server',
  data: [
    { name: 'web', enabled: Boolean(enabled.web), configured: true, tools: ['web_extract', 'web_search'] },
    { name: 'terminal', enabled: Boolean(enabled.terminal), configured: true, tools: ['process_manage', 'terminal'] },
    { name: 'file', enabled: Boolean(enabled.file), configured: true, tools: ['patch', 'read_file', 'search_files', 'write_file'] },
  ],
})

async function fakeHermes(options = {}) {
  const requests = []
  const state = { sets: options.sets ?? toolsets(), mode: options.mode ?? 'ok', closed: 0, models: options.models ?? ['hermes-agent'] }
  const server = createServer(async (req, res) => {
    const text = await new Promise((done) => { let data = ''; req.on('data', (d) => { data += d }); req.on('end', () => done(data)) })
    requests.push({
      path: req.url, method: req.method, auth: req.headers.authorization,
      sessionKey: req.headers['x-hermes-session-key'], sessionId: req.headers['x-hermes-session-id'],
      body: text ? JSON.parse(text) : null,
    })
    if (req.headers.authorization !== 'Bearer secret-test') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid API key"}}')
      return
    }
    const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.url === '/v1/models') return json(200, { object: 'list', data: state.models.map((id) => ({ id })) })
    if (req.url === '/v1/toolsets') return json(200, state.sets)
    if (req.url.startsWith('/v1/runs/') && req.url.endsWith('/stop')) return json(200, { status: 'stopping' })
    if (req.url !== '/v1/chat/completions') return json(404, {})
    if (state.mode === 'busy') return json(429, { error: { message: 'Too many concurrent runs' } })
    const sse = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'x-hermes-session-id': req.headers['x-hermes-session-id'] ?? 'api-derived' })
    // Hermes interrupts the agent when the SSE client disconnects mid-stream.
    res.on('close', () => { if (!res.writableFinished) state.closed++ })
    const m = state.mode
    if (m === 'never-headers') return // hold the request, send nothing
    sse()
    res.write(frame(chunk({ role: 'assistant' })))
    if (m === 'slow') { res.write(frame(chunk({ content: 'Hello ' }))); return } // keep open until the client aborts
    if (m === 'invalid') return res.end('data: not-json\n\n')
    if (m === 'early') return res.end(frame(chunk({ content: 'Incomplete' })))
    if (m === 'error') return res.end(frame(chunk({}, 'error', { error: { message: 'Ollama loaded `x` with only 4,096 tokens of runtime context', type: 'agent_error' } })) + 'data: [DONE]\n\n')
    if (m === 'approval') return res.end(frame({ approval_id: 'a1', tool: 'terminal' }, 'approval.request'))
    if (m === 'empty') return res.end(frame(chunk({}, 'stop')) + 'data: [DONE]\n\n')
    if (m === 'long') {
      // First text after longer than the connect timeout, as a real cold model does.
      res.write(': keepalive\n\n')
      setTimeout(() => { res.write(frame(chunk({ content: 'Slow but fine.' }, 'stop'))); res.end('data: [DONE]\n\n') }, options.delayMs ?? 300)
      return
    }
    // Progress, status and reasoning must never reach the speaker.
    res.write(frame({ tool: options.progressTool ?? 'web_search', label: 'Searching', status: 'running' }, 'hermes.tool.progress'))
    res.write(frame({ tool: options.progressTool ?? 'web_search', status: 'completed' }, 'hermes.tool.progress'))
    res.write(frame({ text: 'thinking...' }, 'hermes.status'))
    res.write(frame(chunk({ reasoning_content: 'PRIVATE THINKING' })))
    res.write(': keepalive\n\n')
    res.write(frame(chunk({ content: 'Hello ' })))
    res.write(frame(chunk({ content: 'from Hermes.' })))
    res.write(frame(chunk({}, 'stop', { usage: { prompt_tokens: 1100, completion_tokens: 5 } })))
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // closeAllConnections prevents a hung test request from keeping the suite alive.
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests, state,
    chats: () => requests.filter((r) => r.path === '/v1/chat/completions'),
    closedStreams: () => state.closed,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}
const at = (url, overrides = {}) => new HermesBrain({ url, key: 'secret-test', responseTimeoutMs: 2000, connectTimeoutMs: 150, ...overrides })
const ask = (brain, content = 'hi', extra = {}) => brain.chat({ messages: [{ role: 'user', content }], ...extra })
const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-hermes-'))

test('Hermes accepts loopback only, no remote arbitrary tool server', () => {
  assert.throws(() => at('https://example.com/v1'), /local http/)
  assert.throws(() => at('http://192.168.0.2:8642/v1'), /local http/)
  assert.throws(() => at('http://127.0.0.1:8642/v1/extra'), /local http/)
  assert.throws(() => at('http://user:pw@127.0.0.1:8642/v1'), /local http/)
})

test('Hermes config preserves Ollama rollback and does not serialize API key into diagnostics', () => {
  const cfg = brainConfig({ JARVIS_BRAIN_PROVIDER: 'hermes', JARVIS_HERMES_KEY: 'secret-test', JARVIS_HERMES_MODEL: 'hermes-agent' })
  const brain = createBrain(cfg, { hermesSessionFile: null })
  assert.equal(brain.primary.id, 'hermes')
  assert.equal(brain.fallback.id, 'ollama')
  assert.equal(brain.diagnostics().cloudRequired, null)
  assert.doesNotMatch(JSON.stringify(brain.diagnostics()), /secret-test/)
  assert.equal(brain.primary.supportsTools, false)
  // Rollback is one variable: the default build has no Hermes at all.
  assert.equal(createBrain(brainConfig({ JARVIS_HERMES_KEY: 'secret-test' })).primary.id, 'ollama')
})

test('JARVIS_HERMES_FALLBACK=none leaves Hermes alone in the chain; bad values fall back to ollama', () => {
  const none = createBrain(brainConfig({ JARVIS_BRAIN_PROVIDER: 'hermes', JARVIS_HERMES_KEY: 'k', JARVIS_HERMES_FALLBACK: 'none' }), { hermesSessionFile: null })
  assert.deepEqual(none.providers.map((p) => p.id), ['hermes'])
  assert.equal(none.fallback, null)
  assert.equal(brainConfig({ JARVIS_HERMES_FALLBACK: 'cloud' }).hermesFallback, 'ollama')
  const cfg = brainConfig({ JARVIS_HERMES_SESSION_IDLE_MIN: '5', JARVIS_HERMES_SESSION_MAX_TURNS: '3', JARVIS_HERMES_BACKEND_MODEL: 'qwen3.5-4b-64k' })
  assert.equal(cfg.hermesSessionIdleMs, 5 * 60_000)
  assert.equal(cfg.hermesSessionMaxTurns, 3)
  assert.equal(cfg.hermesBackendModel, 'qwen3.5-4b-64k')
  assert.match(cfg.hermesSessionFile, /hermes-session\.json$/)
})

test('streaming ignores reasoning, status and tool progress; never forwards JARVIS tools or history', async (t) => {
  const h = await fakeHermes()
  t.after(h.close)
  const brain = at(h.url)
  const check = await brain.health()
  assert.equal(check.ok, true)
  assert.deepEqual(check.tools, [])
  const out = await brain.chat({ messages: [
    { role: 'system', content: 'Speak briefly' },
    { role: 'user', content: 'open spotify' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'open_application' } }] },
    { role: 'tool', content: 'opened' },
    { role: 'assistant', content: 'Opening Spotify.' },
    { role: 'user', content: 'Hello' },
  ], tools: [{ type: 'function', function: { name: 'delete_file' } }] })
  assert.equal(out.text, 'Hello from Hermes.')
  const [req] = h.chats()
  assert.equal(req.auth, 'Bearer secret-test')
  assert.equal(req.sessionKey, 'jarvis:desktop:primary')
  assert.match(req.sessionId, /^jarvis_\d+_[0-9a-f]+$/)
  assert.equal(req.body.model, 'hermes-agent')
  assert.equal(req.body.stream, true)
  // Hermes loads history for the session itself: only system + newest user turn.
  assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user'])
  assert.equal(req.body.messages[1].content, 'Hello')
  assert.match(req.body.messages[0].content, /^Speak briefly\n\n/)
  assert.match(req.body.messages[0].content, /no web access/)
  assert.equal(req.body.tools, undefined)
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE THINKING|Searching|thinking\.\.\./)
})

test('the system addendum follows the live tool inventory, so web success is never invented', async (t) => {
  assert.match(hermesSystemAddendum({ web: false }), /cannot look it up/)
  assert.match(hermesSystemAddendum({ web: true }), /web_search/)
  assert.deepEqual(hermesMessages([{ role: 'assistant', content: 'x' }]), [])
  const h = await fakeHermes({ sets: toolsets({ web: true }) })
  t.after(h.close)
  const brain = at(h.url)
  await ask(brain)
  assert.match(h.chats()[0].body.messages[0].content, /MUST call web_search/)
  assert.deepEqual(brain.diagnostics().enabledTools, ['web_extract', 'web_search'])
})

test('a session id is reused across turns, persisted, and rotated after idle time or too many turns', async (t) => {
  const h = await fakeHermes()
  t.after(h.close)
  const file = join(tmp(), 'hermes-session.json')
  let clock = 1_000_000
  const make = () => at(h.url, { sessionFile: file, sessionIdleMs: 60_000, sessionMaxTurns: 3, now: () => clock })
  const brain = make()
  await ask(brain, 'one')
  await ask(brain, 'two')
  const [a, b] = h.chats()
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).turns, 2)
  // A restarted JARVIS resumes the same conversation.
  await ask(make(), 'three')
  assert.equal(h.chats()[2].sessionId, a.sessionId)
  // Turn limit reached: a new conversation starts.
  await ask(make(), 'four')
  assert.notEqual(h.chats()[3].sessionId, a.sessionId)
  const fourth = h.chats()[3].sessionId
  // Long silence: a new conversation starts.
  clock += 61_000
  await ask(make(), 'five')
  assert.notEqual(h.chats()[4].sessionId, fourth)
  // resetSession() starts fresh immediately; a corrupt file is ignored safely.
  const r = make()
  const before = r.currentSession().id
  r.resetSession()
  assert.notEqual(r.currentSession().id, before)
  writeFileSync(file, '{"id":"../../etc/passwd","turns":1}')
  assert.match(make().currentSession().id, /^jarvis_\d+_[0-9a-f]+$/)
})

test('any powerful Hermes tool blocks the agent call (even if the gateway stays up)', async (t) => {
  const h = await fakeHermes({ sets: toolsets({ web: true, file: true }) })
  t.after(h.close)
  const b = at(h.url)
  assert.equal((await b.health()).ok, false)
  await assert.rejects(ask(b), (e) => e.code === 'provider_error' && /unapproved tools enabled \(file\)/.test(e.message))
  assert.equal(h.chats().length, 0)
  h.state.sets = toolsets({ terminal: true })
  await assert.rejects(ask(b), (e) => /unapproved tools enabled \(terminal\)/.test(e.message))
  h.state.sets = toolsets({ web: true })
  assert.equal((await b.health()).ok, true)
  assert.equal((await ask(b)).text, 'Hello from Hermes.')
})

test('missing or malformed tool inventory fails closed, never calls Hermes', async (t) => {
  for (const sets of [{ bogus: true }, { data: [{ name: 'web' }] }, 'nope']) {
    const h = await fakeHermes({ sets })
    t.after(h.close)
    await assert.rejects(ask(at(h.url)), (e) => e.code === 'bad_response')
    assert.equal(h.chats().length, 0)
  }
})

test('health reports a model Hermes does not serve', async (t) => {
  const h = await fakeHermes({ models: ['other-profile'] })
  t.after(h.close)
  const out = await at(h.url).health()
  assert.equal(out.ok, false)
  assert.equal(out.reachable, true)
  assert.match(out.error, /does not serve model "hermes-agent"/)
})

test('unauthorized, busy, malformed, early, empty or failed output is never treated as an answer', async (t) => {
  const wrongKey = await fakeHermes()
  t.after(wrongKey.close)
  await assert.rejects(at(wrongKey.url, { key: 'wrong' }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e.code === 'provider_error' && /authentication failed/.test(e.message))
  await assert.rejects(at(wrongKey.url, { key: '' }).chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (e) => /not configured/.test(e.message))
  for (const [mode, code, pattern] of [
    ['busy', 'provider_error', /busy/],
    ['invalid', 'bad_response', /malformed/],
    ['early', 'stream_failed', /prematurely/],
    ['empty', 'empty', /empty/],
    ['error', 'provider_error', /generation failed: Ollama loaded `x` with only 4,096 tokens/],
    ['approval', 'provider_error', /approval JARVIS does not grant/],
  ]) {
    const h = await fakeHermes({ mode })
    t.after(h.close)
    const brain = at(h.url)
    await assert.rejects(ask(brain), (e) => e.code === code && pattern.test(e.message), mode)
    assert.match(brain.diagnostics().lastError, new RegExp(`^${code}:`), mode)
  }
})

test('the connect deadline covers headers only: a slow first token is not cut off', async (t) => {
  const h = await fakeHermes({ mode: 'long', delayMs: 400 })
  t.after(h.close)
  // 400 ms to first token, connect deadline 150 ms: must still succeed.
  assert.equal((await ask(at(h.url))).text, 'Slow but fine.')
  const silent = await fakeHermes({ mode: 'never-headers' })
  t.after(silent.close)
  await assert.rejects(ask(at(silent.url, { responseTimeoutMs: 5000 })), (e) => e.code === 'timeout')
})

test('barge-in and the turn deadline close the stream (which is what interrupts a Hermes run)', async (t) => {
  const h = await fakeHermes({ mode: 'slow' })
  t.after(h.close)
  const ac = new AbortController()
  const b = at(h.url)
  await assert.rejects((async () => {
    for await (const ev of b.stream({ messages: [{ role: 'user', content: 'hi' }], signal: ac.signal })) {
      if (ev.type === 'text') ac.abort()
    }
  })(), (e) => e.code === 'aborted')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(h.closedStreams(), 1, 'client socket closed on barge-in')
  assert.equal(b.lastError, '', 'a cancelled turn is not an error')
  await assert.rejects(at(h.url, { responseTimeoutMs: 200 }).chat({ messages: [{ role: 'user', content: 'hello' }] }), (e) => e.code === 'timeout')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(h.closedStreams(), 2, 'client socket closed on timeout')
  // An already-aborted signal never reaches Hermes.
  const done = new AbortController()
  done.abort()
  const n = h.chats().length
  await assert.rejects(b.chat({ messages: [{ role: 'user', content: 'x' }], signal: done.signal }), (e) => e.code === 'aborted')
  assert.equal(h.chats().length, n)
})

test('Hermes offline falls back to Ollama on another endpoint', async () => {
  const primary = at('http://127.0.0.1:9/v1')
  const fallback = { id: 'ollama', model: 'granite4:3b', url: 'http://127.0.0.1:11434', async *stream() { yield { type: 'text', delta: 'Ollama answer.' } }, async health() { return { ok: true } }, diagnostics() { return {} } }
  const chain = new BrainChain([primary, fallback])
  const events = []
  for await (const e of chain.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
  assert.deepEqual(events[0], { type: 'model', provider: 'ollama', model: 'granite4:3b', fallbackUsed: true })
  assert.equal(events.find((e) => e.type === 'text').delta, 'Ollama answer.')
  assert.equal((await primary.health()).reachable, false)
  // Without a fallback the failure is explicit.
  await assert.rejects((async () => { for await (const _ of new BrainChain([primary]).stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } })(),
    (e) => e.code === 'offline')
})

test('Hermes gets its own JARVIS persona, never the Ollama prompt naming JARVIS tools', async (t) => {
  const h = await fakeHermes()
  t.after(h.close)
  const brain = createBrain(brainConfig({ JARVIS_BRAIN_PROVIDER: 'hermes', JARVIS_HERMES_KEY: 'secret-test', JARVIS_HERMES_URL: h.url }), { hermesSessionFile: null }).primary
  await brain.chat({ messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'hi' }] })
  const system = h.chats()[0].body.messages[0].content
  assert.ok(system.startsWith(HERMES_PERSONA))
  assert.match(SYSTEM_PROMPT, /search_web/, 'the Ollama prompt does name JARVIS tools')
  assert.doesNotMatch(system, /search_web|no live internet access/)
})

test('prepare() primes a new session once; the first real question then continues it', async (t) => {
  const h = await fakeHermes()
  t.after(h.close)
  const brain = at(h.url)
  assert.equal(await brain.prepare(), true)
  assert.equal(await brain.prepare(), false, 'a session already in use is left alone')
  await ask(brain, 'real question')
  const [prime, real] = h.chats()
  assert.equal(prime.body.messages.at(-1).content, PRIMING_MESSAGE)
  assert.equal(real.body.messages.at(-1).content, 'real question')
  assert.equal(prime.sessionId, real.sessionId)
  assert.equal(brain.diagnostics().priming.last.ok, true)
  // Disabled, or no key: nothing is sent.
  const off = await fakeHermes()
  t.after(off.close)
  assert.equal(await at(off.url, { prime: false }).prepare(), false)
  assert.equal(await at(off.url, { key: '' }).prepare(), false)
  assert.equal(off.chats().length, 0)
})

test('a question asked while priming waits for it instead of racing it on the same session', async (t) => {
  const h = await fakeHermes({ mode: 'long', delayMs: 300 })
  t.after(h.close)
  const brain = at(h.url)
  const primed = brain.prepare()
  const answer = await ask(brain, 'real question')
  assert.equal(await primed, true)
  assert.equal(answer.text, 'Slow but fine.')
  const [prime, real] = h.chats()
  assert.equal(prime.body.messages.at(-1).content, PRIMING_MESSAGE)
  assert.equal(real.body.messages.at(-1).content, 'real question')
  assert.equal(prime.sessionId, real.sessionId)
  // Barge-in while waiting for the prime cancels cleanly.
  const again = at(h.url, { sessionFile: null })
  void again.prepare()
  const ac = new AbortController()
  const pending = again.chat({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal })
  ac.abort()
  await assert.rejects(pending, (e) => e.code === 'aborted')
})

test("a session's last turn opens and primes the next session in the background", async (t) => {
  const h = await fakeHermes()
  t.after(h.close)
  const brain = at(h.url, { sessionMaxTurns: 2 })
  await ask(brain, 'one')
  await ask(brain, 'two')
  await new Promise((r) => setTimeout(r, 200))
  const [one, two, next] = h.chats()
  assert.equal(one.sessionId, two.sessionId)
  assert.equal(next?.body.messages.at(-1).content, PRIMING_MESSAGE)
  assert.notEqual(next.sessionId, one.sessionId)
  await ask(brain, 'three')
  assert.equal(h.chats()[3].sessionId, next.sessionId)
})

test("exit never unloads a model in Hermes mode (Ollama would evict Hermes' model sharing the weights)", async () => {
  const calls = []
  const fetch = async (url, init) => { calls.push({ url, body: init?.body }); return new Response('{}') }
  await createBrain(brainConfig({ JARVIS_BRAIN_PROVIDER: 'hermes', JARVIS_HERMES_KEY: 'k' }), { fetch, hermesSessionFile: null }).unload()
  assert.deepEqual(calls, [])
  // The default Ollama build still releases its models on exit.
  await createBrain(brainConfig({}), { fetch }).unload()
  assert.equal(calls.length, 2)
  assert.ok(calls.every((c) => JSON.parse(c.body).keep_alive === 0))
})

test('warm() preloads only the configured backend model and never throws', async (t) => {
  const seen = []
  const ollama = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => { seen.push({ path: req.url, body: JSON.parse(body) }); res.writeHead(200).end('{}') })
  })
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => ollama.close(r)))
  const url = `http://127.0.0.1:${ollama.address().port}`
  assert.equal(await at('http://127.0.0.1:8642/v1').warm(), false)
  assert.equal(await at('http://127.0.0.1:8642/v1', { backend: { url, model: 'qwen3.5-4b-64k', keepAlive: '30m' } }).warm(), true)
  assert.deepEqual(seen, [{ path: '/api/generate', body: { model: 'qwen3.5-4b-64k', keep_alive: '30m' } }])
  assert.equal(await at('http://127.0.0.1:8642/v1', { backend: { url: 'http://127.0.0.1:9', model: 'm' } }).warm(), false)
})

test('a passing tool-policy check is reused briefly; a failing one never is, and the wake word refreshes it', async (t) => {
  const h = await fakeHermes({ sets: toolsets({ web: true }) })
  t.after(h.close)
  let clock = 1_000_000
  const brain = at(h.url, { now: () => clock, policyMaxAgeMs: 30_000 })
  const policyChecks = () => h.requests.filter((r) => r.path === '/v1/toolsets').length
  await ask(brain, 'one')
  assert.equal(policyChecks(), 1)
  clock += 10_000
  await ask(brain, 'two')
  assert.equal(policyChecks(), 1, 'within the window the verdict stands: no 0.45 s round trip')
  clock += 30_000
  await ask(brain, 'three')
  assert.equal(policyChecks(), 2, 'an old verdict is re-checked before the turn')
  // A failure is never reused: every following turn checks again until it passes.
  h.state.sets = toolsets({ web: true, terminal: true })
  clock += 30_000
  await assert.rejects(ask(brain, 'four'), /unapproved tools enabled \(terminal\)/)
  await assert.rejects(ask(brain, 'five'), /unapproved tools enabled \(terminal\)/)
  assert.equal(policyChecks(), 4)
  assert.equal(h.chats().length, 3, 'no agent call while unapproved tools are enabled')
  // The wake word (prepare) refreshes the verdict on a live session.
  h.state.sets = toolsets({ web: true })
  assert.equal(await brain.prepare(), false)
  assert.equal(policyChecks(), 5)
  await ask(brain, 'six')
  assert.equal(policyChecks(), 5, 'the question right after the wake word reuses that check')
  assert.ok(brain.diagnostics().policyCheckedAt > 0)
})

test("an allowed tool starting is passed on by name only, so JARVIS can say 'Searching.'", async (t) => {
  const h = await fakeHermes()
  t.after(h.close)
  const events = []
  for await (const ev of at(h.url).stream({ messages: [{ role: 'user', content: 'latest node?' }] })) events.push(ev)
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [{ type: 'tool', name: 'web_search' }])
  assert.ok(events.findIndex((e) => e.type === 'tool') < events.findIndex((e) => e.type === 'text'))
  // The query (label) is never passed on, and a tool outside the allowlist is not named.
  assert.doesNotMatch(JSON.stringify(events), /Searching|label/)
  const odd = await fakeHermes({ progressTool: 'terminal' })
  t.after(odd.close)
  const frames = []
  for await (const ev of at(odd.url).stream({ messages: [{ role: 'user', content: 'x' }] })) frames.push(ev)
  assert.equal(frames.filter((e) => e.type === 'tool').length, 0)
})

test('health asks Hermes which model it runs only every ten minutes (each call costs the gateway ~0.9 s)', async (t) => {
  const h = await fakeHermes()
  t.after(h.close)
  let clock = 1_000_000
  const brain = at(h.url, { now: () => clock })
  const optionCalls = () => h.requests.filter((r) => r.path === '/api/model/options').length
  await brain.health()
  await brain.health()
  clock += 60_000
  await brain.health()
  assert.equal(optionCalls(), 1)
  clock += 10 * 60_000
  await brain.health()
  assert.equal(optionCalls(), 2)
  // The tool inventory, which IS security-relevant, is still read by every health check.
  assert.equal(h.requests.filter((r) => r.path === '/v1/toolsets').length, 4)
})

test('JARVIS_HERMES_KEEP_WARM_MIN sets how often the model keep_alive is renewed (0 = never)', () => {
  assert.equal(brainConfig({}).hermesKeepWarmMs, 10 * 60_000)
  assert.equal(brainConfig({ JARVIS_HERMES_KEEP_WARM_MIN: '0' }).hermesKeepWarmMs, 0)
  assert.equal(brainConfig({ JARVIS_HERMES_KEEP_WARM_MIN: '5' }).hermesKeepWarmMs, 5 * 60_000)
  assert.equal(brainConfig({ JARVIS_HERMES_KEEP_WARM_MIN: 'soon' }).hermesKeepWarmMs, 10 * 60_000)
})

test("the chain's first-token time is the first WORDS, not a tool starting", async () => {
  const slow = {
    id: 'hermes', model: 'hermes-agent',
    async *stream() {
      yield { type: 'tool', name: 'web_search' }
      await new Promise((r) => setTimeout(r, 60))
      yield { type: 'text', delta: 'Answer.' }
      yield { type: 'done' }
    },
    health: async () => ({ ok: true }), diagnostics: () => ({}),
  }
  const chain = new BrainChain([slow])
  const seen = []
  for await (const ev of chain.stream({ messages: [] })) seen.push(ev.type)
  assert.deepEqual(seen, ['model', 'tool', 'text', 'done'])
  assert.ok(chain.last.firstTokenMs >= 50, `first words at ${chain.last.firstTokenMs} ms`)
})

test('a time-sensitive question carries a search instruction at the end of the turn, only when web search exists', async (t) => {
  for (const q of ['What is the latest version of Node.js?', "what's the weather tomorrow", 'who won the race yesterday', 'news today']) {
    assert.equal(needsCurrentFacts(q), true, q)
  }
  for (const q of ['Explain how a rainbow forms.', 'What is the capital of Australia?', 'tell me a joke', 'open spotify']) {
    assert.equal(needsCurrentFacts(q), false, q)
  }
  const msgs = [{ role: 'user', content: 'What is the latest version of Node.js?' }]
  assert.equal(hermesMessages(msgs, { web: true }).at(-1).content, `What is the latest version of Node.js?
${SEARCH_NUDGE}`)
  assert.equal(hermesMessages(msgs, { web: false }).at(-1).content, 'What is the latest version of Node.js?', 'no web: no promise of a search')
  const h = await fakeHermes({ sets: toolsets({ web: true }) })
  t.after(h.close)
  const brain = at(h.url)
  await ask(brain, 'Explain how a rainbow forms.')
  await ask(brain, 'what is the latest python release')
  const [plain, current] = h.chats().map((r) => r.body.messages.at(-1).content)
  assert.equal(plain, 'Explain how a rainbow forms.')
  assert.ok(current.endsWith(SEARCH_NUDGE))
  // The system message stays byte-identical across turns: the cached prefix survives.
  assert.equal(h.chats()[0].body.messages[0].content, h.chats()[1].body.messages[0].content)
})
