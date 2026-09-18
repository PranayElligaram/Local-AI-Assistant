import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { deriveDisplay, type Display } from './hudState'
import { BRACKETS, SCALE } from './dial'

/**
 * The engineered half of the reactor.
 *
 * The WebGL ring is light — soft, eroded, alive. This is the precision drawn
 * over it: a calibration scale, a segmented guard ring, a level arc and four
 * mounting brackets, all hairline vectors that stay crisp where bloom would
 * smear them. Units are the viewBox's: the WebGL ring sits at r = 300, and the
 * element is sized from --reactor-d (ui/layout.ts) so the two line up.
 *
 * Everything moves by CSS transform keyed off data-display, so nothing here
 * re-renders between state changes. The one continuous input, sound level, is
 * written straight to a CSS variable from a store subscription — no React.
 */


const LEVEL_STATES = new Set<Display>(['listening', 'speaking'])

export function Instrument({ display, fault }: { display: Display; fault: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let shown = 0
    const write = (v: number) => {
      if (v === 0 && shown === 0) return
      // Eased and thresholded: the pump runs every frame, but the arc only
      // needs a style write when the value visibly moves.
      const next = shown + (v - shown) * 0.35
      if (Math.abs(next - shown) < 0.004 && v !== 0) return
      shown = v === 0 && next < 0.01 ? 0 : next
      el.style.setProperty('--level', shown.toFixed(3))
    }
    return useStore.subscribe((s) => {
      write(LEVEL_STATES.has(deriveDisplay(s.phase, s.voiceState)) ? s.level : 0)
    })
  }, [])

  return (
    <div ref={ref} className="inst" data-display={display} data-fault={fault || undefined} aria-hidden="true">
      <svg viewBox="-500 -500 1000 1000">
        <g className="inst-scale">
          <path className="inst-tick" d={SCALE.minor} />
          <path className="inst-tick inst-tick-major" d={SCALE.major} />
        </g>
        <circle className="inst-hair" r="330" />
        <g className="inst-guard">
          <circle className="inst-seg" r="346" pathLength="360" />
        </g>
        <g className="inst-level">
          <circle className="inst-level-arc" r="358" pathLength="100" transform="rotate(-90)" />
          <circle className="inst-level-arc" r="358" pathLength="100" transform="scale(-1,1) rotate(-90)" />
        </g>
        <path className="inst-bracket" d={BRACKETS} />
        {display === 'wake' && <circle className="inst-wake" r="300" />}
      </svg>
    </div>
  )
}
