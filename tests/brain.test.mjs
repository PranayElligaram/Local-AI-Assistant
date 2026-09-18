/**
 * The local brain, against a fake Ollama that can be made to misbehave in every
 * way the real one does: offline, slow, missing model, malformed stream, error
 * chunk, early end. None of those may ever come back as an "answer".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { BrainChain, BrainError, OllamaBrain, createBrain } from '../bridge/brain/index.mjs'
import { parseKeepAlive } from '../bridge/brain/ollama.mjs'
import { brainConfig } from '../bridge/config.mjs'

/** A fake Ollama. `behaviour[model]` decides how /api/chat answers. */
async function fakeOllama(behaviour, { installed = Object.keys(behaviour) } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ models: installed.map((name) => ({ name })) }))
      }
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ models: [] }))
      }
      const json = JSON.parse(body || '{}')
      requests.push(json)
      const b = behaviour[json.model]
      if (!b) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: `model '${json.model}' not found` }))
      }
      await b(res, json)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, requests, close: () => new Promise((r) => server.close(r)) }
}

const line = (o) => JSON.stringify(o) + '\n'
const streamText = (...parts) => (res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  for (const p of parts) res.write(line({ message: { role: 'assistant', content: p }, done: false }))
  res.end(line({ message: { role: 'assistant', content: '' }, done: true, eval_count: parts.length }))
}

const brainAt = (url, model, extra = {}) =>
  new OllamaBrain({ url, model, connectTimeoutMs: 500, responseTimeoutMs: 400, loadTimeoutMs: 600, ...extra })

test('granite is the default brain, qwen the fallback, with keep_alive and no secret', () => {
  const cfg = brainConfig({})
  assert.equal(cfg.provider, 'ollama')
  assert.equal(cfg.ollamaUrl, 'http://127.0.0.1:11434')
  assert.equal(cfg.model, 'granite4:3b')
  assert.equal(cfg.fallbackModel, 'qwen3.5:4b')
  assert.equal(cfg.keepAlive, '30m')
  assert.ok(cfg.connectTimeoutMs > 0 && cfg.responseTimeoutMs > 0 && cfg.loadTimeoutMs >= cfg.responseTimeoutMs)
  assert.ok(cfg.maxTokens > 0)
  const chain = createBrain(cfg)
  assert.equal(chain.primary.model, 'granite4:3b')
  assert.equal(chain.fallback.model, 'qwen3.5:4b')
  assert.equal(chain.diagnostics().claudeRuntime, 'none')
  assert.equal(chain.diagnostics().cloudRequired, false)
})

test('configuration is overridable, and a bad Ollama URL falls back to localhost', () => {
  const cfg = brainConfig({ JARVIS_LOCAL_MODEL: 'x:1b', JARVIS_OLLAMA_URL: 'file:///etc', JARVIS_MODEL_KEEP_ALIVE: '5m' })
  assert.equal(cfg.model, 'x:1b')
  assert.equal(cfg.ollamaUrl, 'http://127.0.0.1:11434')
  assert.equal(cfg.keepAlive, '5m')
  assert.throws(() => createBrain({ ...cfg, provider: 'anthropic' }), /not supported/)
})

test('keep_alive strings are understood', () => {
  assert.equal(parseKeepAlive('30m'), 1_800_000)
  assert.equal(parseKeepAlive('90s'), 90_000)
  assert.equal(parseKeepAlive('1h'), 3_600_000)
  assert.equal(parseKeepAlive('nonsense'), 0)
})

test('a streamed answer arrives in order, with keep_alive, think:false and a length cap', async (t) => {
  const o = await fakeOllama({ 'granite4:3b': streamText('Paris ', 'is the ', 'capital.') })
  t.after(o.close)
  const brain = brainAt(o.url, 'granite4:3b', { maxTokens: 64 })
  const out = await brain.chat({ messages: [{ role: 'user', content: 'capital of France?' }] })
  assert.equal(out.text, 'Paris is the capital.')
  assert.equal(o.requests[0].keep_alive, '30m')
  assert.equal(o.requests[0].think, false)
  assert.equal(o.requests[0].stream, true)
  assert.equal(o.requests[0].options.num_predict, 64)
})

test('structured tool calls come back as data, not text', async (t) => {
  const o = await fakeOllama({
    'granite4:3b': (res) => {
      res.writeHead(200)
      res.write(line({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'open_application', arguments: { name: 'Spotify' } } }] }, done: false }))
      res.end(line({ message: { content: '' }, done: true }))
    },
  })
  t.after(o.close)
  const out = await brainAt(o.url, 'granite4:3b').chat({ messages: [], tools: [{ type: 'function', function: { name: 'open_application' } }] })
  assert.deepEqual(out.toolCalls, [{ name: 'open_application', arguments: { name: 'Spotify' } }])
  assert.equal(o.requests[0].tools.length, 1)
})

test('Ollama offline is an "offline" error, never an answer', async () => {
  const brain = brainAt('http://127.0.0.1:9', 'granite4:3b')
  await assert.rejects(brain.chat({ messages: [] }), (e) => e instanceof BrainError && e.code === 'offline')
  const h = await brain.health()
  assert.equal(h.ok, false)
  assert.equal(h.reachable, false)
})

