import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, accentFor, type Turn } from '../store'
import { Suggestions } from './Suggestions'
import { BladeSweep, Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'
import { Instrument } from './Instrument'
import { deriveDisplay, displayLabel, humanTool, micFor, micLabel, type Display, type Mic } from './hudState'
import { reactorFrame } from './layout'
import { engineLabel } from '../lib/capabilities'

/* ------------------------------------------------------------------ reveal */

/** Characters shown half-lit ahead of the settled text — the leading edge. */
const EDGE = 14
/** Repaint interval for the reveal. ~24fps is plenty. */
const FRAME_MS = 42
/** Floor on the reveal rate, characters per second. */
const MIN_RATE = 110
/** The frontier is never allowed to trail the streamed text by longer. */
const MAX_LAG_MS = 420

/**
 * JARVIS's lines, arriving with a soft leading edge.
 *
 * It used to scramble the edge into glyph noise, which read as a glitch — a
 * monospace scrawl inside proportional text. Now the edge is the real words at
 * low light, settling to full brightness as the frontier passes.
 *
 * The hard part is that the text underneath is *live*: the store appends a
 * token at a time. So the frontier is a ref and only ever moves forward.
 * Everything behind it is plain settled text; a short window ahead is the
 * edge; the rest is present but invisible, which keeps line wrapping identical
 * to the finished paragraph and keeps the real sentence in the accessibility
 * tree. The rate scales with how far behind the frontier has fallen, so a
 * single token drips and a long burst clears inside MAX_LAG_MS — the reveal
 * must never be the reason the record trails the voice.
 */
function RevealText({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const settled = useRef(0)
  const raf = useRef(0)
  const latest = useRef(text)
  const [, bump] = useState(0)

  useEffect(() => {
    latest.current = text

    if (reduced) {
      settled.current = text.length
      return
    }
    if (raf.current || settled.current >= text.length) return

    let prev = performance.now()
    let painted = 0

    const step = (now: number) => {
      // Clamped so a backgrounded tab does not resolve the whole answer in one
      // enormous frame the moment it comes back.
      const dt = Math.min(now - prev, 250) / 1000
      prev = now

      const target = latest.current.length
      const rate = Math.max(MIN_RATE, (target - settled.current) / (MAX_LAG_MS / 1000))
      settled.current = Math.min(target, settled.current + rate * dt)

      if (now - painted >= FRAME_MS) {
        painted = now
        bump((n) => n + 1)
      }

      if (settled.current < latest.current.length) {
        raf.current = requestAnimationFrame(step)
      } else {
        raf.current = 0
        bump((n) => n + 1)
      }
    }
    raf.current = requestAnimationFrame(step)
  }, [text, reduced])

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const n = Math.floor(settled.current)
  if (reduced || n >= text.length) return <>{text}</>

  return (
    <>
      {text.slice(0, n)}
      <span className="reveal-edge">{text.slice(n, n + EDGE)}</span>
      <span className="reveal-veil">{text.slice(n + EDGE)}</span>
    </>
  )
}

/* ------------------------------------------------------------------- parts */

const clock = (at?: number) =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ''

/** "local · granite4:3b" -> "granite4:3b". */
function modelFrom(connected: string[]): string {
  const local = connected.find((c) => /^local\b/i.test(c))
  return local ? local.replace(/^local\s*[·:-]?\s*/i, '') : ''
}

const micShort: Record<Mic, string> = { off: 'Off', wake: 'Wake word', live: 'Live', paused: 'Paused' }

/** Three facts worth having during a conversation. Everything else is in D. */
function SystemStatus({ display, connected }: { display: Display; connected: string[] }) {
  const model = modelFrom(connected)
  const mic = micFor(display)
  return (
    <dl className="sys" aria-label="System status">
      <div className="sys-row" data-state={model ? 'ok' : 'warn'}>
        <dt>Local AI</dt>
        <dd>{model || 'Not linked'}</dd>
      </div>
      <div className="sys-row" data-state={mic === 'live' ? 'live' : mic === 'paused' ? 'hold' : 'ok'}>
        <dt>Mic</dt>
        <dd>{micShort[mic]}</dd>
      </div>
      <div className="sys-row" data-state="ok">
        <dt>Voice</dt>
        <dd>{engineLabel()}</dd>
      </div>
    </dl>
  )
}

/** The microphone glyph: open while live, struck through while paused. */
function MicGlyph({ mic }: { mic: Mic }) {
  return (
    <svg className="mic-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" />
      {(mic === 'paused' || mic === 'off') && <path className="mic-strike" d="M2.5 2.5l11 11" />}
    </svg>
  )
}

/** Directly under the reactor: what state he is in, and whether he can hear. */
function StateReadout({ display, tool, error }: { display: Display; tool: string | null; error: string | null }) {
  const mic = micFor(display)
  const sub =
    display === 'working' && tool
      ? humanTool(tool)
      : display === 'thinking'
        ? 'Local AI'
        : display === 'wake'
          ? 'Acknowledging'
          : null
  return (
    <div className="readout" data-display={display}>
      {/* The only live region for state. It changes on transitions, never per
          frame, so a screen reader hears each state once. */}
      <div className="readout-state" role="status" aria-live="polite" aria-atomic="true">
        <span className="readout-word">{displayLabel[display]}</span>
        <span className="sr-only">. {micLabel[mic]}.</span>
      </div>
      <div className="readout-line" data-mic={mic} aria-hidden="true">
        <MicGlyph mic={mic} />
        <span>{micLabel[mic]}</span>
        {sub && <span className="readout-sub">{sub}</span>}
      </div>
      {error && (
        <div className="readout-error" role="alert">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.8 14.8 14H1.2z" />
            <path d="M8 6.2v3.6M8 11.4v.6" />
          </svg>
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

/** The communication record: the last few exchanges, older ones receding. */
function Record({ turns, caption, live }: { turns: Turn[]; caption: string; live: boolean }) {
  const pending = live && Boolean(caption)
  const shown = turns.filter((t) => t.text).slice(pending ? -3 : -4)
  return (
    <section className="rec" aria-label="Conversation" role="log" aria-live="off">
      <AnimatePresence initial={false}>
        {shown.map((t, i) => (
          <motion.div
            key={t.id}
            className={`rec-entry rec-${t.role}`}
            data-age={shown.length - 1 - i + (pending ? 1 : 0)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <span className="rec-who">{t.role === 'user' ? 'You' : 'JARVIS'}</span>
            <time className="rec-time">{clock(t.at)}</time>
            <p className="rec-text">{t.role === 'jarvis' ? <RevealText text={t.text} /> : t.text}</p>
          </motion.div>
        ))}
      </AnimatePresence>
      {pending && (
        <div className="rec-entry rec-user rec-pending" data-age="0">
          <span className="rec-who">You</span>
          <span className="rec-time" aria-hidden="true">live</span>
          <p className="rec-text">
            {caption}
            <span className="rec-caret" aria-hidden="true" />
          </p>
        </div>
      )}
    </section>
  )
}

/* --------------------------------------------------------------------- hud */

export function Hud() {
  const phase = useStore((s) => s.phase)
  const voiceState = useStore((s) => s.voiceState)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const connected = useStore((s) => s.connected)
  const error = useStore((s) => s.error)
  const voice = useStore((s) => s.voice)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const ui = useStore((s) => s.ui)
  // Deliberately no `level` here: it changes every frame, and subscribing to
  // it re-rendered this whole tree sixty times a second. The one thing that
  // shows it (Instrument) writes a CSS variable from a store subscription.

  const display = deriveDisplay(phase, voiceState)

  // accentFor folds JARVIS's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every rule that uses it.
  const colour = accentFor(phase, ui)

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it.
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  useEffect(() => {
    // The reactor's place in the layout, shared with the WebGL scene through
    // ui/layout.ts. On the root so the ignition and boot screens use it too.
    const place = () => {
      const { y, d } = reactorFrame(window.innerWidth, window.innerHeight)
      const root = document.documentElement.style
      root.setProperty('--reactor-y', `${y}px`)
      root.setProperty('--reactor-d', `${d}px`)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [])

  // Offline and boot have their own full-screen layers; the live chrome only
  // exists once he is up.
  const up = phase !== 'offline' && phase !== 'boot'
  const listening = display === 'listening' || display === 'transcribing'

  return (
    <div className="hud" data-display={display} style={{ ['--accent' as string]: colour }}>
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the record and the blades without a z-index war. */}
      <BladeSweep />

      {up && ui.reactor.visible && <Instrument display={display} fault={Boolean(error)} />}

      {up && (
        <header className="hud-top">
          {ui.chrome.brand && (
            <div className="brand">
              <h1 className="brand-mark">J.A.R.V.I.S</h1>
              <span className="brand-sub">Just A Rather Very Intelligent System</span>
            </div>
          )}
          {ui.chrome.systems && <SystemStatus display={display} connected={connected} />}
        </header>
      )}

      {up && (
        <main className="stage">
          <StateReadout display={display} tool={ui.chrome.toolBadge ? activeTool : null} error={error} />
          <div className="lower">
            {ui.chrome.transcript && <Record turns={turns} caption={caption} live={listening} />}
            {ui.chrome.suggestions && <Suggestions />}
          </div>
        </main>
      )}

      {/* The one surface for anything JARVIS shows. */}
      <Blades />

      {up && (
        <footer className="keys" aria-label="Keyboard shortcuts">
          <span><kbd>Space</kbd> talk</span>
          <span><kbd>Esc</kbd> stand down</span>
          <span><kbd>D</kbd> diagnostics</span>
          <span><kbd>T</kbd> audio test</span>
          <span className="keys-extra"><kbd>G</kbd> hands</span>
          {voice && (
            <span className="keys-extra">
              <kbd>V</kbd> {voice.replace(/\(.*?\)/g, '').trim()}
            </span>
          )}
        </footer>
      )}

      {/* Last, so a flash or a tear reads as being on the glass rather than
          underneath the chrome. It is pointer-events: none and unmounts the
          instant it finishes. */}
      <Effects />

      {/* Above even the effects: the reticle shows where a press will land. */}
      <Pointer />
      {(gestures || looking) && (
        <div className="hands-live" role="status">
          {looking ? `Looking — ${looking}` : 'Camera on — press G to stop'}
        </div>
      )}
      <GestureGuide live={gestures} />
    </div>
  )
}
