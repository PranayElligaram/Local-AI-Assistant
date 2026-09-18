# JARVIS rebuild - working state

Resume notes for an interrupted session. The filesystem and git state are
authoritative; this file says what the last session did.

## Where the work lives
- Canonical repo: `C:\Users\prana\dev\src\Jarvis`
- Worktree: `C:\Users\prana\dev\src\Jarvis\.claude\worktrees\jarvis-rebuild`,
  branch `worktree-jarvis-rebuild`. All work is uncommitted in the working tree.
  No pushes, no PRs.
- Recovery: tags `pre-jarvis-rebuild-head-20260917-185654`,
  `pre-jarvis-rebuild-worktree-20260917-185654`, and stash
  `pre-jarvis-rebuild-working-tree-20260917-185654`. Never delete these.

## Current phase
COMPLETE (automatable scope), 2026-09-18. Only physical/human validation
remains - see the checklist in JARVIS_REBUILD_REPORT.md ("Human validation
required").

## Completed
- Claude runtime removed (Agent SDK, Anthropic SDK, MCP servers, direct browser
  path); packages uninstalled; isolation tests guard against regression.
- Local brain: `bridge/brain/` (BrainChain + OllamaBrain), granite4:3b primary,
  qwen3.5:4b fallback, keep_alive 30m, think:false, bounded timeouts.
- Deterministic router, JARVIS-owned tools, conversation engine with claim guard.
- Installed-application catalogue/resolver, aliases and portable apps
  (`npm run app -- ...`, `jarvis.apps.json`, git-ignored).
- Diagnostics (bridge `/diagnostics` + D panel) extended: brain, apps, tools,
  process, voice.
- Lifecycle: duplicate-start rejection, stale PID handling, per-child start
  times, spoken restart (exit 75 -> launcher respawns bridge), restart option
  forwarding. Codex's interrupted launcher test fixed (default grace period).
- Docs: README, .env.example, JARVIS_REBUILD_REPORT.md.

## Current tests (final run)
- `npm test`: 147 tests, 147 pass, 0 fail.
- typecheck pass; lint 0 findings; build pass; 7/7 PowerShell scripts parse.
- `npm run e2e`: 10 passed, 0 failed (real Ollama); `e2e:offline` 6/6.

## Live instance
The new build is running (started with `scripts\jarvis.ps1` in a minimized
PowerShell window): bridge 127.0.0.1:8787, UI http://localhost:5173.

## Known blockers
None for automatable work. Human-only: microphone, speakers, wake word,
barge-in by voice, ElevenLabs voice quality.

## Next action if resuming
Run the human validation checklist in JARVIS_REBUILD_REPORT.md. If committing,
review `git status` (tracked deletions of bridge/{panels,ui,chrome,vision}.mjs
and src/lib/anthropic.ts are intentional).

## Repair pass 2026-09-18 — voice pipeline, self-listening, Discord duplicate

- Voice root cause: ElevenLabs STT is refused (401) so the browser recogniser runs, and it never touches
  `/stt` (hence sttRequests/lastHeardAt 0 — those fields only ever measured Scribe). Browser wake fired on
  *partials* ("hey jarvis what" -> sent "what"); the loop was full-duplex with voice barge-in, so JARVIS's
  own ElevenLabs output became barge-ins / follow-up commands (cancelledTurns), and after every answer it
  stayed in command mode for 11 s (`FOLLOW_UP_MS`) hearing its own tail.
- Fix (src/lib/voice.ts, src/App.tsx, src/lib/tts.ts): half-duplex (`VOICE_BARGE_IN = false`, keyboard
  interrupt kept), `effectiveMode` closes the mic while TTS plays + `REARM_MS` 500 ms, recognition
  generation (`diag.recognitionGeneration`) bumps on every close/re-open; stale segments, STT responses,
  endpoint timers and old recogniser callbacks are dropped; browser recogniser is aborted while he speaks
  and rebuilt afterwards; after a turn the app returns to `dormant` (wake word only).
- Diagnostics: `window.__voice` gains voiceState/wakeListening/commandRecognitionActive/ttsActive/
  recognitionGeneration/lastFinalTranscript/lastUtteranceSentAt/lastWakeAt; bridge `/diagnostics.voice`
  shows asksReceived/lastAskAt plus the page's reported state (no transcript text).
- Apps: discovery reads each Start Menu .lnk's target/args/workdir (bounded, by index); `buildCatalogue`
  merges same-name rows with the same `launchIdentity` (`<root>|<exe>`, `app-<ver>` and
  `Update.exe --processStart X.exe` normalised) and keeps the best `targetRank`. Different roots stay ambiguous.
- Verified: 159/159 tests, typecheck, lint, build; live bridge: time->router, "Why is the sky blue?"->
  granite4:3b, "Open Discord"->router open_application ok; `npm run app -- resolve Discord` -> one entry.
- Human-only: physical mic/speaker confirmation of no self-listening.
