# JARVIS rebuild - final report

Date: 2026-09-18 · Worktree: `C:\Users\prana\dev\src\Jarvis\.claude\worktrees\jarvis-rebuild`
· Branch: `worktree-jarvis-rebuild` (uncommitted; nothing pushed, no PR)

## Executive summary

JARVIS now runs entirely on this machine, and nothing in its runtime depends on
Claude. The Claude Agent SDK brain has been replaced by three local layers:

1. a deterministic intent router for obvious commands,
2. JARVIS-owned, schema-validated tools, and
3. a local Ollama brain: `granite4:3b` primary, `qwen3.5:4b` fallback.

"Open *any installed app*" works through a Windows application catalogue built
from the Start Menus, App Paths and Start apps (including UWP). The voice, wake,
barge-in, diagnostics and lifecycle work from earlier passes (including the
Codex hardening) is kept and covered by tests.

Results: **147/147 tests pass**; typecheck, lint (0 findings) and build pass;
all 7 PowerShell scripts parse; **local E2E 10/10** against the real Ollama.
Physical microphone/speaker checks remain for a human (listed at the end).

## Final architecture

```
 Chrome/Edge (face + voice)                    bridge/server.mjs  (127.0.0.1:8787)
 ------------------------------                ------------------------------------------
 INITIALISE, WebGL reactor, HUD                assistant.mjs  - one conversation per socket
 "Hey Jarvis" wake (transcript/Porcupine)        1. pending "which one?" answer
 mic: device choice, recovery, VAD      ws       2. router.mjs  -> tools.mjs (no model)
 STT: ElevenLabs Scribe | browser     <----->    3. brain/  BrainChain
 TTS: ElevenLabs | browser | Kokoro                  OllamaBrain granite4:3b -> qwen3.5:4b
 barge-in, diagnostics (D), self-test (T)        tools.mjs  - registry, validation, execution
                                                 apps/      - discover, catalog, resolve, launch
                                                 web.mjs    - search URLs + WebSearchProvider point
 scripts/start.mjs launcher (PID file, children, restart-on-75)   stop.ps1 / restart.ps1 / jarvis.ps1
```

## How it follows the original adewaskar/JARVIS guide

Kept: the web page as the face (React + Three.js + GLSL reactor, INITIALISE boot
sequence), the local bridge as brain and hands, a real Chrome/Edge window for
microphone and WebGL, "Hey Jarvis", continuous conversation with follow-up
window, barge-in, the D diagnostics panel and T audio self-test, optional
ElevenLabs with browser speech fallback, read-only by default with a separate
writes mode (`npm run start:writes` / `bridge:writes`), `npm start` as the
one-command start, Node 20+.

## Intentional deviation: Claude removed from the runtime

