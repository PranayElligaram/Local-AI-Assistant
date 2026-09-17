/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 *
 * Beyond upstream, this file owns two things the previous implementation had
 * and this one needs just as much:
 *
 *   - device SELECTION, so the assistant is not stuck with whatever Windows
 *     calls the default (see mic.ts for the rules);
 *   - device RECOVERY. A headset unplugged mid-conversation ends the track,
 *     and nothing in the browser tells the rest of the app: the level meter
 *     simply sits at zero for ever. Here that is noticed, the device is
 *     reopened with backoff, and whoever is listening is handed the new stream.
 */

import { MIC_PREFERENCE } from '../config'
import { chooseMic, retryDelay, type MicSelection } from './mic'

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null
let opening: Promise<MediaStream> | null = null

/**
 * Live state of the microphone, published on `window.__mic` and read by the
 * diagnostics panel. "Is anything arriving from the microphone at all" is the
 * first question every voice bug asks, and it should not need a debugger.
 */
export const micDiag = {
  /** Have we ever successfully opened a device. */
  open: false,
  /** Label of the device actually in use, once labels are readable. */
  label: '',
  /** Configured preference, verbatim. */
  preference: MIC_PREFERENCE,
  /** How the device was chosen: default | index | name | fallback. */
  reason: 'default' as MicSelection['reason'],
  /** Set when a preference could not be honoured. Never silent. */
  fallback: '',
  /** How many input devices the browser reports. */
  devices: 0,
  /** Times the stream was lost and reopened. */
  recoveries: 0,
  /** Last failure opening or holding the device. */
  lastError: '',
  /** When the track last ended unexpectedly. */
  lostAt: 0,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__mic = micDiag
}

const listeners = new Set<(s: MediaStream) => void>()

/** Told when the stream is replaced, so a consumer can rebuild its pipeline. */
export function onMicChange(fn: (s: MediaStream) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

async function inputDevices(): Promise<{ deviceId: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((d) => d.kind === 'audioinput')
      // 'default' and 'communications' are Windows aliases for a device that is
      // also listed under its own name; counting them makes "Yeti" look
      // ambiguous when only one Yeti is plugged in.
      .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }))
  } catch {
    return []
  }
}

/**
 * Open the configured device, or the system default.
 *
 * Labels are only readable once permission has been granted, so on a cold start
 * this opens the default device first, then re-resolves the preference against
 * the now-named devices and reopens if the answer is different. One extra open
 * at boot, and the only way the browser will tell us what anything is called.
 */
async function open(): Promise<MediaStream> {
  const first = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS })
  const devices = await inputDevices()
  micDiag.devices = devices.length

  const choice = chooseMic(devices, MIC_PREFERENCE)
  micDiag.reason = choice.reason
  micDiag.fallback = choice.fallback
  if (choice.fallback) console.warn(`[jarvis] microphone: ${choice.fallback}`)

  let live = first
  if (choice.deviceId) {
    const current = first.getAudioTracks()[0]?.getSettings().deviceId
    if (current !== choice.deviceId) {
      try {
        live = await navigator.mediaDevices.getUserMedia({
          audio: { ...CONSTRAINTS, deviceId: { exact: choice.deviceId } },
        })
        for (const track of first.getTracks()) track.stop()
      } catch (err) {
        // The named device exists but will not open — in use by another app,
        // or just removed. Deafness is worse than the wrong device.
        micDiag.fallback = `could not open "${choice.label}" (${
          err instanceof Error ? err.name : 'unknown error'
        }) — using the system default`
        micDiag.reason = 'fallback'
        console.warn(`[jarvis] microphone: ${micDiag.fallback}`)
        live = first
      }
    }
  }

  const track = live.getAudioTracks()[0]
  micDiag.open = true
  micDiag.label = track?.label ?? ''
  micDiag.lastError = ''
  watch(live)
  return live
}

/** Reopen after a loss, patiently, and hand the new stream to consumers. */
async function reacquire(attempt = 0): Promise<void> {
  if (attempt === 0) micDiag.recoveries++
  try {
    stream = await open()
    for (const fn of listeners) {
      try {
        fn(stream)
      } catch (err) {
        console.warn('[jarvis] a microphone consumer failed to restart:', err)
      }
    }
    console.log(`[jarvis] microphone recovered: ${micDiag.label || 'default device'}`)
  } catch (err) {
    micDiag.lastError = err instanceof Error ? err.name : String(err)
    // Never give up entirely: the usual cause is a device being plugged back
    // in, which can be minutes away. The delay tops out, it does not stop.
    setTimeout(() => void reacquire(attempt + 1), retryDelay(attempt))
  }
}

/**
 * Notice when the device goes away.
 *
 * `ended` fires when the device is unplugged or taken by another application.
 * `mute` fires when the OS silences it, which Windows does on some Bluetooth
 * transitions and which is indistinguishable from a quiet room unless someone
 * is watching for it.
 */
function watch(s: MediaStream) {
  const track = s.getAudioTracks()[0]
  if (!track) return
  track.addEventListener('ended', () => {
    if (stream !== s) return
    micDiag.open = false
    micDiag.lostAt = Date.now()
    micDiag.lastError = 'the microphone was disconnected'
    console.warn('[jarvis] the microphone ended — reopening')
    void reacquire()
  })
  track.addEventListener('mute', () => {
    if (stream !== s) return
    micDiag.lastError = 'the microphone was muted by the system'
  })
  track.addEventListener('unmute', () => {
    if (stream === s && micDiag.lastError.includes('muted')) micDiag.lastError = ''
  })
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener?.('devicechange', () => {
    void inputDevices().then((devices) => {
      micDiag.devices = devices.length
      // A device list that changed while our track is dead is the plug going
      // back in. A live track is left alone: switching device mid-sentence
      // would cost the sentence.
      const track = stream?.getAudioTracks()[0]
      if (!track || track.readyState === 'ended') void reacquire()
    })
  })
}

export async function getMic(): Promise<MediaStream> {
  if (stream && stream.getAudioTracks()[0]?.readyState === 'live') return stream
  // Concurrent callers (the VAD, the analyser, the voice loop) must not each
  // open their own stream — Chrome drops the earlier one when they do.
  if (!opening) {
    opening = open()
      .then((s) => {
        stream = s
        return s
      })
      .catch((err) => {
        micDiag.open = false
        micDiag.lastError = err instanceof Error ? err.name : String(err)
        throw err
      })
      .finally(() => {
        opening = null
      })
  }
  return opening
}

/** Hand the device back. Used on shutdown, so the OS indicator goes out. */
export function releaseMic(): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop()
    } catch {
      /* already gone */
    }
  }
  stream = null
  micDiag.open = false
}

export async function startAnalyser(): Promise<void> {
  if (analyser) return
  const s = await getMic()
  ctx = new AudioContext()
  attach(s)
  // The reactor's meter has to follow the device across a reconnect, or it
  // stays flat for ever after a headset is unplugged and plugged back in.
  onMicChange((next) => {
    if (ctx) attach(next)
  })
}

function attach(s: MediaStream): void {
  if (!ctx) return
  const src = ctx.createMediaStreamSource(s)
  analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.75
  src.connect(analyser)
  buf = new Uint8Array(analyser.frequencyBinCount)
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
