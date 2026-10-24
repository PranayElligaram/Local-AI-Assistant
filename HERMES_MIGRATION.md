# JARVIS on Hermes Agent: setup runbook

How to (re)create the working setup from scratch on this Windows machine.
Results, measurements and limitations are in `HERMES_MIGRATION_REPORT.md`.
Verified with Hermes Agent v0.21.6+607 and Ollama 0.40.4.

## 1. Ollama: a model with a real 64K context

Hermes refuses models below 64,000 tokens. Ollama's OpenAI-compatible `/v1`
API **ignores** a per-request `options.num_ctx` (measured: the model reloads at
4096), so the context must be baked into a Modelfile:

```text
FROM qwen3.5:4b
PARAMETER num_ctx 65536
PARAMETER temperature 0.7
PARAMETER top_p 0.8
```

```powershell
ollama create qwen3.5-4b-64k -f <that Modelfile>
```

(`temperature`/`top_p` are Qwen's non-thinking settings; Hermes runs it with
reasoning off. The base model ships its thinking-mode values.)

User environment variables, then restart Ollama from its tray icon (Quit, then
start it again; force-killing `ollama.exe` orphans its `llama-server.exe`):

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_IGPU_ENABLE', '1', 'User')   # use the Arc iGPU (Vulkan)
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', '30m', 'User')  # Hermes requests reset expiry to this
```

Check: `ollama ps` shows `qwen3.5-4b-64k  ...  100% GPU  65536`.

## 2. Hermes: model, API server, tools

```powershell
hermes config set model.provider custom
hermes config set model.base_url http://127.0.0.1:11434/v1
hermes config set model.default qwen3.5-4b-64k
hermes config set model.context_length 65536
hermes config set model.ollama_num_ctx 65536
hermes config set platform_toolsets.api_server '["web"]'      # [] for no tools at all
hermes config set web.backend ddgs                             # keyless DuckDuckGo search
hermes tools post-setup ddgs                                   # installs the pinned ddgs package
hermes config set auxiliary.title_generation.model_upgrade_enabled false
```

- Remove `web` from `agent.disabled_toolsets` in `config.yaml` (that list is
  applied last and overrides the platform list). Leave everything else there.
- Title generation is switched off because its extra model call evicts the
  conversation from the model's cache (measured: fresh turns 4.9 s -> 17 s).

In `%LOCALAPPDATA%\hermes\.env` (never in the repository):

```ini
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=<a long random secret>
API_SERVER_MODEL_NAME=hermes-agent
```

```powershell
hermes gateway restart     # the gateway is the Scheduled Task Hermes_Gateway (runs at log-on)
```

Check the EFFECTIVE tools for the API server (not `hermes tools`, which shows
the CLI): `GET http://127.0.0.1:8642/v1/toolsets` with the key must list only
`web` enabled. JARVIS re-checks this before every turn and refuses otherwise.

## 3. JARVIS

In `.env.local` (git-ignored):

```ini
JARVIS_BRAIN_PROVIDER=hermes
JARVIS_HERMES_KEY=<the same secret as API_SERVER_KEY>
JARVIS_HERMES_BACKEND_MODEL=qwen3.5-4b-64k
```

```powershell
npm run diagnostics        # Hermes auth, tools, local inference, 64K match, fallback
npm test; npm run e2e:hermes
powershell -ExecutionPolicy Bypass -File scripts\restart.ps1
```

## Rollback

Set `JARVIS_BRAIN_PROVIDER=ollama` in `.env.local` and restart JARVIS. Nothing
else changes: granite4:3b / qwen3.5:4b answer as before. To also stop Hermes:
`hermes gateway stop`.
