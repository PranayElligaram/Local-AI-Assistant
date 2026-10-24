/**
 * The deterministic router: obvious requests are recognised without a model,
 * and conversation is left for the model.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { knownSite, normalizeUtterance, pickChoice, route, routeSoftApp } from '../bridge/router.mjs'

const tool = (text) => route(text)?.tool ?? null

test('time and date are always local, whatever the phrasing', () => {
  for (const s of ['What time is it?', 'Tell me the time.', "what's the time", 'Hey Jarvis, what time is it', 'Jarvis what time is it please', 'Could you tell me the time?'])
    assert.equal(tool(s), 'get_time', s)
  for (const s of ["What's today's date?", 'What date is it?', 'What day is it?', "what's the date today", 'Tell me the date'])
    assert.equal(tool(s), 'get_date', s)
})

test('obvious application requests become open_application with the name only', () => {
  const cases = {
    'Open Spotify.': 'Spotify',
    'Launch Chrome': 'Chrome',
    'Open Word': 'Word',
    'open VS Code': 'VS Code',
    'Open Calculator please': 'Calculator',
    'Jarvis, could you open the Spotify app for me?': 'Spotify',
    'start notepad': 'notepad',
    'fire up Discord': 'Discord',
  }
  for (const [s, name] of Object.entries(cases)) assert.deepEqual(route(s), { tool: 'open_application', args: { name } }, s)
})

test('direct searches build a search, with the query as said', () => {
  assert.deepEqual(route('Search Google for Formula 1 results'), { tool: 'search_web', args: { query: 'Formula 1 results' } })
  assert.equal(tool('google the weather in Paris'), 'search_web')
  assert.equal(tool('search for cheap flights to Rome'), 'search_web')
  assert.equal(tool('look up Python decorators on Google'), 'search_web')
})

test('research requests are told apart from plain searches', () => {
  assert.equal(tool('Research the latest battery technology and summarise it'), 'research_web')
  assert.equal(tool("what's the latest on the Mars mission"), 'research_web')
})

test('URLs and spoken domains open in the browser', () => {
  assert.deepEqual(route('Open https://example.com'), { tool: 'open_url', args: { url: 'https://example.com' } })
  assert.deepEqual(route('go to example dot com'), { tool: 'open_url', args: { url: 'example.com' } })
  assert.equal(tool('visit bbc.co.uk'), 'open_url')
})

test('known websites open at their exact trusted URL, whatever browser is named', () => {
  const cases = {
    'Open YouTube': 'https://www.youtube.com',
    'Open YouTube in Google': 'https://www.youtube.com',
    'Open YouTube in Chrome': 'https://www.youtube.com',
    'Open Gmail in Chrome': 'https://mail.google.com',
    'Open Gmail in Google Chrome': 'https://mail.google.com',
    'Open Google Drive': 'https://drive.google.com',
    'open drive in the browser': 'https://drive.google.com',
    'Open Calendar': 'https://calendar.google.com',
    'Open Google Calendar': 'https://calendar.google.com',
    'Open Google Maps': 'https://maps.google.com',
    'open maps in browser': 'https://maps.google.com',
    'Open GitHub': 'https://github.com',
    'Hey Jarvis, open Reddit please': 'https://www.reddit.com',
    'go to youtube': 'https://www.youtube.com',
  }
  for (const [s, url] of Object.entries(cases)) assert.deepEqual(route(s), { tool: 'open_url', args: { url } }, s)
  assert.equal(knownSite('calendar'), 'https://calendar.google.com')
  assert.equal(knownSite('YouTube in Chrome'), 'https://www.youtube.com')
})

test('unknown site names are never turned into invented URLs', () => {
  assert.equal(knownSite('netflix'), null)
  assert.equal(knownSite('chrome'), null)
  assert.deepEqual(route('Open Netflix in Chrome'), { tool: 'open_application', args: { name: 'Netflix in Chrome' } })
  assert.equal(route('go to my bank'), null)
  assert.deepEqual(route('Launch Chrome'), { tool: 'open_application', args: { name: 'Chrome' } })
})

test('JARVIS lifecycle and diagnostics are deterministic', () => {
  assert.equal(tool('Show diagnostics'), 'show_diagnostics')
  assert.equal(tool('open the diagnostics'), 'show_diagnostics')
  assert.equal(tool('Restart Jarvis'), 'restart_jarvis')
  assert.equal(tool('Stop Jarvis'), 'stop_jarvis')
  assert.equal(tool('shut down jarvis'), 'stop_jarvis')
  assert.equal(tool('system status'), 'get_system_status')
  assert.equal(tool('refresh the app list'), 'refresh_applications')
})

test('conversation is left for the model', () => {
  for (const s of [
    'Explain quantum entanglement in one sentence.',
    "I'd like to do some sums, get the calculator going.",
    'start thinking about dinner and tell me what to cook',
    'What is the capital of France?',
    'stop',
    'Why is the sky blue?',
    'show me a picture of a cat',
  ])
    assert.equal(route(s), null, s)
})

test('normalisation strips the wake phrase and politeness, not meaning', () => {
  assert.equal(normalizeUtterance('Hey Jarvis, please open Spotify for me.'), 'open spotify')
  assert.equal(normalizeUtterance('  Could you please   tell me the time?  '), 'tell me the time')
  assert.equal(normalizeUtterance(''), '')
})

test('answering "which one?" picks exactly one candidate or none', () => {
  const c = ['Visual Studio Code', 'Visual Studio Installer']
  assert.equal(pickChoice('the first one', c), 'Visual Studio Code')
  assert.equal(pickChoice('Visual Studio Installer', c), 'Visual Studio Installer')
  assert.equal(pickChoice('code', c), 'Visual Studio Code')
  assert.equal(pickChoice('visual studio', c), null)
  assert.equal(pickChoice('never mind', c), false)
  assert.equal(pickChoice('what time is it', c), null)
})

test('looser app phrasings are candidates (the caller checks the catalogue), conversation is not', () => {
  const name = (s) => routeSoftApp(s)?.args.name ?? null
  assert.equal(name("I'd like to do some sums, could you get the calculator going?"), 'calculator')
  assert.equal(name('I need to write a letter, get Word up please.'), 'Word')
  assert.equal(name('Could you get Spotify running for me'), 'Spotify')
  assert.equal(name('pull up the task manager'), null) // "pull up X" already belongs to route() or the brain
  assert.equal(name('get me going'), null)
  assert.equal(name('get the party started and then call mum'), null)
  assert.equal(name('what is the capital of France'), null)
  assert.equal(route('get the calculator going'), null, 'not a strict command')
})