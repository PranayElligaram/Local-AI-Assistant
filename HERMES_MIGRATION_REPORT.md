# JARVIS → Hermes Agent migration report

2026-10-16 · Status: **PASS** (core migration) · physical voice checks pending (section 12)

## 1. Executive summary

JARVIS now sends conversational and agentic turns to a local Hermes Agent
gateway, and still executes every deterministic command (time, apps, URLs,
system functions) itself. The 64K-context blocker was fixed properly: an
Ollama Modelfile allocates a real 65,536-token context (Hermes' setting and the
server allocation match, verified with `ollama ps`), running on the Arc iGPU,
which turned out to be the decisive performance fix. Real end-to-end tests
pass against the live gateway: streaming answers, persistent sessions,
barge-in, outage fallback, auth failure, gateway restart recovery and rollback.
No Claude/Anthropic runtime dependency exists.

Testing against the real gateway found and fixed defects the earlier mocked
tests could not see: the toolset response shape, a 3 s abort on every stream,
a self-contradicting prompt, a dead "stop run" call, model eviction on every
JARVIS restart, and a URL-opening injection path.

## 2. Source and worktree used

- Live JARVIS: `C:\Users\prana\dev\src\Jarvis\.claude\worktrees\jarvis-rebuild`
  (verified from running process command lines: `scripts/start.mjs`,
  `bridge/server.mjs`, vite), branch `feature/jarvis-frontend-v3-core`, base
  `e982792`. All changes are uncommitted; nothing pushed.
- Recovery checkpoint: tag `pre-hermes-complete-20261016-122027`, with a
  snapshot of the earlier uncommitted patch, `.env.local` and Hermes
  `config.yaml` in `.jarvis\pre-hermes-complete-20261016-122027\`. The earlier
  backup `.jarvis\hermes-backup-20261011-031153` is untouched.

## 3. Hermes version

Hermes Agent **v0.21.6+607.gc573316 (2026.9.24)**, git install, Python 3.14.7,
OpenAI SDK 2.24.0. (An update is available; not applied.) The gateway runs as
the Scheduled Task `Hermes_Gateway`.

## 4. Model and inference backend

**`qwen3.5-4b-64k`** = `qwen3.5:4b` (Q4_K_M, 4.7B, hybrid attention/SSM, vision
and tool capable) + `num_ctx 65536`, `temperature 0.7`, `top_p 0.8`, served by
**Ollama 0.40.4** through **Vulkan on the Intel Arc iGPU**
(`OLLAMA_IGPU_ENABLE=1`). Hermes provider `custom`, `http://127.0.0.1:11434/v1`.
Inference is fully local.

Candidates, measured on this machine:

| | native ctx | 64K memory | Hermes TTFT fresh / in-session | tool & grounding behaviour | verdict |
|---|---|---|---|---|---|
| qwen3.5:4b @64K, CPU | 262K | 5.7 GB | (prefill 30-55 tok/s: 3.5K-token prompt 66-107 s) | 5/5 tool calls | too slow on CPU |
| **qwen3.5:4b @64K, iGPU** | 262K | 5.6 GB (9.2 GB process) | 1.7 s primed / 1.9 s | searches for current facts, cites results | **selected** |
| granite4:3b @64K, iGPU | 128K | 8.0 GB | 0.65 s / 0.69 s | answered "latest Node.js?" from memory with a wrong 2023 version; research off-topic | rejected: fabricates |
| qwen2.5:7b-instruct | **32K** | - | - | - | rejected: 64K would be outside its trained context |

Hermes-managed llama.cpp and external providers were not needed.

## 5. Verified context capacity

- Modelfile `num_ctx 65536` = Hermes `model.context_length 65536` =
  `model.ollama_num_ctx 65536`; `ollama ps` shows `CONTEXT 65536`; native max 262,144.
- Ollama's `/v1` API **ignores** per-request `options.num_ctx`: a request with it
  reloaded the model at 4096. Hermes sends it anyway, so without the Modelfile
  Hermes would believe 64K while being served 4K. That is why the context is
  in the Modelfile.
- `npm run diagnostics` checks this match on every run.

## 6. Final architecture

