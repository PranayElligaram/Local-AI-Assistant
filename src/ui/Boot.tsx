import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type BootStepKey, type BootStepState } from '../store'
import { engineLabel } from '../lib/capabilities'
import { BRACKETS, SCALE } from './dial'

/**
 * Coming online.
 *
 * One beat, not four. The reactor behind this layer is already powering up in
 * WebGL; this draws its instrument around it — scale, guard ring, brackets —
 * at exactly the geometry the live HUD uses, so the hand-off at the end is the
 * chrome arriving rather than a scene change.
 *
 * Under it, the start-up checks. They are the real steps in App's ignite(), in
 * the order they run, reported as they finish — so a slow model or a pending
 * microphone prompt is visible and named instead of hidden behind a progress
 * bar that fills on a timer.
 */

type Step = { key: BootStepKey; label: string; detail: (s: BootStepState) => string }

const STEPS: Step[] = [
  {
    key: 'bridge',
    label: 'Bridge',
    detail: (s) => (s === 'ok' ? 'Linked' : s === 'warn' ? 'Not reachable — is the bridge running?' : 'Connecting'),
  },
  {
    key: 'brain',
    label: 'Local AI',
    detail: (s) => (s === 'ok' ? 'Ready' : s === 'warn' ? 'Not ready yet — check Ollama in diagnostics' : 'Warming up'),
  },
  {
    key: 'mic',
    label: 'Microphone',
    detail: (s) =>
      s === 'ok'
        ? 'Ready'
        : s === 'warn'
          ? 'No level meter — speech recognition still works'
          : s === 'run'
            ? 'Allow access when your browser asks'
            : 'Waiting',
  },
  {
    key: 'voice',
    label: 'Voice',
    detail: (s) => (s === 'ok' ? engineLabel() : s === 'run' ? 'Checking speech engines' : 'Waiting'),
  },
  {
    key: 'wake',
    label: 'Wake word',
    detail: (s) => (s === 'ok' ? 'Armed' : s === 'run' ? 'Arming' : 'Waiting'),
  },
]

const MARK: Record<BootStepState, string> = { wait: '○', run: '◌', ok: '✓', warn: '!' }

export function Boot() {
  const phase = useStore((s) => s.phase)
  const steps = useStore((s) => s.bootSteps)
  const note = useStore((s) => s.bootNote)

  return (
    <AnimatePresence>
      {phase === 'boot' && (
        <motion.div
          key="boot"
          className="boot"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
        >
          <div className="boot-dial" aria-hidden="true">
            <svg viewBox="-500 -500 1000 1000">
              <path className="boot-scale" d={SCALE.minor} pathLength="100" />
              <path className="boot-scale boot-scale-major" d={SCALE.major} pathLength="100" />
              <circle className="boot-ring" r="330" pathLength="100" />
              <circle className="boot-ring boot-ring-guard" r="346" pathLength="360" />
              <path className="boot-bracket" d={BRACKETS} />
            </svg>
          </div>

          <div className="boot-title">
            <span className="boot-mark">J.A.R.V.I.S</span>
            <span className="boot-sub">Coming online</span>
          </div>

          <ol className="boot-checks" aria-label="Start-up checks" aria-live="polite">
            {STEPS.map((step) => {
              const s = steps[step.key]
              return (
                <li key={step.key} className="boot-check" data-state={s}>
                  <span className="boot-check-mark" aria-hidden="true">
                    {MARK[s]}
                  </span>
                  <span className="boot-check-label">{step.label}</span>
                  <span className="boot-check-detail">
                    {step.key === 'voice' && s !== 'ok' && note ? note : step.detail(s)}
                  </span>
                </li>
              )
            })}
          </ol>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
