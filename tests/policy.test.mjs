/**
 * The permission gate and the origin check.
 *
 * These two functions are the whole security story of the bridge: one decides
 * which pages may drive the agent, the other decides what the agent may do.
 * Both are quiet when they are wrong — a gate that accidentally allows is
 * indistinguishable from one that is working — so they are stated here as
 * facts rather than left to a reading of the code.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideTool,
  isDevPort,
  mcpServerOf,
  mcpToolOf,
  originAllowed,
} from '../bridge/policy.mjs'

const readOnly = (name) => decideTool(name, false)
const withWrites = (name) => decideTool(name, true)

test('read-only built-ins always run', () => {
  for (const name of ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite']) {
    assert.equal(readOnly(name), true, `${name} should run read-only`)
  }
})

test('both spellings of the renamed built-ins are covered', () => {
  // The SDK renamed several tools; a list holding only the old names silently
  // sends the new ones to the write branch, which is the opposite of intent.
  for (const name of ['Task', 'Agent', 'BashOutput', 'TaskOutput', 'ListMcpResourcesTool']) {
    assert.equal(readOnly(name), true, `${name} should be treated as read-only`)
  }
  for (const name of ['KillShell', 'TaskStop']) {
    assert.equal(readOnly(name), false, `${name} should need writes`)
    assert.equal(withWrites(name), true)
  }
})

test('effectful built-ins are refused until writes are enabled', () => {
  for (const name of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(readOnly(name), false, `${name} must not run read-only`)
    assert.equal(withWrites(name), true, `${name} should run with writes`)
  }
})

test('an unknown tool is denied by default rather than allowed', () => {
  assert.equal(readOnly('SomethingBrandNew'), false)
  assert.equal(readOnly('mcp__unknown-server__do_the_thing'), false)
})

test("JARVIS's own interface servers always run", () => {
  for (const name of [
    'mcp__jarvis__display',
    'mcp__jarvis__blade',
    'mcp__jarvis_ui__ui_theme',
    'mcp__jarvis_eyes__look',
    'mcp__jarvis_chrome__chrome_navigate',
  ]) {
    assert.equal(readOnly(name), true, `${name} draws our own screen`)
  }
})

test('read verbs run, effectful verbs wait, wherever they appear in the name', () => {
  assert.equal(readOnly('mcp__android__list_devices'), true)
  assert.equal(readOnly('mcp__android__screenshot'), true)
  assert.equal(readOnly('mcp__android__install_apk'), false)
  // Unanchored on purpose: the verb hides in the middle here.
  assert.equal(readOnly('mcp__twilio__make_outbound_call'), false)
  // ...and a read-sounding name that writes a file is still a write.
  assert.equal(readOnly('mcp__lottie-search__download_lottie'), false)
})

test('the veto applies even to allowlisted servers', () => {
  assert.equal(readOnly('mcp__elevenlabs__search_voices'), true)
  assert.equal(readOnly('mcp__elevenlabs__make_outbound_call'), false)
  assert.equal(readOnly('mcp__higgsfield__generate_image'), true)
  assert.equal(readOnly('mcp__higgsfield__delete_character'), false)
})

test('the veto exemptions are exact, and never leak across servers', () => {
  assert.equal(readOnly('mcp__openrouter__send-message'), true)
  assert.equal(readOnly('mcp__gmail__send-message'), false)
})

test('MCP names split into server and tool, including underscored tools', () => {
  assert.equal(mcpServerOf('mcp__exa__web_search'), 'exa')
  assert.equal(mcpToolOf('mcp__exa__web_search'), 'web_search')
  assert.equal(mcpToolOf('mcp__x__a__b'), 'a__b')
  assert.equal(mcpServerOf('Bash'), null)
})

test('only local dev origins may open the socket', () => {
  assert.equal(originAllowed('http://localhost:5173'), true)
  assert.equal(originAllowed('http://127.0.0.1:5199'), true)
  assert.equal(originAllowed('http://localhost:4173'), true)
  // Not a dev port, so not trusted even on localhost.
  assert.equal(originAllowed('http://localhost:3000'), false)
  assert.equal(originAllowed('https://localhost:5173'), false)
  assert.equal(originAllowed('http://evil.example.com:5173'), false)
  assert.equal(originAllowed('not a url'), false)
})

test('a missing origin is refused unless explicitly permitted', () => {
  assert.equal(originAllowed(undefined), false)
  assert.equal(originAllowed(undefined, { allowNoOrigin: true }), true)
})

test('extra origins are honoured, trailing slash and all', () => {
  const opts = { extraOrigins: ['http://localhost:9000'] }
  assert.equal(originAllowed('http://localhost:9000', opts), true)
  assert.equal(originAllowed('http://localhost:9000/', opts), true)
  assert.equal(originAllowed('http://localhost:9001', opts), false)
})

test('the dev port ranges are the documented ones', () => {
  assert.equal(isDevPort(5173), true)
  assert.equal(isDevPort(5199), true)
  assert.equal(isDevPort(5200), false)
  assert.equal(isDevPort(4173), true)
  assert.equal(isDevPort(4200), false)
})
