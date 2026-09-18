import * as bridge from './bridge'
import type { AskHandlers } from './bridge'
import type { Blade, Panel } from '../store'

export type { AskHandlers }
export type { ConnectionState } from './bridge'

/**
 * The brain is the local bridge (bridge/server.mjs): a deterministic router,
 * JARVIS-owned tools, and a local Ollama model. There is no browser-direct
 * cloud path any more - nothing in the page holds a model key, and nothing
 * here needs Claude or any other cloud service.
 */

/** Conversation state lives in the bridge session. */
export async function ask(
  prompt: string,
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  return bridge.ask(prompt, handlers)
}

export async function warm(): Promise<void> {
  await bridge.warmBridge()
}

/** Labels for the HUD's systems rail, reported by the bridge on connect. */
export function watchServers(fn: (servers: string[]) => void): void {
  bridge.watchServers(fn)
}

/** HUD panels pushed by the bridge mid-turn. */
export function watchPanels(fn: (panel: Panel) => void): void {
  bridge.watchPanels(fn)
}

/** Blades - the big surface - arrive the same way. */
export function watchBlades(fn: (blade: Blade) => void): void {
  bridge.watchBlades(fn)
}

/** Interface commands from the bridge, e.g. `diagnostics`. */
export function watchUi(fn: (op: string, args: any) => void): void {
  bridge.watchUi(fn)
}

/** The one thing the bridge may ask the page for: a camera frame. */
export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  bridge.watchCapture(fn)
}

/**
 * Barge-in. Tells the bridge to abandon the turn (which cancels the model
 * request) and settles the outstanding `ask()` with the text so far.
 */
export function cancel(): void {
  bridge.cancel()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** Whether the bridge socket is up right now. */
export function isConnected(): boolean {
  return bridge.isConnected()
}

/** Connection state, for the UI. */
export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  bridge.watchConnection(fn)
}

/** Labels for the HUD's SYSTEMS rail. */
export function connectedLabels(): string[] {
  return bridge.bridgeServers()
}