```
JARVIS desktop (unchanged): wake word, mic/VAD, STT, TTS, UI, diagnostics
  └─ bridge/assistant.mjs
       ├─ deterministic router ── JARVIS tools (time, apps, URLs, system) ── no LLM
       ├─ Hermes mode only: looser app phrasings ("get the calculator going")
       │    → open_application, only if the app is installed (catalogue-checked)
       └─ BrainChain
            ├─ HermesBrain → http://127.0.0.1:8642/v1 (Bearer key, SSE)
            │     Hermes Agent: sessions (state.db), web_search/web_extract (ddgs)
            │       └─ Ollama qwen3.5-4b-64k (iGPU, 64K)
            └─ fallback: Ollama granite4:3b → qwen3.5:4b  (JARVIS_HERMES_FALLBACK=none to disable)
```

- **Sessions.** Hermes owns conversation state. JARVIS mints a session id
  (`X-Hermes-Session-Id`, persisted in `.jarvis\hermes-session.json`) and sends
  only the system prompt plus the new user message, so history is never sent
  twice. JARVIS' short in-memory transcript is used only by the Ollama
  fallback. A session rotates after 30 idle minutes (= model keep-alive) or 24
  turns, and survives JARVIS restarts.
- **Priming.** Each new session is opened with a short background exchange
  (at startup, on the wake word if the session went stale, and after a
  session's last turn). The hybrid model can only reuse its cache from the end
  of a previous exchange, so this makes the first real question an in-session
  turn: 11.5 s → 1.7 s.

## 7. Key source changes

| File | Change |
|---|---|
| `bridge/brain/hermes.mjs` | Rewritten against the real Hermes 0.21.6 wire protocol: `{data:[…]}` toolsets with a fail-closed allowlist checked every turn; connect deadline covers headers only (the old one aborted every stream after 3 s); Hermes-owned sessions with rotation and persistence; priming (`prepare()`); `approval.request` fails closed; reasoning, status and tool-progress events never spoken; Hermes' own (already redacted) error text surfaced; backend warm-up; capability-honest system addendum built from the live tool inventory. The `/v1/runs/{id}/stop` call was removed: it returns 409 for chat completions; socket close is what interrupts a run (verified in the gateway log). |
| `bridge/brain/index.mjs` | `HERMES_PERSONA` (the Ollama `SYSTEM_PROMPT` names JARVIS tools Hermes lacks and said "no live internet access", contradicting the Hermes addendum); Hermes-mode fallbacks do not unload on exit. |
| `bridge/brain/ollama.mjs` | `unloadOnExit` option. Ollama unloads by weights: unloading the `qwen3.5:4b` fallback evicted Hermes' `qwen3.5-4b-64k` (same blob), costing 35 s on the next turn. Now 3.0 s. |
| `bridge/brain/provider.mjs` | `prepare()`; `model` event carries `supportsTools:false` for Hermes. |
| `bridge/assistant.mjs` | Claim guard: a brain without JARVIS tools can never cause a URL to open (closes the path from injected web content to the browser); it may request only an installed app. Also catches "I've got X ready" false claims. Hermes-mode soft app routing. |
| `bridge/router.mjs` | `routeSoftApp()`: catalogue-gated looser app phrasings. |
| `bridge/config.mjs` | Hermes settings: fallback, session idle/turns, priming, connect timeout, backend model, session file. |
| `bridge/server.mjs` | Warm + prime at startup; prime on wake; Hermes diagnostics (reported model, tools, session, priming); honest system-status wording. |
| `scripts/diagnostics.mjs` | Verifies Hermes auth, effective tools, loopback inference (reads non-secret `model:` keys of Hermes' config.yaml) and the Modelfile/Hermes context match. |
| `scripts/e2e.mjs` | 9 real Hermes scenarios (`npm run e2e:hermes`); Ollama scenarios pinned to Ollama. |
| `src/ui/Diagnostics.tsx` | D-panel rows: Hermes model, tools, session, priming. |
| tests | `hermes.test.mjs` rewritten (19 tests, real wire format); new assistant/router tests; `bridge.test.mjs` pinned to the default build (it had inherited the developer's `.env.local`). |
| docs | `README.md`, `.env.example`, `HERMES_MIGRATION.md` (setup runbook). |

## 8. Enabled tool permissions

- **Hermes API server: 1 of 27 toolsets: `web` (`web_search`, `web_extract`).**
  Verified via live `GET /v1/toolsets`, not inferred from the CLI's "0/27"
  (the API server's default would have been *all* tools, including terminal
  and file). Search backend: keyless DuckDuckGo (`ddgs`). `web_extract` uses
  Hermes' fetcher, with private/LAN addresses blocked by Hermes' SSRF guard.
- JARVIS refuses any turn if anything else is enabled, and treats any approval
  request as a failure.
- **Disabled on purpose:** terminal, file, code execution, browser, computer
  use, delegation, cron, messaging, and **memory**. With web reading enabled,
  a writable long-term memory would let an injected page plant instructions
  into every future session. Session continuity covers the voice use case.
- **No JARVIS MCP server.** JARVIS keeps executing all Windows actions itself.
  Hermes can only *request* an installed app (validated); it cannot open URLs,
  run commands or touch files.
- API bound to 127.0.0.1 only; missing or wrong key → HTTP 401 on every
  endpoint (tested); key only in Hermes `.env` and JARVIS `.env.local`, both
  outside git; 0 committable files contain it (scanned).

## 9. Test results

| Suite | Result |
|---|---|
| `npm test` | **363 / 363 pass** (baseline 348; +15 new) |
| `npm run typecheck`, `npm run build` | pass |
| `npm run lint` | 0 errors, 1 warning (pre-existing, `tests/routines.test.mjs`) |
| `npm run e2e` (real Ollama + real Hermes, dry-run launches) | **19 / 19 pass** |
| `npm run diagnostics` | exit 0, no blocking problems |

## 10. Real integration evidence

All against the real gateway and models (no mocks):

- A. Hermes CLI: `hermes chat -q … --oneshot` → "The capital of France is Paris."
- B. API: authenticated streaming answer (TTFT 6.1 s cold-ish); 401 without/with wrong key.
- C/D. Through the JARVIS WebSocket pipeline: `source: hermes`, streamed text frames (36-70 per answer).
- E. "What time is it?" / "Open Spotify" → `source: router`, AI turn count unchanged.
- F/G. Gateway stopped while JARVIS ran: router answered in 17 ms, conversation fell back to granite4:3b (0.93 s); with `JARVIS_HERMES_FALLBACK=none` + bad key: explicit "unavailable" and JARVIS stayed up.
- H. Barge-in: 0 frames after interrupt; gateway log "SSE client disconnected; interrupted agent task"; the next turn answered normally.
- Session memory: "my favourite colour is teal" → "What is my favourite colour?" → "Teal."
- Research: "latest stable Node.js?" → searched → "24.19.0 (LTS); Current 26.0.0, released May 5, 2026". Ordinary questions used no tools.
- J. Gateway restart: healthy after 29.5 s, Hermes answering again at 35.5 s, no JARVIS restart. JARVIS restart: bridge up 1.7-2.8 s; stop 1.3-1.7 s; Hermes' model stays loaded.
- Rollback drill: `JARVIS_BRAIN_PROVIDER=ollama` → `provider=ollama, cloudRequired=false`, granite answered; back to `hermes` → Hermes answered.

## 11. Performance (Core Ultra 9 185H, Arc iGPU, 31.4 GB RAM)

| Measure | Value |
|---|---|
| Old brain (granite4:3b direct): warm TTFT / total | 0.24 s / 1.9 s (cold 4-7 s) |
| **Hermes, in-session or primed new session: TTFT** | **1.7-2.1 s** (median); total 2.8-5.4 s |
| Hermes, unprimed new session (prompt ≈3.5K tokens) | 11.5 s |
| Hermes, cold model (load + prefill) | 23-30 s |
| Priming after model load / later sessions | 14.6-14.9 s (background) / ~1 s |
| Research turn (search + second pass) | 22-31 s |
| Generation speed (qwen3.5-4b, iGPU) | 16-22 tok/s (CPU: 9-10) |
| Prefill (iGPU / CPU) | 146-231 / 30-56 tok/s |
| Bridge startup / ready-to-answer-fast after start | 1.7-2.8 s / ~23 s |
| Memory: Hermes model runner / gateway / bridge+UI | 9.2 GB private (5.6 GB per ollama ps) / 0.27 GB / ~0.15 GB |

Bottlenecks found and fixed by measurement: CPU-only inference (→ iGPU, 4-7×
prefill), title-generation calls evicting the cache, the Ollama prompt
sent to Hermes, fresh-session prefill (→ priming), and fallback unloads evicting
Hermes' model. Hermes' own ~3K-token system prompt was not trimmed: the
removable parts are the guidance that makes the 4B model search instead of
guessing. (Superseded by 11b: measured, that guidance made it search only
3 of 8 times; it is now trimmed and grounding is enforced per turn.)

## 11b. Latency investigation (2026-10-16, afternoon)

Trigger: user benchmark showed JARVIS first words 16.83 s / total 19.97 s,
priming 38.5 s, against 3.68 s for a 20-token direct `/api/chat`.

Method: a logging proxy between Hermes and Ollama (every model call: prompt
tokens, cached tokens, reasoning, time to first token), Ollama's own duration
breakdown on replayed requests, `scripts/bench-hermes.mjs` (drives Hermes
exactly as the bridge does), and a grounding probe (8 current-fact + 4
general questions).

What the real workload is (measured):

| Finding | Value |
|---|---|
| Prompt per model call | 3,345 tokens (Hermes system prompt 12,012 chars + 2 tool schemas 1,852 chars) vs 20 in the direct test |
| Thinking | off (`reasoning_effort: none` reaches Ollama; 0 reasoning chars) |
| In-session prompt cache | 99.9 % hit (3,341 of 3,345 cached) |
| Engine floor, any request | 1.3 s prompt eval, identical at 8K and 64K context (Vulkan llama-server on Arc iGPU) |
| Cold prefill | ~150 tok/s, so 3,345 tokens = ~22 s; plus 15 s model load when unloaded (= the 38.5 s priming) |
| Hermes overhead per turn | ~0.65 s, of which `GET /v1/toolsets` (JARVIS' per-turn policy check) 0.45 s |
| Health poll | `/api/model/options` 0.9 s + 3 Ollama calls, every ~6 s while the D panel is open |
| The 16.83 s turn | a web-search turn: 2 model calls + ~5 s DuckDuckGo search; silence throughout |
| TTS (bridge `/tts`) | 0.13 s warm, 0.8 s cold; not a bottleneck except the wake greeting |
| Wake -> listening | mic shut for greeting fetch (0.13-0.8 s) + greeting audio (0.6-1.2 s) + 500 ms re-arm + recogniser start |

Fixes and results (same machine, same model, 65,536 context, 100 % GPU):

| Measure | Before | After |
|---|---|---|
| Prompt per call | 3,345 tok | **2,036 tok** (-39 %) |
| Fully cold prefill (cache miss) | ~22 s (est. at measured 150 tok/s) | **11.9 s** (measured) |
| Priming, model loaded | 2.4-7.7 s | **1.7-1.9 s** |
| Priming, model unloaded | 38.5 s (user) | **21.6 s**, and no longer happens while a JARVIS window is open (keep-warm) |
| First words, ordinary question | 2.7-4.1 s | **2.15-2.5 s** (14 runs) |
| Research turn: first sound | 13-19 s (answer) | **"Searching." at 4.1-4.2 s**; answer 10-15 s |
| Current-fact questions actually searched | 3/8 | **8/8** fresh session; 11/15 as a 4th turn in a session |
| General questions searched needlessly | 0/4 | 0/4 |
| Wake greeting fetch | 0.13-0.8 s | 0 (preloaded) |
| Re-arm after the greeting | 500 ms | 250 ms (answers keep 500 ms) |

Changes: Hermes `config.yaml` (agent.tool_use_enforcement, execution_guidance,
task_completion_guidance, parallel_tool_call_guidance, environment_probe = false;
`platform_hints.api_server` replaced; backup `config.yaml.pre-latency-20261016`).
Note these agent keys are global to this Hermes install (CLI too).
`bridge/brain/hermes.mjs`: tool-policy verdict reused for 30 s if it PASSED
(failures never reused), refreshed on every wake word and health check;
`/api/model/options` at most every 10 min; Hermes `web_search` start passed on
as a `tool` event (name only); stronger search rule plus a per-turn search
instruction appended to time-sensitive questions (end of the user turn, so the
cached prefix survives). `bridge/assistant.mjs`: forwards that event so the
UI says "Searching.". `bridge/brain/provider.mjs`: first-token metric counts
words, not tool events. `bridge/server.mjs` + config: keep_alive renewed every
`JARVIS_HERMES_KEEP_WARM_MIN` (10) min while a window is connected (verified
not to disturb the prompt cache). Browser: greetings preloaded
(`preloadPhrases`), short-line re-arm, and `wake -> listening` / `mic live`
timings in the D panel and `/diagnostics`.

Not changed, and why: the 1.3 s per-request floor and ~150 tok/s prefill are
the Vulkan runtime on this iGPU (the model is not to be replaced); Hermes'
~450-token Windows-terminal environment block has no config switch (would need
a Hermes source patch). Wake-to-listening could not be measured physically
here; read it from the D panel after "Hey Jarvis".

## 12. Remaining limitations

- **Requires physical validation (not performed):** wake word, real microphone,
  ElevenLabs/system TTS audio, spoken barge-in, window/monitor placement.
  Procedure: run `scripts\jarvis.ps1 -Open`, click INITIALISE, allow the mic, then
  say: (1) "Hey Jarvis, what time is it?" (instant, router); (2) "Hey Jarvis,
  explain the difference between a CPU and a GPU" (spoken in ~2-4 s);
  (3) during that answer press **Space** (voice barge-in is deliberately off in
  this build, `VOICE_BARGE_IN = false`, so he can't hear himself): speech stops
  at once, and the command you then say runs, with nothing from the old answer
  spoken; (4) "Hey Jarvis, open Spotify";
  (5) "Hey Jarvis, what's the latest version of Node.js?" (~25 s, searches);
  (6) press D: AI Brain shows provider hermes, Hermes tools web_extract, web_search.
- A 4B model is not a strong agent. The natural-app protocol was followed 5/8
  times in-session, so JARVIS now handles those phrasings itself; research
  answers are short summaries, sometimes without naming a source.
- Voice latency: first question after >30 min idle ≈23-30 s (model reload);
  research ≈25 s. `OLLAMA_KEEP_ALIVE` longer trades memory for this.
- Barge-in during prefill (before the first word): JARVIS stops at once, but
  Hermes notices the closed socket only at its next 10 s keepalive.
- Any other use of `qwen3.5-4b-64k` (e.g. `hermes chat`) evicts JARVIS'
  session cache; the next JARVIS turn re-reads the session (up to ~35 s).
- The bridge reports `cloudRequired: Unknown`, because Hermes' API does not
  expose its base URL; `npm run diagnostics` verifies locality from config.
- `web_extract` fetches public pages chosen by the model. An injected page can
  steer further public fetches, but cannot reach the LAN, files, commands or
  the browser.
- Test sessions created today remain in Hermes' `state.db` (harmless; ids
  `jarvis_*`/`api-*`, deletable via `DELETE /api/sessions/{id}`).

Environment changes outside the repository (all reversible): user env
`OLLAMA_IGPU_ENABLE=1`, `OLLAMA_KEEP_ALIVE=30m`; Ollama model `qwen3.5-4b-64k`;
Hermes `config.yaml` (backups: `.jarvis\pre-hermes-complete-…\hermes-config.yaml`,
`config.yaml.pre-web-20261016`); Hermes `.env` API server keys (backup
`.env.pre-jarvis-api-20261016`); `ddgs` installed via `hermes tools post-setup`.

## 13. Start and stop

```powershell
powershell -ExecutionPolicy Bypass -File scripts\jarvis.ps1 -Open   # start JARVIS (or: npm start)
npm run stop                                                         # stop JARVIS (Hermes keeps running)
npm run restart                                                      # restart JARVIS
hermes gateway restart        # start/restart Hermes (normally started at log-on)
hermes gateway status
ollama ps                     # active model, context, GPU
npm run diagnostics           # health of everything above
npm test; npm run e2e         # regression (e2e:hermes for Hermes only)
```

JARVIS does not need Claude Code; it runs from these scripts.

## 14. Rollback

Set `JARVIS_BRAIN_PROVIDER=ollama` in `.env.local` and run `npm run restart`
(drill performed, section 10). Optionally `hermes gateway stop`. Full source
rollback: the uncommitted diff can be compared with tag
`pre-hermes-complete-20261016-122027` and the snapshot in `.jarvis\`.

## 15. Recommended next steps

1. Run the physical checks in section 12.
2. Commit the working tree on this branch after review.
3. If 25 s research turns matter, try a stronger model only if it fits: for
   example a 7-8B model with ≥64K native context on the iGPU. Measure fresh/
   primed TTFT and the Node.js grounding probe before switching.
4. A JARVIS MCP server for further *read-only* tools (system status, app
   list), each with argument schemas, before any tool with side effects.
5. Re-evaluate Hermes memory only with web tools off, or with a write-review step.
