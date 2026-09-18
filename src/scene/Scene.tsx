import { useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { Core } from './Core'
import { Particles } from './Particles'
import { Orbits } from './Orbits'
import { useStore, phaseColor, accentFor, type Phase } from '../store'
import { deriveDisplay, type Display } from '../ui/hudState'
import { reactorFrame, prefersReducedMotion } from '../ui/layout'

/**
 * How present each state's signature is in the reactor, 0..1, smoothed in
 * Rig. Listening grows a ring of input bars, thinking sets processing traces
 * orbiting inside, speaking ripples the core. `energy` is overall brightness:
 * the reactor rests low and comes up to meet the user.
 */
type Weights = { listen: number; think: number; speak: number; energy: number }

const weightsFor: Record<Display, Weights> = {
  offline: { listen: 0, think: 0, speak: 0, energy: 0.35 },
  boot: { listen: 0, think: 0.4, speak: 0, energy: 0.8 },
  dormant: { listen: 0, think: 0, speak: 0, energy: 0.58 },
  wake: { listen: 0.35, think: 0, speak: 0.4, energy: 1 },
  listening: { listen: 1, think: 0, speak: 0, energy: 1 },
  transcribing: { listen: 0.3, think: 0.6, speak: 0, energy: 0.95 },
  thinking: { listen: 0, think: 1, speak: 0, energy: 0.9 },
  working: { listen: 0, think: 1, speak: 0, energy: 0.95 },
  speaking: { listen: 0, think: 0, speak: 1, energy: 1 },
  rearming: { listen: 0, think: 0, speak: 0.2, energy: 0.7 },
}

/** Rings spin harder while JARVIS is working — reads as effort. */
const spinFor: Record<Phase, number> = {
  offline: 0.08, // barely turning — the machine is off
  boot: 3.2,
  dormant: 0.25,
  waking: 4.5,
  listening: 1.1,
  thinking: 2.8,
  tooling: 3.6,
  speaking: 1.4,
}

/**
 * Surface displacement amplitude. Both states where nothing is happening get
 * the calm figure: 'offline' is the quietest moment in the whole piece — the
 * reactor hasn't been powered on yet — so it must not be the most agitated
 * thing on screen.
 */
/*
 * Much lower than they were. At 0.13/0.26 on a unit sphere the displacement is
 * a quarter of the radius, which is not a reactor breathing — it is a potato.
 * The reference core is a clean circle whose surface only shimmers; the drama
 * belongs to the instrument rings around it, not to the silhouette.
 */
const AMP_CALM = 0.035
const AMP_LIVE = 0.085

/**
 * Everything the three children animate from, in one mutable object.
 *
 * These used to be render-time props, which had two consequences. The scene
 * subscribed to mic level, so the entire r3f tree reconciled sixty times a
 * second for numbers that never leave useFrame; and because they were only
 * delivered on a re-render, they were delivered late or — before the analyser
 * starts and `level` is a constant zero — not at all, which is why the ignition
 * screen never picked up its own spin rate.
 *
 * Nothing here belongs in React state. The scene is updated by mutation and
 * React only ever mounts it: Rig writes this object once per frame, the
 * children read it in their own useFrame. Children subscribe to the frame loop
 * before their parent does, so they are reading the previous frame's values —
 * one frame of lag on quantities that are all lerped anyway, and invisible.
 */
export type Drive = {
  color: THREE.Color
  /** 0..1 smoothed loudness, with an idle breath under it. */
  level: number
  /** Rotation multiplier for the drifting dust. */
  spin: number
  /** Target displacement amplitude for the core surface. */
  amp: number
  /** 0..1 power-up reveal — the ring assembles outwards from the centre. */
  open: number
  /** Smoothed state signatures; see weightsFor. */
  w: Weights
  /** prefers-reduced-motion: ambient drift stops, state motion slows. */
  calm: boolean
  /**
   * The reactor slice of the ui state, already resolved and smoothed.
   *
   * Everything here is a no-op at UI_DEFAULTS: colour follows the phase exactly
   * as it always did, and the three multipliers sit at one.
   */
  reactor: {
    /** ui.reactor.color if set, otherwise the accent. */
    color: THREE.Color
    scale: number
    intensity: number
    /** Multiplier on the ring's own rotation rate. */
    spin: number
    /** 0 ring, 1 sphere, 2 wire — a number because it ends up in a uniform. */
    style: number
    visible: boolean
  }
}

/**
 * A colour target that only re-parses when the string actually changes.
 *
 * The colours in the ui slice are arbitrary CSS written by JARVIS, and
 * THREE.Color.set logs a warning for anything it cannot parse. Setting one
 * unconditionally per frame turns a single typo into sixty console lines a
 * second, which drowns everything else out during a demo.
 */
type Tint = { key: string; color: THREE.Color }

function aim(tint: Tint, css: string): THREE.Color {
  if (tint.key !== css) {
    tint.key = css
    tint.color.set(css)
  }
  return tint.color
}

const STYLE_INDEX = { ring: 0, sphere: 1, wire: 2 } as const

function Rig() {
  const drive = useMemo<Drive>(
    () => ({
      color: new THREE.Color(phaseColor.offline),
      level: 0,
      spin: spinFor.offline,
      amp: AMP_CALM,
      open: 0,
      w: { ...weightsFor.offline },
      calm: false,
      reactor: {
        color: new THREE.Color(phaseColor.offline),
        scale: 1,
        intensity: 1,
        spin: 1,
        style: STYLE_INDEX.ring,
        visible: true,
      },
    }),
    [],
  )
  const target = useMemo<Tint>(() => ({ key: '', color: new THREE.Color() }), [])
  const reactorTarget = useMemo<Tint>(
    () => ({ key: '', color: new THREE.Color() }),
    [],
  )

  useFrame((state, dt) => {
    // Read imperatively rather than subscribing — see the note on Drive.
    const { phase, level, ui, voiceState } = useStore.getState()
    const display = deriveDisplay(phase, voiceState)
    drive.calm = prefersReducedMotion()

    // accentFor owns the accent -> palette -> phase resolution order. The scene
    // asking the store for the answer rather than working it out again is what
    // keeps the orb and the HUD from ever disagreeing about the colour.
    const accent = accentFor(phase, ui)
    drive.color.lerp(aim(target, accent), Math.min(1, dt * 2.5))

    const r = ui.reactor
    drive.reactor.color.lerp(
      aim(reactorTarget, r.color ?? accent),
      Math.min(1, dt * 2.5),
    )
    // Smoothed rather than assigned, so "make it twice the size" grows into
    // place instead of snapping. The style is the exception: it is a mode, and
    // easing between two of them would drag the picture through the third.
    const k = Math.min(1, dt * 5)
    drive.reactor.scale += (r.scale - drive.reactor.scale) * k
    drive.reactor.intensity += (r.intensity - drive.reactor.intensity) * k
    drive.reactor.spin += (r.spin - drive.reactor.spin) * k
    drive.reactor.style = STYLE_INDEX[r.style] ?? STYLE_INDEX.ring
    drive.reactor.visible = r.visible

    const goal = weightsFor[display]
    const kw = Math.min(1, dt * 3)
    drive.w.listen += (goal.listen - drive.w.listen) * kw
    drive.w.think += (goal.think - drive.w.think) * kw
    drive.w.speak += (goal.speak - drive.w.speak) * kw
    drive.w.energy += (goal.energy - drive.w.energy) * kw

    drive.spin += (spinFor[phase] * (drive.calm ? 0.2 : 1) - drive.spin) * Math.min(1, dt * 2)
    drive.amp = phase === 'dormant' || phase === 'offline' ? AMP_CALM : AMP_LIVE
    // Held shut until the reactor is powered on, so the ring builds itself out
    // of the centre on the ignition click rather than simply appearing.
    drive.open = phase === 'offline' ? 0.28 : phase === 'boot' ? 0.7 : 1.6

    // Idle breathing so the orb is never completely still.
    const idle = phase === 'offline' ? 0.02 : phase === 'dormant' ? 0.05 : 0.12
    const breathe =
      (Math.sin(state.clock.elapsedTime * 0.9) * 0.5 + 0.5) * idle
    // Only the two states whose sound the reactor is meant to show get the
    // level: the user while the mic is open, JARVIS while he speaks. Anything
    // else is room noise arriving through a microphone that is paused, and a
    // reactor pulsing to it would say the opposite of the readout under it.
    const heard = display === 'listening' || display === 'speaking' ? level : 0
    const want = Math.max(heard, breathe)
    drive.level += (want - drive.level) * Math.min(1, dt * 9)

    // Slow drift on the camera gives the particle field parallax against the
    // ring. Off under reduced motion.
    const t = state.clock.elapsedTime
    state.camera.position.x = drive.calm ? 0 : Math.sin(t * 0.13) * 0.28
    state.camera.position.y = drive.calm ? 0 : Math.cos(t * 0.17) * 0.18
    state.camera.lookAt(0, 0, 0)

    // Lift the whole scene to the reactor's place in the layout by shifting
    // the projection window, so the ring, its dust and anything in orbit move
    // together and the vector instrument over it lines up (ui/layout.ts).
    const { width: w, height: h } = state.size
    const lift = Math.round(h / 2 - reactorFrame(w, h).y)
    const cam = state.camera as THREE.PerspectiveCamera
    if (cam.view?.offsetY !== lift || cam.view?.fullWidth !== w || cam.view?.fullHeight !== h) {
      cam.setViewOffset(w, h, 0, lift, w, h)
    }
  })

  // Nothing in here is lit: both the core and the dust are raw ShaderMaterials,
  // which do not read the light list. The scene therefore has no lights at all.
  //
  // The tilted gyro rings that used to sit here are gone. Steeply tilted arcs
  // crossing in front of a complete circle do not read as depth — they read as
  // scratches on the lens, and as broken circles in a design whose whole
  // subject is one unbroken one.
  return (
    <>
      <Core drive={drive} />
      <Particles drive={drive} />
      <Orbits />
    </>
  )
}

export function Scene() {
  return (
    <Canvas
      className="scene"
      camera={{ position: [0, 0, 6.2], fov: 45 }}
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 2]}
    >
      <Rig />
      {/*
        multisampling={0} on purpose. The default is 8, which allocates a
        half-float MSAA target — at dpr 2 that is a 3200x1800 buffer — and there
        is not one polygon edge in this scene for it to smooth: everything is
        additive blobs, point sprites and lines, all of which are already
        soft-edged by their own falloff and then blurred again by bloom.

        Tone mapping is also deliberate, if less obviously so. EffectComposer
        forces gl.toneMapping to NoToneMapping while it is mounted (there is no
        prop for it), so the additive output clips instead of rolling off. That
        hard clip to white is the neon look this piece wants — the sweep and the
        rim are meant to blow out. If you ever want the filmic roll-off back,
        add a <ToneMapping mode={ToneMappingMode.ACES_FILMIC} /> effect at the
        end of this chain rather than touching the renderer.
      */}
      <EffectComposer multisampling={0}>
        {/* Bloom is what turns additive lines into "hologram". */}
        <Bloom
          intensity={0.9}
          // A higher threshold keeps the mid-tones intact so the orb doesn't
          // flatten into a solid white disc.
          luminanceThreshold={0.22}
          luminanceSmoothing={0.85}
          mipmapBlur
          radius={0.72}
        />
        {/* No chromatic aberration or film grain: they blurred the fine
            calibration work into the ring and read as a camera effect laid
            over an instrument. */}
        <Vignette eskil={false} offset={0.22} darkness={0.9} />
      </EffectComposer>
    </Canvas>
  )
}