Removed: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk` (and `zod`, used
only by the SDK tool definitions); the SDK `query()` session; the in-process MCP
servers (`bridge/panels.mjs`, `ui.mjs`, `chrome.mjs` - which drove Chrome through
the Claude browser extension - and `vision.mjs`); the `decideTool` MCP policy;
project MCP loading (`jarvis.mcp.json`); `JARVIS_MODEL`/`JARVIS_EFFORT`/
`JARVIS_WORKSPACE`/`JARVIS_ENABLE_CHROME`/`JARVIS_ENABLE_CAMERA`; the browser-
direct Claude path (`src/lib/anthropic.ts`, `VITE_BACKEND`,
`VITE_ANTHROPIC_API_KEY`, MCP URL settings); the Claude CLI check in `setup`;
the Claude-specific result classifier (`bridge/result.mjs`) and
`scripts/e2e-turn.mjs`.

Consequences, stated honestly: the model-authored HUD panels/blades, interface
retinting by voice, camera "look/watch" and Chrome-extension browsing were
Claude-tool features and are no longer driven by the model (the UI code for
panels, blades and the camera remains and still renders anything the bridge
sends). A 3B local model is not a replacement for those agentic features.

Remaining mentions of Claude are history/documentation only (README credit,
comments noting what upstream did) plus the diagnostics fields
`claudeRuntime: "none"` / `globalClaudeConfigRead: false`. A test
(`isolation.test.mjs`) fails if any Anthropic package, import, `claude`
subprocess, `ANTHROPIC_API_KEY` or `api.anthropic.com` reference reappears in
`bridge/`, `src/` or `scripts/`, and another starts the bridge with no Claude
environment and an empty home directory.

## Claude Code role: development only

Claude Code (and another coding agent before it) was used to write this code.
JARVIS works with Claude Code logged out, uninstalled, rate-limited or
unreachable. The user's Claude installation was not modified.

## Deterministic command design

`bridge/router.mjs`: `normalizeUtterance()` removes the wake phrase and
politeness ("could you", "please", "for me"), then small parsers each own one
intent: time, date, diagnostics, system status, restart/stop Jarvis (the name is
required: bare "stop" stays a barge-in word), refresh applications, research,
search ("search Google for X", "google X", "look up X on Google"), URLs and
spoken domains ("go to example dot com"), and "open/launch/start/fire up <app>"
(short names only; "start thinking about dinner" is left to the model). A
routed request runs its JARVIS tool directly - **no model call**. Time and date
come from the system clock and work with Ollama stopped and no internet (proved
by `e2e:offline` and `bridge.test.mjs`).

## Granite architecture

`bridge/brain/provider.mjs` defines the provider-neutral shape (`id`, `model`,
`supportsTools`, `health()`, `stream()`, `chat()`, `warm()`, `unload()`,
`diagnostics()`) and `BrainChain`. `bridge/brain/ollama.mjs` is the only file
that knows Ollama's HTTP API: streamed `/api/chat` with `tools`, `keep_alive:
"30m"`, `think: false`, `num_predict` cap, separate connect / warm-response /
cold-load timeouts, NDJSON parsing, and a typed `BrainError` for every failure
(`offline`, `timeout`, `model_missing`, `bad_response`, `provider_error`,
`stream_failed`, `empty`, `aborted`). The bridge warms granite at startup
(one request) and unloads it (`keep_alive: 0`) on a real stop; a voice restart
keeps it warm. System prompt per spec, plus "answer general knowledge directly;
use search_web only for live information".

Streaming: text deltas go to the browser as they arrive; the browser speaker
already chunks by sentence. The assistant holds only the first sentence back to
check it is not an unexecuted action claim (see Tool security).

Measured on this machine (CPU inference): warm granite answers in about 2-4 s;
the first question after load, with the tool schemas in the prompt, took
about 7-12 s.

## Qwen fallback

Tried only when granite fails *before producing any output* with a recoverable
error (model missing, timeout, malformed/failed stream, provider error, empty).
Not tried when Ollama itself is offline (same server) or the turn was cancelled;
never switched mid-answer. One attempt per model per turn. Also `think: false`.
Diagnostics report which model answered (`lastModel`, `lastFallbackUsed`).
E2E: with the primary set to a missing model, qwen3.5:4b answered.

## Ollama health / failure behaviour

Any brain failure produces the spoken line "My local AI brain is unavailable
right now." with `source: "unavailable"` (never counted as an AI answer), the
error is recorded for diagnostics, and the socket, microphone and TTS carry on.
Deterministic commands keep working. Tested with a fake Ollama for offline,
timeout, stalled stream, missing model, malformed JSON, error chunk, early end,
empty answer and HTTP 500, and live with Ollama unreachable.

## Application resolver

`bridge/apps/`: `discover.mjs` reads the current-user and all-users Start Menu
(`.lnk`, `.appref-ms`, `.exe`; depth-bounded; uninstall/readme/help/website
entries skipped), App Paths in HKCU and HKLM (`reg.exe query`, existing `.exe`
only), and `Get-StartApps` (packaged/UWP and desktop; documents and web links
dropped), plus Windows built-ins as a fallback. No drive scan. `catalog.mjs`
merges them by priority (user > Start Menu > Start apps > App Paths > built-in;
the last two only fill gaps), attaches built-in aliases, caches to
`.jarvis\app-catalog.json`, refreshes daily in the background and once on a
miss. On this machine: **229 applications** (Start Menu user 34, system 95, App
Paths 49, Start apps 176, built-in 7 before de-duplication).

`resolve.mjs`: exact normalized name -> user alias -> built-in/entry alias ->
strong token/prefix match -> conservative fuzzy (launch only at >= 0.88 and
unique; 0.70-0.88 is a suggestion only). Several plausible matches return
`ambiguous` with the candidates; build variants of one app ("Windows PowerShell"
vs "(x86)") collapse to the plainest, different versions ("Python 3.12" vs
"3.13") and same-named different apps (two "Calendar"s) always ask. The reply
"the first one" / a candidate name opens it.

Measured live: Spotify, VS Code, Word, Chrome, Calculator, PowerShell, Python
resolved; "Visual Studio" -> ambiguous (Code / Installer); "git" -> ambiguous
(Bash / CMD / GUI); "spotfy" -> suggestion only. One real launch performed:
Calculator (then closed).

## Application alias / portable-app mechanism

`jarvis.apps.json` (git-ignored), written only by `scripts/apps.mjs`:
`npm run app -- list | refresh | resolve <name> | aliases | alias <alias> <app>
| add <alias> <path> | remove <alias>`. Portable targets must be absolute,
existing `.exe`, `.lnk` or `.appref-ms` files and are re-validated on every
read. No tool writes this file, so no spoken sentence or model output can
register an executable.

## Tool execution security boundary

`bridge/tools.mjs` owns the registry: `get_time`, `get_date`,
`open_application`, `open_url`, `search_web`, `get_system_status`,
`show_diagnostics` (model-callable); `research_web`, `refresh_applications`,
`restart_jarvis`, `stop_jarvis` (router only). Every call: known name ->
callable by this caller -> JSON arguments parsed -> schema (types, lengths,
patterns, no extra keys) -> extra checks -> permission level -> JARVIS
implementation -> `{ ok, say, data }`. Unknown, malformed and invalid calls are
rejected and counted. `open_application` takes a name only (letters, digits,
limited punctuation; flags such as `-c`, `/c`, `--x` and script/exe-with-args
patterns rejected); the launcher executes a **catalogue entry** with **no
arguments** and `shell: false`. URLs must be http(s) without credentials.
There is no shell, command, file or install tool. A model that *says* it opened
something without calling the tool is not believed: the claim is replaced by
the real validated action when routable, or by "I couldn't carry that out."

## Wake-word architecture

Unchanged from the repaired upstream: "Hey Jarvis" matched in the recogniser
transcript (tolerant of common mis-hearings, possessives rejected), or offline
Porcupine with `VITE_PICOVOICE_ACCESS_KEY`. Wake re-arms after the follow-up
window. Tests: `wake.test.mjs`, `voice-lifecycle.test.mjs`.

## Microphone architecture

`src/lib/mic.ts` / `audio.ts` (Codex hardening kept): device preference by
index or unique name fragment (ambiguous names refused), permission timeout
with late-grant recovery, one shared pending open request, recovery on track
end / device change without overlapping streams, recovery cancelled after
release. Tests: `mic.test.mjs`, `audio-lifecycle.test.mjs`.

## STT architecture

Capability-based: ElevenLabs Scribe via the bridge only while `/health` says the
key may transcribe; otherwise the browser recogniser with a heartbeat. A 401/403
from ElevenLabs is remembered: `/health` reports `stt: false`, further `/stt`
calls are refused locally without contacting ElevenLabs, diagnostics show
"STT denied", and the browser switches to its recogniser. Stale/late recogniser
and STT events cannot affect a replacement. Tests: `speech.test.mjs`,
`voice-lifecycle.test.mjs`.

## TTS architecture

ElevenLabs via the bridge `/tts` (bounded timeout, key never logged or sent to
the page) when configured and permitted; any failure falls back to the browser
voice for that line; a 401/403 marks TTS denied and stops further calls; an OS
voice that produces no sound is rescued through the bridge. Kokoro remains
optional. Tests: `speech.test.mjs`, `bridge.test.mjs`.

## Barge-in

Voice layer: speech onset in guard mode (while JARVIS thinks or speaks) calls
`onSpeechStart`, except in the first instant of his own playback. App layer:
the speaker is cancelled, queued speech dropped, `interrupt` sent. Bridge: the
turn's `AbortController` aborts the Ollama request (the HTTP stream is closed),
and a new question supersedes the old turn; frames are tagged with the ask id so
a late tail is ignored. Tests: `bargein.test.mjs`, `assistant.test.mjs`
(cancellation, no late frames), `brain.test.mjs` (request actually closed).

## Browser / UI

Real Chrome or Edge at `http://localhost:5173` (Vite, `strictPort`), bridge on
127.0.0.1 only, WebSocket origin allowlist (localhost dev ports). Diagnostics
panel (D, or "show diagnostics") now shows BRAIN (mode Local, provider Ollama,
granite/qwen health, last model, latency, last error, endpoint, cloud required:
No, Claude runtime: None), APPLICATIONS, TOOLS, PROCESS (PID, port, run-file
ownership, uptime) and VOICE (wake, STT/TTS provider, ElevenLabs capability,
barge-in) alongside the existing microphone/listening/speaking sections.

