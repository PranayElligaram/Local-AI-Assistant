import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { isConnected } from '../lib/bridge'
import { caps, engineLabel } from '../lib/capabilities'
import { BRIDGE_HTTP_URL, BRIDGE_WS_URL, TTS_ENGINE, USE_ELEVENLABS, WAKE_ENGINE } from '../config'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it (or say "show diagnostics"). The bridge half - the local
 * brain, the application catalogue, the tools - is read from the bridge's own
 * GET /diagnostics, so what is shown is measured state, never an assumed green.
 *
 * It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 */

type VoiceDiag = {
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  wakes: number
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
  voiceState: string
  wakeListening: boolean
  commandRecognitionActive: boolean
  ttsActive: boolean
  recognitionGeneration: number
  lastWakeAt: number
  lastUtteranceSentAt: number
  wakeToListenMs: number
  wakeToMicMs: number
  engine: string
  voiceMode: string
  lastWakePhrase: string
  lastWakeRejection: string
  lastWakeRejectionAt: number
  lastTransition: string
  lastTransitionAt: number
  commandSince: number
}

type ConversationDiag = {
  lastTransition: string
  lastTransitionAt: number
  listeningSince: number
  deadlineAt: number
  timeouts: number
  standDowns: number
}

type MicDiag = {
  open: boolean
  label: string
  preference: string
  reason: string
  fallback: string
  devices: number
  recoveries: number
  lastError: string
  lostAt: number
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  nativeBroken: boolean
  rescued: number
  voice: string
  lastText: string
}

/** The subset of the bridge's GET /diagnostics this panel shows. */
type BridgeDiag = {
  bridge?: { port: number; pid: number; uptimeSeconds: number; ownsRunFile: boolean; clients: number }
  brain?: {
    mode: string
    provider: string
    endpoint: string
    primary: { model: string; ok: boolean; reachable: boolean; loaded: boolean; error: string }
    fallback: { model: string; ok: boolean; reachable: boolean; loaded: boolean; error: string } | null
    lastModel: string | null
    lastFallbackUsed: boolean
    lastLatencyMs: number | null
    lastFirstTokenMs: number | null
    lastError: string
    lastSource: string
    cloudRequired: boolean | null
    claudeRuntime: string
    hermes?: {
      reported: { provider: string; model: string } | null
      enabledTools: string[]
      webEnabled: boolean
      session: { id: string; turns: number; lastUsedAt: number } | null
      priming: { enabled: boolean; inFlight: boolean; last: { ok: boolean; ms: number; at: number; error?: string } | null }
      toolPolicy: string
    } | null
  }
  tools?: { mode: string; last: string; lastResult: string; executed: number; rejected: number }
  apps?: {
    status: string
    count: number
    lastRequested: string
    lastResolved: string
    resolutionMethod: string
    lastLaunch: string
    dryRun: boolean
  }
  speech?: { elevenlabsConfigured: boolean; elevenlabsSttDenied: boolean; elevenlabsTtsDenied: boolean }
}

const health = (m?: { model: string; ok: boolean; reachable: boolean; loaded: boolean; error: string } | null) =>
  !m ? '—' : m.ok ? `${m.model} · ${m.loaded ? 'loaded' : 'ready'}` : `${m.model} · ${m.error || 'unreachable'}`