test('a model that never answers times out instead of hanging', async (t) => {
  const o = await fakeOllama({ 'granite4:3b': () => {} })
  t.after(o.close)
  await assert.rejects(brainAt(o.url, 'granite4:3b').chat({ messages: [] }), (e) => e.code === 'timeout')
})

test('a stream that stalls part way times out', async (t) => {
  const o = await fakeOllama({
    'granite4:3b': (res) => {
      res.writeHead(200)
      res.write(line({ message: { content: 'Half an ' }, done: false }))
    },
  })
  t.after(o.close)
  await assert.rejects(brainAt(o.url, 'granite4:3b').chat({ messages: [] }), (e) => e.code === 'timeout')
})

test('a missing model is reported as missing', async (t) => {
  const o = await fakeOllama({}, { installed: [] })
  t.after(o.close)
  const brain = brainAt(o.url, 'granite4:3b')
  await assert.rejects(brain.chat({ messages: [] }), (e) => e.code === 'model_missing')
  const h = await brain.health()
  assert.equal(h.reachable, true)
  assert.equal(h.installed, false)
  assert.match(h.error, /ollama pull granite4:3b/)
})

test('malformed JSON, error chunks, early ends and empty answers are all failures', async (t) => {
  const o = await fakeOllama({
    bad: (res) => {
      res.writeHead(200)
      res.end('{"message": {"content": "hi"\n')
    },
    errchunk: (res) => {
      res.writeHead(200)
      res.end(line({ error: 'out of memory' }))
    },
    early: (res) => {
      res.writeHead(200)
      res.end(line({ message: { content: 'I was about to' }, done: false }))
    },
    empty: (res) => {
      res.writeHead(200)
      res.end(line({ message: { content: '' }, done: true }))
    },
    http500: (res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
    },
  })
  t.after(o.close)
  const code = async (model) => {
    try {
      await brainAt(o.url, model).chat({ messages: [] })
      return 'answered'
    } catch (e) {
      return e.code
    }
  }
  assert.equal(await code('bad'), 'bad_response')
  assert.equal(await code('errchunk'), 'provider_error')
  assert.equal(await code('early'), 'stream_failed')
  assert.equal(await code('empty'), 'empty')
  assert.equal(await code('http500'), 'provider_error')
})

test('granite failing before it speaks hands the turn to qwen', async (t) => {
  const o = await fakeOllama({ 'qwen3.5:4b': streamText('Qwen here.') }, { installed: ['qwen3.5:4b'] })
  t.after(o.close)
  const chain = new BrainChain([brainAt(o.url, 'granite4:3b'), brainAt(o.url, 'qwen3.5:4b')])
  const events = []
  for await (const ev of chain.stream({ messages: [] })) events.push(ev)
  assert.deepEqual(events[0], { type: 'model', provider: 'ollama', model: 'qwen3.5:4b', fallbackUsed: true })
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Qwen here.')
  assert.equal(chain.last.model, 'qwen3.5:4b')
  assert.equal(chain.last.fallbackUsed, true)
  // think:false is sent to qwen as well.
  assert.equal(o.requests.at(-1).think, false)
})

test('the fallback is not tried when Ollama itself is offline, and the error surfaces', async () => {
  let tried = 0
  const offline = {
    id: 'ollama',
    model: 'a',
    async *stream() {
      tried++
      if (tried) throw new BrainError('offline', 'down')
      yield { type: 'text', delta: 'unreachable' }
    },
  }
  const chain = new BrainChain([offline, { ...offline, model: 'b' }])
  await assert.rejects(async () => {
    for await (const _ of chain.stream({ messages: [] })) void _
  }, (e) => e.code === 'offline')
  assert.equal(tried, 1)
  assert.match(chain.last.error, /offline/)
})

test('once words are out, the model is never switched mid-answer', async () => {
  const flaky = {
    id: 'ollama',
    model: 'granite4:3b',
    async *stream() {
      yield { type: 'text', delta: 'The answer is ' }
      throw new BrainError('stream_failed', 'cut')
    },
  }
  let fallbackUsed = false
  const backup = {
    id: 'ollama',
    model: 'qwen3.5:4b',
    async *stream() {
      fallbackUsed = true
      yield { type: 'text', delta: 'x' }
    },
  }
  const chain = new BrainChain([flaky, backup])
  await assert.rejects(async () => {
    for await (const _ of chain.stream({ messages: [] })) void _
  }, (e) => e.code === 'stream_failed')
  assert.equal(fallbackUsed, false)
})

test('cancelling a turn aborts the model request', async (t) => {
  let closed = false
  const o = await fakeOllama({
    'granite4:3b': (res, _json) => {
      res.writeHead(200)
      res.write(line({ message: { content: 'Long ' }, done: false }))
      res.on('close', () => (closed = true))
    },
  })
  t.after(o.close)
  const ac = new AbortController()
  const brain = brainAt(o.url, 'granite4:3b', { responseTimeoutMs: 5000, loadTimeoutMs: 5000 })
  const run = (async () => {
    for await (const ev of brain.stream({ messages: [], signal: ac.signal })) if (ev.type === 'text') ac.abort()
  })()
  await assert.rejects(run, (e) => e.code === 'aborted')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(closed, true)
})