## Windows lifecycle

`scripts/start.mjs`: exclusive PID-file creation; a duplicate start exits 1
without touching the live files; a stale PID file is replaced only if its
launcher is gone or no longer a node.exe (tasklist check); per-child start
times for `stop.ps1`'s PID-reuse guard; exit as soon as the children are gone;
a bridge exit code 75 (spoken "restart Jarvis") respawns just the bridge (max 5
per 10 minutes). Bridge: run file written only by the instance that owns the
port and removed only by it; token-authorised `POST /shutdown`; stdin-close
shutdown. `stop.ps1` asks first, then stops only its own node processes.
`restart.ps1` forwards `-Writes/-Open/-Monitor/-Fullscreen` (tested: restart
with `-Writes` yields a writes-mode instance). Test runs use isolated run
directories and spare ports and never touch the live instance.

The interrupted Codex change: `tests/launcher.test.mjs` called `stop.ps1
-GraceSeconds 1`, shorter than the launcher's legitimate ~3 s graceful exit, so
stop.ps1 force-killed it and the test saw exit code -1. Fixed by using the
default grace in the test and by making the launcher exit as soon as its
children have exited (no fixed 3 s wait).

## Safe / read-only / write mode

Safe by default. Writes mode is still a separate, explicit launch option and
is reported in diagnostics, but no effectful tool (delete, send, install,
purchase, account change) is registered at all, and the model cannot execute a
shell command in either mode.

