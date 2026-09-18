# J.A.R.V.I.S.

A Windows desktop voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, answers, and does things on your PC - tells
the time, opens any installed application, opens web pages and searches, shows
his own diagnostics.

**JARVIS does not require Claude.** Everything runs on your machine: a
deterministic command router, JARVIS-owned tools, and a local language model
served by [Ollama](https://ollama.com) - `granite4:3b` as the everyday brain and
`qwen3.5:4b` as the local fallback. No cloud account, no API key, no login and no
internet connection is needed for JARVIS to work. **ElevenLabs is an optional
add-on** for a better voice; without it he speaks and listens through the
browser's own speech.

> This fork started from [adewaskar/jarvis](https://github.com/adewaskar/jarvis),
> whose brain was Claude Code run headless. That runtime dependency has been
> removed on purpose. Claude Code was used to *build* this version; it plays no
> part in running it.

---

## Requirements

- **Windows 10/11** (the primary platform; the scripts are Windows PowerShell 5.1
  compatible).
- **Node.js 20.19+ or 22.12+** - <https://nodejs.org>. `scripts\jarvis.ps1` finds a
  suitable one (PATH, Volta, nvm-for-windows, Program Files) even if the default
  `node` on PATH is older.
- **Google Chrome or Microsoft Edge**, in a **real browser window** - not an
  editor's embedded preview pane, which blocks the microphone. WebGL is required.
- **Ollama** - <https://ollama.com>, running on `http://127.0.0.1:11434`, with:

  ```powershell
  ollama pull granite4:3b
  ollama pull qwen3.5:4b
  ```

- **Optional: an ElevenLabs API key** for the ElevenLabs voice (and Scribe
  transcription, if your key has the `speech_to_text` permission).

Check everything at once:

```powershell
npm ci
npm run setup
```

`setup` checks the Node version, dependencies, that Ollama is reachable, that
both models are installed, the ElevenLabs configuration, and whether JARVIS is
running - in plain language, changing nothing.

---

## Start, stop, restart

```powershell
npm start                                                    # bridge + interface, one terminal
powershell -ExecutionPolicy Bypass -File scripts\jarvis.ps1 -Open   # same, finds Node 20+, opens Chrome/Edge
```

Open <http://localhost:5173> in Chrome or Edge, click **INITIALISE**, allow the
microphone, and say **"Hey Jarvis"**.

```powershell
npm run stop        # or: powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
npm run restart     # or: powershell -ExecutionPolicy Bypass -File scripts\restart.ps1
```

You can also say **"restart Jarvis"** (the launcher starts a fresh bridge; the
interface reconnects) or **"stop Jarvis"**.

`scripts\install-startup.ps1` / `scripts\uninstall-startup.ps1` add or remove a
log-on task.

---

## How it works

```
  browser (the face)                        bridge (the brain and hands)
  -----------------------------------      ---------------------------------------------
  "Hey Jarvis" wake word                   bridge/server.mjs  (localhost:8787 only)
  VAD -> speech to text                ws    intent router (bridge/router.mjs)
  reactor UI (Three.js + GLSL)       <---->     obvious request -> JARVIS tool, no model
  text to speech, barge-in                    local brain (bridge/brain/)
  diagnostics (D), self-test (T)                 Ollama: granite4:3b -> qwen3.5:4b
                                              tools (bridge/tools.mjs) - JARVIS executes
                                              application catalogue (bridge/apps/)
```

1. **Deterministic first.** "What time is it", "what's the date", "open
   Spotify", "search Google for X", "open example.com", "show diagnostics",
   "restart Jarvis" - each is recognised by a small parser and run directly. No
   model is called, so these work with Ollama stopped and no internet.
2. **Local brain for the rest.** Conversation and ambiguous requests go to
   `granite4:3b`, streamed so speech starts on the first finished sentence.
   Granite may choose a tool (e.g. "I need to do some sums" -> open Calculator).
   If granite fails before saying anything, `qwen3.5:4b` answers (reasoning off:
   `think: false`). Ollama `keep_alive` (30 minutes) keeps granite loaded.
3. **JARVIS owns the tools.** A model only *selects* a tool. JARVIS checks the
   tool name, the arguments against a schema, and the permission, then runs its
   own implementation. There is no shell tool and no path argument anywhere.
4. **If the local brain is down** (Ollama stopped, model missing, timeout,
   malformed reply), JARVIS says *"My local AI brain is unavailable right now."*
   and keeps running; time, date and applications still work.

### Opening applications

"Jarvis, open *anything*" works for any application Windows lists as installed.
The catalogue is built from:

- the current-user and all-users **Start Menu** shortcuts,
- registered **App Paths** (HKCU and HKLM),
- **Start apps**, including packaged/UWP apps (Calculator, Settings, Spotify
  from the Store, Terminal...),
- a few Windows built-ins as a fallback.

It is cached in `.jarvis\app-catalog.json`, refreshed daily in the background,
and rescanned once when a name is not found. Nothing scans the drive for `.exe`
files - a program in Downloads is not an installed application.

Names resolve by exact name, then aliases, then a strong word match, then a
cautious fuzzy match. "VS Code", "Code" and "Visual Studio Code" all open Visual
Studio Code; "Chrome"/"Google Chrome" and "Word"/"Microsoft Word" are
consistent. **If several apps match, JARVIS asks** ("Visual Studio Code or
Visual Studio Installer?") and you can answer "the first one". A weak fuzzy
match is only ever a suggestion, never a launch.

The model never supplies what is executed: it passes a *name*, and JARVIS
launches the catalogue entry with no arguments and no shell. Opening PowerShell
opens PowerShell; nothing can make it run a command.

Your own aliases and portable (unregistered) apps live in `jarvis.apps.json`
(git-ignored) and are only ever written by you:

```powershell
npm run app -- list [filter]                      # what JARVIS can open
npm run app -- refresh                            # rescan now
npm run app -- resolve "vs code"                  # what "open vs code" would open
npm run app -- alias ide "Visual Studio Code"     # your own alias
npm run app -- add mytool "D:\Tools\MyTool.exe"   # a portable app (absolute .exe/.lnk)
npm run app -- aliases                            # list your aliases and portable apps
npm run app -- remove mytool
```

### Web

"Search Google for X" builds a search URL and opens it - no model needed.
"Research the latest X and summarise it" needs live retrieval, which a local
model does not have; JARVIS opens the search and says he cannot read live results
yet rather than inventing them. `bridge/web.mjs` documents the
`WebSearchProvider` extension point for real retrieval later.

### Voice

- **Wake:** "Hey Jarvis", matched in the transcript (or offline with a Picovoice
  key).
- **Microphone:** device selection (`VITE_JARVIS_MIC`), permission timeout,
  recovery when the device disappears or changes, one shared open request so
  streams never overlap.
- **Speech to text:** ElevenLabs Scribe when the key is *permitted* to
  transcribe; otherwise the browser's recogniser. A 401/403 from ElevenLabs is
  remembered - JARVIS stops calling it and switches to browser recognition.
- **Text to speech:** ElevenLabs when configured and permitted, otherwise the
  browser voice; any failure falls back to the browser voice for that line.
- **Barge-in:** start talking while he speaks and he stops, drops queued speech,
  cancels the model request, and listens.

---

## Safety

Read-only by default. JARVIS answers, looks things up, opens what you explicitly
ask for, opens web pages and searches, and shows diagnostics. He does not delete
files, send messages, install or uninstall software, buy anything or change
accounts - no such tool exists. `npm run start:writes` / `npm run bridge:writes`
still select the separate writes mode, but in this build no effectful tool is
registered, and the model can never run a shell command in either mode.

The bridge listens on 127.0.0.1 only and accepts WebSocket connections only from
local dev origins. Secrets stay in `.env.local` (git-ignored), are never logged
and never sent to the page. The global `~/.claude.json` is never read or written.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **D** / "show diagnostics" | Live diagnostics panel |
| **T** | One-line audio self-test |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |

The diagnostics panel shows the measured state of the voice (wake, microphone,
STT/TTS provider, barge-in, errors), the brain (Ollama endpoint, granite and qwen
health, last model, last latency, *cloud required: No*, *Claude runtime: None*),
applications (catalogue size, last request, how it resolved, launch result),
tools (last tool, result, safe/writes mode) and the process (bridge PID, port,
run-file ownership, uptime).

---

## Configuration

Everything is optional. Put overrides in `.env.local` (see `.env.example`); a real
environment variable wins over the file.

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRAIN_PROVIDER` | `ollama` | The brain provider |
| `JARVIS_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `JARVIS_LOCAL_MODEL` | `granite4:3b` | Primary model |
| `JARVIS_LOCAL_FALLBACK_MODEL` | `qwen3.5:4b` | Fallback model |
| `JARVIS_MODEL_KEEP_ALIVE` | `30m` | How long Ollama keeps the model loaded |
| `JARVIS_OLLAMA_CONNECT_TIMEOUT_S` | `3` | Health-check timeout |
| `JARVIS_OLLAMA_RESPONSE_TIMEOUT_S` | `20` | Warm first-token / stall timeout |
| `JARVIS_OLLAMA_LOAD_TIMEOUT_S` | `60` | Timeout when the model may need loading |
| `JARVIS_MAX_RESPONSE_TOKENS` | `256` | Longest answer |
| `JARVIS_SEARCH_ENGINE` | `google` | `google`, `bing` or `duckduckgo` |
| `JARVIS_APPS_FILE` | `jarvis.apps.json` | Your aliases and portable apps |
| `JARVIS_BRIDGE_PORT` | `8787` | Bridge port |
| `JARVIS_ALLOW_WRITES` | off | Separate writes mode (prefer `npm run start:writes`) |
| `ELEVENLABS_API_KEY` | - | Optional ElevenLabs voice |
| `JARVIS_VOICE_ID` | George | ElevenLabs voice id |
| `VITE_JARVIS_MIC` | system default | Microphone: index or part of the name |
| `VITE_TTS_ENGINE` | `system` | `system` or `kokoro` |
| `VITE_USE_ELEVENLABS` | `false` | Prefer ElevenLabs voice in the browser |

---

## Testing

```powershell
npm test               # unit, integration, lifecycle, PowerShell parse, isolation
npm run typecheck
npm run lint
npm run build
npm run e2e:offline    # deterministic + offline end-to-end (no Ollama needed)
npm run e2e            # + real granite answer, tool call, qwen fallback (needs Ollama)
```

The end-to-end runs start their own bridges on spare ports with isolated run
directories and **dry-run** application launches, so they never disturb a
running JARVIS or open anything on screen. A provider error, quota message or
"unavailable" sentence never counts as an AI answer.

---

## Troubleshooting

- **He can't hear me / I can't hear him:** press **D**. Use Chrome or Edge in a
  real window and allow the microphone. Press **T** for an audio self-test.
- **"My local AI brain is unavailable right now":** start Ollama, then
  `ollama list` should show `granite4:3b` and `qwen3.5:4b`. `npm run setup` says
  which is missing.
- **"JARVIS is already running":** it is - use `npm run stop` first. A stale PID
  file from a crashed launcher is detected and replaced automatically.
- **An app won't open:** `npm run app -- resolve "<name>"`, then
  `npm run app -- refresh`, or register it with `npm run app -- add`.

---

## Credits & licence

MIT. Interface and original design from
[adewaskar/jarvis](https://github.com/adewaskar/jarvis). The boot sound and any
tracks in `public/audio/` ship with the project for the demo; clearing rights
for anything beyond that is your responsibility.
