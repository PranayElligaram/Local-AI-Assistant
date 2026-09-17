/**
 * Configuration, secrets, and the isolation rule this fork exists to keep.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnvFiles, parseEnv } from '../bridge/env.mjs'
import {
  elevenKey,
  describeElevenSource,
  flag,
  mcpConfigPath,
  nodeTooOld,
  num,
  projectServers,
} from '../bridge/config.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-test-'))

test('env files parse the shapes people actually write', () => {
  const parsed = parseEnv(
    [
      '# a comment',
      '',
      'PLAIN=value',
      '  SPACED  =  padded  ',
      'QUOTED="in quotes"',
      "SINGLE='single quoted'",
      'export EXPORTED=exported',
      'WITH_COMMENT=value # trailing note',
      'EMPTY=',
      'not a pair',
      '1INVALID=nope',
    ].join('\n'),
  )
  assert.equal(parsed.PLAIN, 'value')
  assert.equal(parsed.SPACED, 'padded')
  assert.equal(parsed.QUOTED, 'in quotes')
  assert.equal(parsed.SINGLE, 'single quoted')
  assert.equal(parsed.EXPORTED, 'exported')
  assert.equal(parsed.WITH_COMMENT, 'value')
  assert.equal(parsed.EMPTY, '')
  assert.ok(!('not a pair' in parsed))
  assert.ok(!('1INVALID' in parsed))
})

test('a value containing a # inside quotes survives', () => {
  // API keys contain all sorts of things; stripping a # out of one would fail
  // as an authentication error somewhere else entirely.
  assert.equal(parseEnv('K="abc#def"').K, 'abc#def')
})

test('.env.local wins over .env, and the real environment wins over both', () => {
  const dir = tmp()
  writeFileSync(join(dir, '.env'), 'A=from-env\nB=from-env\nC=from-env\n')
  writeFileSync(join(dir, '.env.local'), 'A=from-local\n')
  const env = { C: 'from-shell' }
  const loaded = loadEnvFiles(dir, env)
  assert.equal(env.A, 'from-local')
  assert.equal(env.B, 'from-env')
  assert.equal(env.C, 'from-shell')
  // The report names keys only — never values, so it can be printed.
  assert.deepEqual(
    loaded.map((l) => l.file),
    ['.env.local', '.env'],
  )
  const flat = JSON.stringify(loaded)
  assert.ok(!flat.includes('from-local'), 'the env report must not carry values')
})

test('a missing env file is not an error', () => {
  const env = {}
  assert.deepEqual(loadEnvFiles(tmp(), env), [])
  assert.deepEqual(env, {})
})

test('booleans are strict, and a typo is reported rather than assumed', () => {
  for (const yes of ['1', 'true', 'YES', 'on']) assert.equal(flag('X', yes, false), true)
  for (const no of ['0', 'false', 'No', 'off']) assert.equal(flag('X', no, true), false)
  assert.equal(flag('X', undefined, true), true)
  assert.equal(flag('X', 'maybe', false), false)
})

test('numbers outside their range fall back instead of poisoning a timeout', () => {
  assert.equal(num('X', '15', { min: 1, max: 60, fallback: 10 }), 15)
  assert.equal(num('X', '0', { min: 1, max: 60, fallback: 10 }), 10)
  assert.equal(num('X', '900', { min: 1, max: 60, fallback: 10 }), 10)
  assert.equal(num('X', 'soon', { min: 1, max: 60, fallback: 10 }), 10)
  assert.equal(num('X', undefined, { min: 1, max: 60, fallback: 10 }), 10)
})

test('the Node floor is enforced', () => {
  assert.equal(nodeTooOld('16.20.2'), true)
  assert.equal(nodeTooOld('18.19.0'), true)
  assert.equal(nodeTooOld('20.0.0'), false)
  assert.equal(nodeTooOld('22.23.2'), false)
})

test('the ElevenLabs key comes from the project environment and nowhere else', () => {
  assert.equal(elevenKey({}), null)
  assert.equal(elevenKey({ ELEVENLABS_API_KEY: '   ' }), null)
  assert.equal(elevenKey({ ELEVENLABS_API_KEY: 'sk-test' }), 'sk-test')
})

test('the key is never part of what gets printed', () => {
  const described = describeElevenSource({ ELEVENLABS_API_KEY: 'sk-secret-value' })
  assert.ok(described.includes('present'))
  assert.ok(!described.includes('sk-secret-value'), 'the banner must not carry the key')
  assert.ok(describeElevenSource({}).includes('no ElevenLabs key'))
})

test('MCP servers are opt-in: no file means no external servers', () => {
  const dir = tmp()
  assert.deepEqual(projectServers({ JARVIS_MCP_CONFIG: join(dir, 'absent.json') }), {})
})

test('a project MCP file is honoured when it exists', () => {
  const dir = tmp()
  const path = join(dir, 'jarvis.mcp.json')
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { exa: { command: 'npx', args: ['exa-mcp'] } } }),
  )
  const servers = projectServers({ JARVIS_MCP_CONFIG: path })
  assert.deepEqual(Object.keys(servers), ['exa'])
})

test('a broken MCP file degrades to none rather than taking the bridge down', () => {
  const dir = tmp()
  const path = join(dir, 'jarvis.mcp.json')
  writeFileSync(path, '{ this is not json')
  assert.deepEqual(projectServers({ JARVIS_MCP_CONFIG: path }), {})

  const wrong = join(dir, 'wrong.json')
  writeFileSync(wrong, JSON.stringify({ servers: [] }))
  assert.deepEqual(projectServers({ JARVIS_MCP_CONFIG: wrong }), {})
})

test('the MCP config path stays inside the project unless made absolute', () => {
  const relative = mcpConfigPath({ JARVIS_MCP_CONFIG: 'custom.json' })
  assert.ok(relative.endsWith('custom.json'))
  assert.ok(!relative.startsWith('custom.json'), 'a relative path resolves against the repo')
  assert.equal(mcpConfigPath({}).endsWith('jarvis.mcp.json'), true)
})