## Files materially changed

New: `bridge/brain/{provider,ollama,index}.mjs`, `bridge/router.mjs`,
`bridge/tools.mjs`, `bridge/assistant.mjs`, `bridge/web.mjs`,
`bridge/apps/{discover,catalog,resolve,registry,launch}.mjs`, `scripts/apps.mjs`,
`scripts/e2e.mjs`, tests `brain`, `router`, `tools`, `apps`, `assistant`,
`speech`, `bargein` (plus Codex's `launcher`, `powershell`, `audio-lifecycle`,
`voice-lifecycle`, `browser-modules`).
Rewritten/edited: `bridge/server.mjs`, `bridge/config.mjs`, `bridge/policy.mjs`,
`scripts/start.mjs`, `scripts/stop.ps1`, `scripts/diagnostics.mjs`,
`src/lib/{brain,bridge,capabilities,tts}.ts`, `src/config.ts`, `src/App.tsx`,
`src/ui/Diagnostics.tsx`, `src/store.ts`, `package.json`, `package-lock.json`,
`.env.example`, `.gitignore`, `README.md`, tests `bridge`, `config`, `policy`,
`isolation`, `launcher`.
Deleted: `bridge/{panels,ui,chrome,vision,result}.mjs`, `src/lib/anthropic.ts`,
`scripts/e2e-turn.mjs`, `tests/result.test.mjs`.
Kept from the Codex pass: `src/lib/{audio,voice}.ts`, `scripts/{jarvis,node,
open-ui,restart}.ps1`, `vite.config.ts` changes.

