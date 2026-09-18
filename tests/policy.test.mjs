/**
 * The origin check: which pages may drive the bridge at all. (What the
 * assistant may do is the tool registry's job - see tools.test.mjs.)
 *
 * It is quiet when it is wrong — a gate that accidentally allows is
 * indistinguishable from one that is working — so they are stated here as
 * facts rather than left to a reading of the code.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isDevPort, originAllowed } from '../bridge/policy.mjs'

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