const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s ago` : '—')

/** A reading. Faults are marked with a glyph as well as colour. */
function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="diag-row" data-bad={bad || undefined}>
      <dt className="diag-k">{k}</dt>
      <dd className="diag-v">
        {bad && <span className="diag-flag" aria-label="fault">✕ </span>}
        {v}
      </dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="diag-sec">
      <h3 className="diag-sec-title">{title}</h3>
      <dl className="diag-rows">{children}</dl>
    </section>
  )
}

function Verdict({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <li className="diag-verdict-item" data-ok={ok}>
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span> {ok ? yes : no}
    </li>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const [bridgeDiag, setBridgeDiag] = useState<BridgeDiag | null>(null)
  const [bridgeErr, setBridgeErr] = useState('')
  const phase = useStore((s) => s.phase)
  const panel = useRef<HTMLElement>(null)

  // "Show diagnostics", spoken, arrives as a bridge ui op.
  useEffect(() => {
    const onAsk = () => setOpen(true)
    window.addEventListener('jarvis:diagnostics', onAsk)
    return () => window.removeEventListener('jarvis:diagnostics', onAsk)
  }, [])

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/diagnostics`, { signal: AbortSignal.timeout(4000) })
        const d = (await res.json()) as BridgeDiag
        if (alive) {
          setBridgeDiag(d)
          setBridgeErr('')
        }
      } catch (err) {
        if (alive) setBridgeErr((err as Error)?.message || 'unreachable')
      }
    }
    void load()
    const id = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  // Focus moves into the panel when it opens so it can be scrolled from the
  // keyboard, and goes back where it was when it closes.
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => before?.focus?.()
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>
  const m = (w.__mic ?? {}) as Partial<MicDiag>
  const c = (w.__conversation ?? {}) as Partial<ConversationDiag>
  const secs = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`
  // Listening with no deadline is the stuck state this panel exists to catch.
  const listening = phase === 'listening' || phase === 'waking'
  const deadlineLeft = c.deadlineAt ? Math.max(0, c.deadlineAt - Date.now()) : 0

  // The three verdicts worth stating outright, rather than making you infer
  // them from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0 || (t.rescued ?? 0) > 0
  const bridgeOk = isConnected()
  const b = bridgeDiag?.brain
  const brainOk = Boolean(b?.primary?.ok || b?.fallback?.ok)
  const apps = bridgeDiag?.apps
  const tl = bridgeDiag?.tools
  const proc = bridgeDiag?.bridge
  const sttProvider = caps().stt ? 'ElevenLabs Scribe' : 'browser recognition'
  const ttsProvider = caps().tts && USE_ELEVENLABS ? 'ElevenLabs (browser fallback)' : TTS_ENGINE === 'kokoro' ? 'Kokoro (in browser)' : 'browser speech'

  return (
    <aside
      ref={panel}
      className="diag"
      role="dialog"
      aria-modal="false"
      aria-labelledby="diag-title"
      tabIndex={-1}
    >
      <header className="diag-head">
        <h2 id="diag-title">Diagnostics</h2>
        <button type="button" className="diag-close" onClick={() => setOpen(false)}>
          Close <kbd>D</kbd>
        </button>
      </header>

      <ul className="diag-verdict" aria-label="Summary">
        <Verdict ok={earsOk} yes="Hearing you" no="Not hearing you" />
        <Verdict ok={mouthOk} yes="Speaking" no="No sound produced yet" />
        <Verdict ok={bridgeOk} yes="Bridge connected" no="Bridge unreachable" />
        <Verdict ok={brainOk} yes="Local brain online" no="Local brain unavailable" />
      </ul>

      <Section title="Microphone">
        <Row k="device" v={m.open ? m.label || 'default device' : 'NOT OPEN'} bad={!m.open} />
        <Row k="chosen by" v={String(m.reason ?? '—')} />
        <Row k="preference" v={m.preference ? m.preference : '— (system default)'} />
        {m.fallback ? <Row k="fallback" v={m.fallback} bad /> : null}
        <Row k="inputs seen" v={String(m.devices ?? 0)} bad={(m.devices ?? 0) === 0} />
        <Row
          k="recoveries"
          v={m.lostAt ? `${m.recoveries ?? 0} (last loss ${ago(m.lostAt)})` : String(m.recoveries ?? 0)}
          bad={(m.recoveries ?? 0) > 0}
        />
        <Row k="error" v={m.lastError || '—'} bad={Boolean(m.lastError)} />
      </Section>

      <Section title="AI Brain">
        {bridgeErr ? <Row k="bridge" v={`unreachable · ${bridgeErr}`} bad /> : null}
        <Row k="mode" v={b ? `${b.mode === 'local' ? 'Local' : b.mode} · ${b.provider}` : '—'} />
        <Row k="primary" v={health(b?.primary)} bad={Boolean(b) && !b?.primary?.ok} />
        <Row k="fallback" v={health(b?.fallback)} bad={Boolean(b?.fallback) && !b?.fallback?.ok} />
        <Row k="last model" v={b?.lastModel ? `${b.lastModel}${b.lastFallbackUsed ? ' (fallback)' : ''}` : '—'} />
        <Row
          k="last latency"
          v={b?.lastLatencyMs != null ? `${b.lastLatencyMs} ms (first words ${b.lastFirstTokenMs ?? '—'} ms)` : '—'}
        />
        <Row k="last source" v={b?.lastSource || '—'} />
        <Row k="brain error" v={b?.lastError || '—'} bad={Boolean(b?.lastError)} />
        <Row k="endpoint" v={b?.endpoint ?? '—'} />
        {b?.hermes ? (
          <>
            <Row k="Hermes model" v={b.hermes.reported ? `${b.hermes.reported.model} · ${b.hermes.reported.provider}` : '—'} />
            <Row k="Hermes tools" v={b.hermes.enabledTools.length ? b.hermes.enabledTools.join(', ') : 'none'} />
            <Row k="Hermes session" v={b.hermes.session ? `${b.hermes.session.turns} turns · ${ago(b.hermes.session.lastUsedAt)}` : '—'} />
            <Row
              k="session priming"
              v={
                !b.hermes.priming.enabled
                  ? 'off'
                  : b.hermes.priming.inFlight
                    ? 'priming…'
                    : b.hermes.priming.last
                      ? `${b.hermes.priming.last.ok ? 'ok' : b.hermes.priming.last.error} · ${(b.hermes.priming.last.ms / 1000).toFixed(1)}s`
                      : 'not yet'
              }
              bad={b.hermes.priming.last?.ok === false}
            />
          </>
        ) : null}
        <Row k="cloud required" v={b ? (b.cloudRequired === null ? 'Unknown' : b.cloudRequired ? 'YES' : 'No') : '—'} bad={Boolean(b?.cloudRequired)} />
        <Row k="Claude runtime" v={b ? (b.claudeRuntime === 'none' ? 'None' : b.claudeRuntime) : '—'} />
      </Section>

      <Section title="Applications">
        <Row k="catalogue" v={apps ? `${apps.status} · ${apps.count} apps${apps.dryRun ? ' · DRY RUN' : ''}` : '—'} bad={apps?.status === 'error' || apps?.count === 0} />
        <Row k="last requested" v={apps?.lastRequested || '—'} />
        <Row k="resolved to" v={apps?.lastResolved || '—'} />
        <Row k="method" v={apps?.resolutionMethod || '—'} />
        <Row k="launch" v={apps?.lastLaunch || '—'} bad={Boolean(apps?.lastLaunch?.startsWith('failed'))} />
      </Section>

      <Section title="Tools">
        <Row k="mode" v={tl ? (tl.mode === 'safe' ? 'safe (read-only)' : 'WRITES enabled') : '—'} />
        <Row k="last tool" v={tl?.last || '—'} />
        <Row k="last result" v={tl?.lastResult || '—'} bad={Boolean(tl?.lastResult?.startsWith('rejected'))} />
        <Row k="executed / rejected" v={tl ? `${tl.executed} / ${tl.rejected}` : '—'} />
      </Section>

      <Section title="Process">
        <Row k="socket" v={bridgeOk ? `connected · ${BRIDGE_WS_URL}` : `DOWN · ${BRIDGE_WS_URL}`} bad={!bridgeOk} />
        <Row k="bridge" v={proc ? `pid ${proc.pid} · port ${proc.port} · up ${proc.uptimeSeconds}s` : '—'} />
        <Row k="run file" v={proc ? (proc.ownsRunFile ? 'owned by this bridge' : 'NOT owned') : '—'} bad={Boolean(proc) && !proc?.ownsRunFile} />
        <Row k="UI" v={window.location.origin} />
      </Section>

      <Section title="Voice">
        <Row k="wake" v={WAKE_ENGINE === 'porcupine' ? '"Hey Jarvis" · porcupine (offline)' : '"Hey Jarvis" · transcript match'} />
        <Row k="speech stack" v={engineLabel()} />
        <Row k="STT" v={sttProvider} />
        <Row k="TTS" v={ttsProvider} />
        <Row
          k="ElevenLabs"
          v={
            bridgeDiag?.speech
              ? !bridgeDiag.speech.elevenlabsConfigured
                ? 'not configured'
                : `configured${bridgeDiag.speech.elevenlabsSttDenied ? ' · STT denied' : ''}${bridgeDiag.speech.elevenlabsTtsDenied ? ' · TTS denied' : ''}`
              : '—'
          }
        />
        <Row k="guard" v={v.mode === 'guard' ? 'active — mic paused while JARVIS has the floor' : 'idle'} />
      </Section>

      <Section title="Wake & command">
        <Row k="voice mode" v={v.voiceMode ?? '—'} />
        <Row
          k="wake detector"
          v={v.voiceMode === 'STANDBY' ? (v.running ? 'active' : 'armed, recogniser STOPPED') : 'inactive'}
          bad={v.voiceMode === 'STANDBY' && !v.running}
        />
        <Row k="mic capturing" v={v.running ? 'yes' : 'no'} />
        <Row k="engine" v={`${v.engine ?? '—'}${v.lastError ? ` · ${v.lastError}` : ''}`} bad={Boolean(v.lastError)} />
        <Row k="last wake phrase" v={v.lastWakePhrase ? `"${v.lastWakePhrase}"` : '—'} />
        <Row k="last wake" v={v.lastWakeAt ? `${new Date(v.lastWakeAt).toLocaleTimeString()} · ${ago(v.lastWakeAt)}` : '—'} />
        <Row
          k="last wake rejection"
          v={v.lastWakeRejection ? `${v.lastWakeRejection} · ${ago(v.lastWakeRejectionAt ?? 0)}` : '—'}
        />
        <Row
          k="voice transition"
          v={v.lastTransition ? `${v.lastTransition} · ${ago(v.lastTransitionAt ?? 0)}` : '—'}
        />
        <Row
          k="phase transition"
          v={c.lastTransition ? `${c.lastTransition} · ${ago(c.lastTransitionAt ?? 0)}` : '—'}
        />
        <Row k="command mic open for" v={v.commandSince ? secs(v.commandSince) : '—'} />
        <Row
          k="listening window"
          v={
            listening
              ? c.deadlineAt
                ? `${secs(c.listeningSince ?? Date.now())} open · closes in ${(deadlineLeft / 1000).toFixed(1)}s`
                : 'NO DEADLINE — would never return to standby'
              : '—'
          }
          bad={listening && !c.deadlineAt}
        />
        <Row k="listen timeouts" v={String(c.timeouts ?? 0)} />
      </Section>

      <Section title="Voice lifecycle">
        <Row k="state" v={v.voiceState ?? '—'} />
        <Row k="input engine" v={v.engine ?? '—'} />
        <Row k="wake listening" v={v.wakeListening ? 'yes' : 'no'} />
        <Row k="command mic" v={v.commandRecognitionActive ? 'open' : 'closed'} />
        <Row k="TTS active" v={v.ttsActive ? 'yes (mic paused)' : 'no'} />
        <Row k="generation" v={String(v.recognitionGeneration ?? 0)} />
        <Row k="last wake" v={ago(v.lastWakeAt ?? 0)} />
        <Row
          k="wake → listening"
          v={v.wakeToListenMs ? `${v.wakeToListenMs} ms${v.wakeToMicMs ? ` (mic live ${v.wakeToMicMs} ms)` : ''}` : '—'}
        />
        <Row k="last command sent" v={ago(v.lastUtteranceSentAt ?? 0)} />
      </Section>

      <Section title="Listening">
        <Row k="recogniser" v={v.running ? 'running' : 'STOPPED'} bad={!v.running} />
        <Row k="sessions" v={String(v.sessions ?? 0)} />
        <Row
          k="silent for"
          v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
          bad={(v.idleMs ?? 0) > 15000}
        />
        <Row k="forced restarts" v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
        <Row k="mode" v={`${v.mode ?? '—'} (phase ${phase})`} />
        <Row k="accepted" v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
        <Row k="wakes" v={String(v.wakes ?? 0)} />
        <Row k="last heard" v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : '— nothing yet'} bad={!v.heard} />
        <Row k="last drop" v={v.dropped || '—'} bad={Boolean(v.dropped)} />
        <Row k="error" v={v.lastError || '—'} bad={Boolean(v.lastError)} />
      </Section>

      <Section title="Speaking — press T to test">
        <Row k="engine" v={String(t.engine ?? 'system')} />
        <Row k="voice" v={String(t.voice || '—')} />
        <Row k="handed to OS" v={String(t.spoken ?? 0)} />
        <Row k="actually spoke" v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
        <Row k="failures" v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
        <Row k="cloud rescues" v={String(t.rescued ?? 0)} />
        <Row k="error" v={t.lastError || '—'} bad={Boolean(t.lastError)} />
      </Section>
    </aside>
  )
}
