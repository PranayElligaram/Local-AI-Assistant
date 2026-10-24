# Hermes migration - durable state

Resume file for interrupted sessions. Git + filesystem are authoritative.
Full results: HERMES_MIGRATION_REPORT.md. Setup runbook: HERMES_MIGRATION.md.

## Where
- Live JARVIS runs from THIS worktree: `C:\Users\prana\dev\src\Jarvis\.claude\worktrees\jarvis-rebuild`
  (verified via process command lines). Started detached: `scripts\jarvis.ps1` in a minimized window.
- Branch `feature/jarvis-frontend-v3-core`, base `e982792`. All changes uncommitted. No pushes.
- Checkpoint: tag `pre-hermes-complete-20261016-122027`; snapshot of the earlier patch,
  `.env.local` and Hermes config in `.jarvis\pre-hermes-complete-20261016-122027\`.
- Earlier backup `.jarvis\hermes-backup-20261011-031153` - preserve.
- Hermes backups: `%LOCALAPPDATA%\hermes\.env.pre-jarvis-api-20261016`, `config.yaml.pre-web-20261016`.

## Current phase
COMPLETE (automatable scope), 2026-10-16. Only physical voice/audio checks remain
(report section 12).

## Configuration in force
- Ollama model `qwen3.5-4b-64k` (Modelfile copy: `.jarvis\Modelfile.qwen3.5-4b-64k`):
  num_ctx 65536, temperature 0.7, top_p 0.8. User env OLLAMA_IGPU_ENABLE=1, OLLAMA_KEEP_ALIVE=30m.
- Hermes: model.default qwen3.5-4b-64k, context_length/ollama_num_ctx 65536,
  platform_toolsets.api_server [web], web.backend ddgs, "web" removed from
  agent.disabled_toolsets, auxiliary.title_generation.model_upgrade_enabled false,
  API server 127.0.0.1:8642 (key in Hermes .env).
- Hermes latency trim (2026-10-16 pm, report 11b): agent.tool_use_enforcement/execution_guidance/
  task_completion_guidance/parallel_tool_call_guidance/environment_probe false; platform_hints.api_server
  replaced. Backup: `%LOCALAPPDATA%\hermes\config.yaml.pre-latency-20261016`. Prompt 3,345 -> 2,036 tokens.
- JARVIS: keep-warm every JARVIS_HERMES_KEEP_WARM_MIN (10) min while a window is connected.
- .env.local: JARVIS_BRAIN_PROVIDER=hermes, JARVIS_HERMES_KEY, JARVIS_HERMES_BACKEND_MODEL=qwen3.5-4b-64k.

## Verified tests (final)
- npm test 372/372 (after latency work); typecheck pass; build pass; lint 0 errors (1 pre-existing warning).
- npm run e2e 19/19 (10 Ollama + 9 Hermes, real models); npm run diagnostics exit 0.
- npm run bench:hermes: first words 2.15-2.5 s; research "Searching." at ~4.1 s (report 11b).

## Files modified
Tracked: .env.example, README.md, bridge/{assistant,config,router,server,tools}.mjs,
bridge/brain/{index,ollama,provider}.mjs, package.json, scripts/{diagnostics,e2e}.mjs,
src/ui/Diagnostics.tsx, tests/{assistant,bridge,router}.test.mjs.
Latency work also: src/App.tsx, src/lib/{tts,voice,fillers,bridge}.ts, tests/{bargein,voice-lifecycle}.test.mjs.
New: bridge/brain/hermes.mjs, tests/hermes.test.mjs, scripts/bench-hermes.mjs, HERMES_MIGRATION.md,
HERMES_MIGRATION_REPORT.md, HERMES_MIGRATION_STATE.md.

## Blockers
None. Physical validation pending (mic, wake word, TTS audio, Space barge-in, window placement).

## Next action if resuming
Run the physical checklist in HERMES_MIGRATION_REPORT.md section 12; then review and commit.
Rollback at any time: JARVIS_BRAIN_PROVIDER=ollama in .env.local, `npm run restart`.