## Packages

Added: none. Removed: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`,
`zod` (lockfile updated by `npm uninstall`).

## Tests executed (final run)

| Check | Result |
|---|---|
| `npm test` | **147 tests, 147 pass, 0 fail, 0 skipped** |
| PowerShell parse (in suite) | 7/7 scripts parse, all ASCII |
| Lifecycle (in suite) | 3/3: start/duplicate/stop/restart(-Writes), spoken restart, stale PID |
| `npm run typecheck` | pass |
| `npm run lint` (oxlint) | pass, 0 warnings, 0 errors (the earlier unused-variable warning is gone) |
| `npm run build` | pass (Vite's advisory about the large upstream Kokoro chunk remains) |
| `npm run e2e` (real Ollama) | **10 passed, 0 failed** |
| `npm run e2e:offline` | 6 passed, 0 failed (included in the 10) |

Local brain E2E: granite4:3b answered ("A CPU executes instructions that direct
a computer's operations.", ~2 s); a natural request produced an
`open_application` tool call resolved to Calculator (dry run); primary-missing
fallback answered with qwen3.5:4b. Offline E2E: time, date and app open work
with Ollama unreachable; conversation returns the unavailable line; the bridge
stays healthy; zero AI turns recorded.

Live instance (manual): old Claude-era JARVIS stopped cleanly; new build started
with `scripts\jarvis.ps1` (bridge + UI HTTP 200); duplicate start refused with
the PID file unchanged; router time/date, real Calculator launch, granite
conversation and `/diagnostics` verified; stop and start again verified. It is
left running in a minimized PowerShell window.

## Known limitations

- CPU-only inference: first answer after a cold load can take ~10 s; warm
  answers ~2-4 s.
- A 3B model sometimes over- or under-uses tools; measured 8/8 correct on the
  final prompt set, and the claim guard prevents false "opened" statements, but
  it is not perfect.
- No live web retrieval: "research" opens a search instead (WebSearchProvider
  extension point in `bridge/web.mjs`).
- Model-driven HUD panels, UI retinting, camera vision and Chrome-extension
  browsing (Claude-tool features) are not available with the local brain.
- `research_web`, lifecycle and refresh tools are router-only by design.
- Launch success means Windows accepted the launch request; whether the app then
  shows a window is not observed.

## Human validation required

1. Open <http://localhost:5173> in Chrome or Edge (real window).
2. Click INITIALISE; confirm the boot sequence plays.
3. Approve the microphone prompt.
4. Say "Hey Jarvis"; confirm he wakes.
5. Ask "What time is it?" - spoken local time.
6. Ask "What's the date?" - spoken date.
7. Say "Open Spotify" - Spotify opens.
8. Say "Open Discord" (or another installed app not in the alias table) - it opens.
9. Ask "Why is the sky blue?" - a short Granite answer is spoken.
10. Ask a long question and talk over the answer - he stops and listens.
11. Unplug/replug or switch the microphone - listening resumes (D panel shows recovery).
12. Confirm the voice is ElevenLabs (if configured and permitted) or the browser voice.
13. Quit Ollama (tray icon) - "what time is it" and "open calculator" still work;
    a question gets "My local AI brain is unavailable right now."
14. Start Ollama again - conversation resumes (first answer may be slow while granite loads).
15. Say "Open Visual Studio" - he asks which one; answer "the first one".
16. Ask him to delete a file or send an email - he cannot (no such tool) and must
    not claim he did.

## Future optional OmniRoute / cloud extension

Add a provider object with the `BrainProvider` shape (e.g. an
OpenAI-compatible or OmniRoute client) and append it to the chain in
`createBrain()` after the local models, behind an explicit opt-in setting.
Deterministic -> granite -> qwen/stronger local -> optional cloud. The router,
tools, application resolver and voice need no change. Cloud must stay an
enhancement, never required.

## Future optional stronger local model

Set `JARVIS_LOCAL_MODEL` / `JARVIS_LOCAL_FALLBACK_MODEL` to any Ollama model
with tool support; the fallback slot is the natural place for a larger model if
the machine gains a usable GPU.
