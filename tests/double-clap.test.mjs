/**
 * The wake gesture is TWO claps.
 *
 * One sharp transient is a mug, a door, a knuckle on a desk — and a clap now
 * starts three monitors' worth of workspace, so one of them must never be
 * enough. These tests drive the real state machine and the real detector (with
 * a fake microphone and a fake clock) rather than reading the source: the thing
 * that matters here is behaviour over time, and only behaviour proves it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBrowserModule } from './browser-modules.mjs'
import { createWakeGesture, DOUBLE_CLAP_MIN_MS, DOUBLE_CLAP_MAX_MS } from '../src/lib/doubleClap.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const code = (p) => readFileSync(join(ROOT, p), 'utf8')

const COOLDOWN_MS = 1200

// --- the state machine ------------------------------------------------------

test('the timings are a human double clap, not magic numbers', () => {
  assert.equal(DOUBLE_CLAP_MIN_MS, 100)
  assert.equal(DOUBLE_CLAP_MAX_MS, 650)
  const clap = code('src/lib/clap.ts')
  assert.match(clap, /import \{ createWakeGesture, DOUBLE_CLAP_MIN_MS[^}]*\} from '\.\/doubleClap'/)
  assert.ok(!/\b(100|650)\b/.test(code('src/lib/clap.ts').split('listenForClap')[1] ?? ''), 'no bare intervals in the listener')
})

test('one clap arms the gesture and nothing else', () => {
  const g = createWakeGesture(COOLDOWN_MS)
  assert.equal(g.clap(1000), 'armed')
  assert.equal(g.pendingAt, 1000)
  // ...and stays armed right up to the edge of the window.
  assert.equal(g.expire(1000 + DOUBLE_CLAP_MAX_MS), false)
  assert.equal(g.expire(1000 + DOUBLE_CLAP_MAX_MS + 1), true)
  assert.equal(g.pendingAt, null)
})

test('two claps inside the window wake him, once', () => {
  for (const gap of [DOUBLE_CLAP_MIN_MS, 250, 400, DOUBLE_CLAP_MAX_MS]) {
    const g = createWakeGesture(COOLDOWN_MS)
    assert.equal(g.clap(5000), 'armed', `${gap}`)
    assert.equal(g.clap(5000 + gap), 'wake', `${gap}`)
    assert.equal(g.pendingAt, null, `${gap}`)
  }
})

test('two claps closer than the minimum are one impulse heard twice: no wake', () => {
  const g = createWakeGesture(COOLDOWN_MS)
  g.clap(5000)
  assert.equal(g.clap(5000 + DOUBLE_CLAP_MIN_MS - 1), 'too-soon')
  assert.equal(g.pendingAt, null, 'and the half gesture is dropped, not left hanging')
})

test('two claps further apart than the maximum are two unrelated events', () => {
  const g = createWakeGesture(COOLDOWN_MS)
  g.clap(5000)
  const late = 5000 + DOUBLE_CLAP_MAX_MS + 1
  assert.equal(g.clap(late), 'armed', 'the late one starts a fresh gesture rather than finishing a stale one')
  assert.equal(g.pendingAt, late)
  // A partner for THAT one does wake him.
  assert.equal(g.clap(late + 300), 'wake')
})

test('a third clap does not wake him a second time', () => {
  const g = createWakeGesture(COOLDOWN_MS)
  g.clap(5000)
  assert.equal(g.clap(5300), 'wake')
  assert.equal(g.clap(5600), 'cooldown')
  assert.equal(g.clap(5900), 'cooldown')
  assert.equal(g.pendingAt, null, 'claps inside the cooldown do not even arm a new gesture')
  assert.equal(g.clap(5300 + COOLDOWN_MS), 'armed', 'once it lapses, the gesture works again')
})

test('reset forgets a half-finished gesture', () => {
  const g = createWakeGesture(COOLDOWN_MS)
  g.clap(5000)
  g.reset()
  assert.equal(g.pendingAt, null)
  assert.equal(g.clap(5300), 'armed', 'the clap after a reset is a first clap, not a second')
})

// --- the detector, driven frame by frame ------------------------------------

/**
 * A fake room: a clock, a microphone that reports whatever level we say, and a
 * frame loop we advance by hand. Everything the detector does is a function of
 * these, so a clap here is as good as a clap there.
 */
