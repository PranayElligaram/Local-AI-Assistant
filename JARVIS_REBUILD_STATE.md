# JARVIS rebuild — working state

Resume notes for an interrupted/compacted session. Keep this current.

## Where the work lives
- Canonical repo: `C:\Users\prana\dev\src\Jarvis` (main @ ff5d8e9, untouched)
- Work happens in git worktree `C:\Users\prana\dev\src\Jarvis\.claude\worktrees\jarvis-rebuild`,
  branch `worktree-jarvis-rebuild`, based on ff5d8e9. No pushes, no PRs.
- Recovery: tags `pre-jarvis-rebuild-head-20260917-185654` (ff5d8e9),
  `pre-jarvis-rebuild-worktree-20260917-185654` (= stash@{0} "pre-jarvis-rebuild-working-tree-20260917-185654",
  untracked EVIE files in its ^3 parent). Never delete these.
- Upstream: https://github.com/adewaskar/jarvis @ 1c4016afdf86f7043efc6882ceffef84ad0d8783
  (temp clone: `C:\Users\prana\.claude\jobs\1544a243\tmp\upstream`)

## Environment facts
- Default `node` on PATH is v16.20.2 (Volta default). Upstream needs Node >= 20.
  Node 22.23.2 exists in Volta's image store; use `volta run --node 22.23.2 ...` or the
  project `volta` pin in package.json.
- Claude Code CLI: `C:\Users\prana\.local\bin\claude.exe`.
- Existing local `.env` in the main checkout (gitignored) holds ELEVENLABS_API_KEY and
  ELEVENLABS_VOICE_ID among old EVIE settings. Never print values.

## Phases
- [x] 1 Verify repo/env
- [x] 2-3 Inspect history + preserved EVIE state; extract requirements
- [x] 4-5 Inspect upstream, record SHA
- [x] 6-7 Remove old Python impl, import upstream (commit 22df865)
- [ ] 8 npm install
- [ ] 9 Prove unmodified upstream baseline (build/lint)
- [ ] 10-12 Configure: MCP isolation, Windows fixes, env loading, mic selection/recovery,
      ElevenLabs timeouts, diagnostics, start/stop/restart scripts, startup task
- [ ] 13 Tests (node:test + tsx)
- [ ] 14-19 Build, diagnostics, run bridge/UI, exercise, repair
- [ ] 20 JARVIS_REBUILD_REPORT.md

## Decisions
- Upstream wake is transcript-regex based ("Hey Jarvis" matched in STT output),
  Porcupine used only if VITE_PICOVOICE_ACCESS_KEY set.
- Global ~/.claude.json MCP servers must NOT be imported (upstream does); replace with
  opt-in project-local config. Don't read ~/.claude.json for ElevenLabs key either.

## Tests run
(none yet)

## Failures remaining
(none recorded yet)

## Next action
npm ci with Node 22, build, lint.
