/**
 * A low-resource periodic task: one timer armed for the next due time, never
 * a polling loop.
 *
 *   - The next due time is durable (the store), so a restart knows whether a
 *     run was missed.
 *   - A missed run produces exactly ONE catch-up, shortly after start-up (never
 *     during it), however many intervals were missed.
 *   - Runs never overlap: a run already in progress makes another request a
 *     no-op.
 *   - Paused means no timer at all. Resuming re-arms it; nothing queued is lost
 *     because the queue lives in the tracker and the store, not the timer.
 *   - Outside the configured active hours a due run is deferred to the start
 *     of the next active window.
 */

const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * @param {object} o
 * @param {string} o.name                    'search' | 'watch'
 * @param {number} o.intervalMs
 * @param {() => Promise<object>} o.task
 * @param {{ get: () => (string|null), set: (iso: string|null) => void, lastRun: (iso: string) => void, paused: () => boolean }} o.clock   durable fields
 * @param {number} [o.startupDelayMs]        wait after start before a due/catch-up run
 * @param {(d: Date) => boolean} [o.active]  inside active hours?
 * @param {() => number} [o.now]
 * @param {typeof setTimeout} [o.setTimer]
 * @param {typeof clearTimeout} [o.clearTimer]
 */
export function createScheduler(o) {
  const { name, intervalMs, task, clock, startupDelayMs = 90_000, active = () => true, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = o
  let timer = null
  let running = null
  let started = false
  const state = { runs: 0, catchUps: 0, skippedConcurrent: 0, lastResult: null, lastError: null }

  const arm = (atMs) => {
    if (timer) clearTimer(timer)
    timer = null
    if (!started || clock.paused()) return
    const delay = Math.max(0, atMs - now())
    timer = setTimer(() => {
      timer = null
      if (delay > MAX_TIMER_MS) return arm(atMs) // long waits are re-armed in steps
      void fire('scheduled')
    }, Math.min(delay, MAX_TIMER_MS))
    timer?.unref?.()
  }

  /** The next time inside active hours, at or after `fromMs`, checked hour by hour. */
  const nextActive = (fromMs) => {
    for (let t = fromMs, i = 0; i < 48; i++, t += 3_600_000) {
      const d = new Date(t)
      if (active(d)) return i === 0 ? fromMs : new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
    }
    return fromMs
  }

  async function fire(reason) {
    if (clock.paused()) return { skipped: 'paused' }
    if (running) {
      state.skippedConcurrent++
      return { skipped: 'in-progress' }
    }
    if (reason === 'scheduled' && !active(new Date(now()))) {
      const at = nextActive(now())
      clock.set(new Date(at).toISOString())
      arm(at)
      return { skipped: 'outside-active-hours' }
    }
    running = (async () => {
      const startedAt = now()
      try {
        state.lastResult = await task({ reason })
        state.lastError = null
      } catch (err) {
        state.lastError = String(err?.message ?? err).slice(0, 200)
        state.lastResult = null
      } finally {
        state.runs++
        clock.lastRun(new Date(startedAt).toISOString())
        const next = now() + intervalMs
        clock.set(new Date(next).toISOString())
        arm(next)
      }
      return state.lastResult
    })()
    try {
      return await running
    } finally {
      running = null
    }
  }

  return {
    name,
    state,
    /** Arm the timer from the durable schedule. Never runs anything synchronously. */
    start() {
      started = true
      const due = clock.get() ? Date.parse(clock.get()) : NaN
      const soon = now() + startupDelayMs
      if (!Number.isFinite(due)) {
        // First ever start: first run shortly after start-up.
        clock.set(new Date(soon).toISOString())
        arm(soon)
      } else if (due <= now()) {
        // Missed while JARVIS was off: one catch-up, however much was missed.
        state.catchUps++
        clock.set(new Date(soon).toISOString())
        arm(soon)
      } else {
        arm(due)
      }
    },
    stop() {
      started = false
      if (timer) clearTimer(timer)
      timer = null
    },
    runNow: (reason = 'manual') => fire(reason),
    /** Re-arm after the durable pause flag changed. */
    refresh() {
      if (clock.paused()) {
        if (timer) clearTimer(timer)
        timer = null
        return
      }
      const due = clock.get() ? Date.parse(clock.get()) : now()
      arm(Number.isFinite(due) && due > now() ? due : now() + Math.min(startupDelayMs, 60_000))
    },
    get running() {
      return Boolean(running)
    },
    get armed() {
      return Boolean(timer)
    },
  }
}