async function room() {
  let clock = 0
  let level = 0.004
  let frame = null

  const realPerf = globalThis.performance
  const realRaf = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame
  const realCtx = globalThis.AudioContext

  globalThis.performance = { now: () => clock }
  globalThis.requestAnimationFrame = (cb) => {
    frame = cb
    return 1
  }
  globalThis.cancelAnimationFrame = () => {
    frame = null
  }
  globalThis.AudioContext = class {
    constructor() {
      this.state = 'running'
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    createAnalyser() {
      return {
        fftSize: 512,
        smoothingTimeConstant: 0,
        connect() {},
        getFloatTimeDomainData: (buf) => buf.fill(level),
      }
    }
    resume() {}
    close() {}
  }

  const clap = await loadBrowserModule('src/lib/clap.ts', {
    './audio': 'export const getMic = async () => ({})',
  })

  const step = (lvl, dt = 16) => {
    clock += dt
    level = lvl
    const cb = frame
    frame = null
    cb?.()
  }

  return {
    clap,
    get now() {
      return clock
    },
    /** Quiet room, for as long as you like. */
    quiet(ms) {
      for (let i = 0; i < Math.round(ms / 16); i++) step(0.004)
    },
    /** One pair of hands. Returns the moment the strike landed. */
    strike() {
      step(0.2)
      const at = clock
      step(0.05) // collapsed to a quarter of its peak within a frame: a clap
      return at
    },
    restore() {
      globalThis.performance = realPerf
      globalThis.requestAnimationFrame = realRaf
      globalThis.cancelAnimationFrame = realCancel
      globalThis.AudioContext = realCtx
    },
  }
}

/** An armed listener in a settled room, and a count of how often it woke. */
async function armed() {
  const r = await room()
  let wakes = 0
  const listener = await r.clap.listenForClap(() => {
    wakes++
  })
  r.quiet(2500) // past SETTLE_MS, with the floor learned
  return {
    ...r,
    listener,
    diag: r.clap.diag,
    wakes: () => wakes,
    /** Two claps, `gap` ms apart (to within a frame), in a quiet room. */
    double(gap) {
      const at = r.strike()
      r.quiet(gap - (r.now - at) - 16) // ...and strike() spends a frame reaching its peak
      r.strike()
    },
  }
}

test('the detector still hears a clap, and one clap does not wake him', async () => {
  const r = await armed()
  try {
    r.strike()
    assert.equal(r.diag.rawClaps, 1, 'heard')
    assert.equal(r.diag.pendingFirstClap, true, 'and held, waiting for its partner')
    assert.equal(r.wakes(), 0, 'but nothing started')
    r.quiet(2000)
    assert.equal(r.wakes(), 0, 'and nothing starts later, either')
    assert.equal(r.diag.pendingFirstClap, false, 'the lone clap is dropped once its window closes')
  } finally {
    r.listener.stop()
    r.restore()
  }
})

test('a deliberate double clap wakes him exactly once', async () => {
  for (const gap of [150, 300, 500, 640]) {
    const r = await armed()
    try {
      r.double(gap)
      assert.equal(r.wakes(), 1, `${gap} ms apart`)
      assert.equal(r.diag.wakeGestures, 1, `${gap} ms apart`)
      assert.equal(r.diag.rawClaps, 2, `${gap} ms apart`)
      assert.ok(Math.abs(r.diag.lastClapGapMs - gap) <= 16, `gap reported as ${r.diag.lastClapGapMs}`)
      assert.equal(r.diag.pendingFirstClap, false)
    } finally {
      r.listener.stop()
      r.restore()
    }
  }
})

test('two claps too close together are one impulse: no wake', async () => {
  const r = await armed()
  try {
    r.strike()
    r.quiet(32)
    r.strike()
    assert.equal(r.wakes(), 0)
    assert.equal(r.diag.wakeGestures, 0)
    assert.equal(r.diag.rawClaps, 1, 'the second strike is inside the same impulse and is not a clap at all')
  } finally {
    r.listener.stop()
    r.restore()
  }
})

test('two claps too far apart do not wake him', async () => {
  const r = await armed()
  try {
    r.double(DOUBLE_CLAP_MAX_MS + 200)
    assert.equal(r.wakes(), 0)
    assert.equal(r.diag.rawClaps, 2)
    assert.equal(r.diag.pendingFirstClap, true, 'the second one is now the start of a gesture of its own')
  } finally {
    r.listener.stop()
    r.restore()
  }
})

test('three claps start the workspace once, not twice', async () => {
  const r = await armed()
  try {
    r.double(300)
    r.quiet(300)
    r.strike()
    assert.equal(r.wakes(), 1)
    assert.equal(r.diag.wakeGestures, 1)
  } finally {
    r.listener.stop()
    r.restore()
  }
})

test('the cooldown holds for a full gesture, so one pair of hands wakes him once', async () => {
  const r = await armed()
  try {
    r.double(300)
    assert.equal(r.wakes(), 1)
    const wokeAt = r.now
    r.double(300) // a whole second gesture, still inside the cooldown
    assert.equal(r.wakes(), 1, 'ignored')
    assert.ok(r.now - wokeAt < 1200, 'and that was inside the cooldown')
    r.quiet(1200)
    r.double(300)
    assert.equal(r.wakes(), 2, 'once the cooldown lapses he can be woken again')
  } finally {
    r.listener.stop()
    r.restore()
  }
})

test('stopping the listener takes the pending clap with it: no timer outlives it', async () => {
  const r = await armed()
  try {
    r.strike()
    assert.equal(r.diag.pendingFirstClap, true)
    r.listener.stop()
    assert.equal(r.diag.pendingFirstClap, false, 'cleared on stop')
    assert.equal(r.diag.listening, false)

    // Restart, and the clap that was pending must not pair with the next one.
    let wakes = 0
    const again = await r.clap.listenForClap(() => {
      wakes++
    })
    r.quiet(2500)
    r.strike()
    assert.equal(wakes, 0, 'the first clap after a restart is a first clap')
    assert.equal(r.diag.pendingFirstClap, true)
    again.stop()
  } finally {
    r.restore()
  }
})

test('the wake reports itself: gestures, not raw claps, are what diagnostics count', async () => {
  const r = await armed()
  try {
    let reports = 0
    const listener = await r.clap.listenForClap(
      () => {},
      () => {
        reports++
      },
    )
    r.quiet(2500)
    const before = reports
    r.strike()
    assert.ok(reports > before, 'a clap that does nothing is still reported, or a quiet-room test could not see it')
    assert.equal(r.diag.lastClapAfterArmMs > 0, true)
    listener.stop()
  } finally {
    r.listener.stop()
    r.restore()
  }
})

// --- what the page and the bridge are allowed to say ------------------------

test('only a completed gesture calls the workspace, and only from the JARVIS window', () => {
  const app = code('src/App.tsx')
  // One listener, one workspace call, and the call is inside the listener's
  // own callback — which now fires only for a finished double clap.
  assert.equal(app.split('listenForClap(').length - 1, 1)
  assert.equal(app.match(/\/workspace`/g)?.length, 1)
  assert.match(app, /listenForClap\(\(\) => \{[\s\S]*?\/workspace`, \{ method: 'POST', headers: \{ \[SURFACE_HEADER\]: JARVIS_SURFACE \} \}/)
  assert.ok(app.includes("if (phase !== 'offline' || !isJarvisSurface()) return"))
})
