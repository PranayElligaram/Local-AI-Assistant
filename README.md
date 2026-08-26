# Jarvis desktop assistant

Windows-focused Python assistant with one-time double-clap session activation,
offline System.Speech wake recognition, deterministic spoken commands, and a
configurable desktop routine.

## Setup

Jarvis requires Python 3.10 or newer. On Windows, create and activate a
project-local virtual environment from this project directory:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

The activation step makes `python jarvis.py` use the project-local Python and
packages rather than modifying the global Python installation.

If PowerShell blocks activation, you can use the virtual environment directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe jarvis.py
```

## Environment variables

The script loads a **`.env` file** in the same folder as `jarvis.py` (via `python-dotenv`). You can also set variables in the shell.

All settings are optional. Action switches use strict, case-insensitive booleans:
`true/false`, `1/0`, `yes/no`, or `on/off`. Invalid values stop startup with a
clear configuration error.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `OPEN_SPOTIFY` / `SONG_URI` | `true` / empty | A `spotify:` URI opens Spotify Desktop through Windows; an `https://open.spotify.com/...` URL remains supported. An empty target skips only Spotify. |
| `SPOTIFY_MONITOR` / `SPOTIFY_MINIMIZE` | blank / `false` | Optionally place Spotify on a 1-based monitor, or minimize its located window after URI dispatch. Minimizing takes precedence over placement. |
| `OPEN_CLAUDE` / `CLAUDE_URL` | `true` / `https://claude.ai/new` | A `claude://` URI opens Claude Desktop. HTTP(S) retains the existing Chrome/default-browser behavior. Other URI schemes are rejected. |
| `CLAUDE_MONITOR` / `CLAUDE_MAXIMIZE` | blank / `false` | Optionally place Claude Desktop on a 1-based monitor and maximize it there. These do not affect browser mode. |
| `OPEN_NETFLIX` / `NETFLIX_MONITOR` / `NETFLIX_MAXIMIZE` | `false` / blank / `false` | Discover and launch the installed Netflix Windows app, with optional placement and maximization. No browser or Store fallback is used. |
| `FOCUS_CURSOR` / `CURSOR_FULLSCREEN` | `true` / `true` | Optional Cursor integration. Set both to `false` when Cursor is not installed. Windows fullscreen sends F11, which is a toggle. |
| `ENABLE_ELEVENLABS` | `true` | Request welcome speech. Missing credentials disable speech only. |
| `JARVIS_WELCOME_PHRASE` | `Welcome home.` | Spoken welcome text. |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | empty | Optional ElevenLabs credentials. These are never logged and belong only in `.env` or the process environment. |
| `JARVIS_INPUT_DEVICE` | empty | Optional mic index or unique device-name substring. Ambiguous names are rejected. |
| `JARVIS_SESSION_MODE` | `clap_then_voice` | One activation double clap runs desk mode, then Jarvis waits persistently for its wake phrase. `desk` retains the legacy once-per-process routine. |
| `WAKE_PHRASE` / `WAKE_WORD_MIN_CONFIDENCE` | `jarvis` / `0.80` | Single-phrase persistent System.Speech wake grammar and its acceptance threshold. |
| `VOICE_COMMAND_TIMEOUT_S` | `5` | Maximum seconds to wait for speech in one-shot command-listening mode. |
| `VOICE_MIN_CONFIDENCE` | `0.75` | Reject constrained-grammar recognition below this confidence (range `0.0`-`1.0`). |
| `OPEN_CHROME_FULLSCREEN` / `CLAUDE_CHROME_MONITOR` | `true` / `1` | Windows Chrome placement. |

Advanced optional values and defaults are listed in `.env.example`, including
the ElevenLabs model/format/cache, Chrome window size/timeout, and the disabled
legacy Binance action. Existing names `OPEN_CLAUDE_CODE_IN_CHROME`,
`CLAUDE_CODE_URL`, `FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP`, and
`JARVIS_WELCOME_ENABLED` remain accepted as compatibility aliases; the names in
`.env.example` are preferred.

Copy `.env.example` to `.env`, then set `SONG_URI` and any optional credentials.
Never commit `.env`. To enable ElevenLabs speech, the minimum is:

```env
ELEVENLABS_API_KEY=your_key_here
ELEVENLABS_VOICE_ID=your_voice_id_here
```

For the Windows desktop-app workflow, use a Spotify resource URI and
`CLAUDE_URL=claude://claude.ai/new`. Registered URI dispatch requests the
desktop apps but does not prove Spotify playback or Claude navigation completed.
Desktop monitor numbers use the same left-to-right, then top-to-bottom ordering
as the existing Chrome placement. A blank value leaves the window on the monitor
chosen by Windows. An unavailable number produces a warning without failing the
launch action. Maximization uses the Windows maximize command after restoring
and moving the window, rather than approximating maximization by resizing it.

## Run

```bash
python jarvis.py
```

Allow the microphone if Windows prompts you. Stop with **Ctrl+C**.

### Deterministic command mode

Run one registered command through the same production command router intended
for future voice input, bypassing microphone/clap waiting:

```powershell
python jarvis.py --command "open claude"
python jarvis.py --command "open netflix"
python jarvis.py --command "start my desk"
```

Supported commands are desk mode (`start my desk`, `desk mode`, `start desk
mode`), opening Claude/Netflix, showing Spotify, background Spotify playback,
closing Claude/Netflix, minimizing Spotify, and reporting the local time.
`open spotify` and `show spotify` restore and foreground the existing desktop
window without replaying the configured URI. `play spotify` and desk mode retain
the configured URI; `play spotify` always waits for URI activation to settle and
then verifies Spotify is minimized, while desk mode retains its configured final
minimization behavior. Commands are normalized for case, whitespace, and simple
punctuation, but are otherwise exact and deterministic. Unknown text never
becomes a shell command or an application launch.

Use `--dry-run` with `--command` to resolve a command without executing it:

```powershell
python jarvis.py --command "open netflix" --dry-run
```

`--command` and `--debug-audio` are mutually exclusive. Normal no-argument
execution follows `JARVIS_SESSION_MODE`.

### One-shot speech command mode

On Windows, Jarvis can record one bounded utterance from the same selected
`JARVIS_INPUT_DEVICE`, release the microphone, and transcribe the recording with
the installed **Microsoft Speech Recognizer 8.0 for Windows (English - UK)**.
Recognition is offline and constrained to the aliases exposed by the production
command router. Recognized text cannot become a shell command.

Test recognition without launching desktop applications:

```powershell
python jarvis.py --listen-command --dry-run
```

Or recognize and execute one registered command, then exit:

```powershell
python jarvis.py --listen-command
```

`--listen-command`, `--command`, and `--debug-audio` are mutually exclusive.
`--dry-run` is valid with either command mode.

With `JARVIS_SESSION_MODE=clap_then_voice`, Jarvis starts inactive. The first
double clap permanently closes the clap stream, runs the existing desk routine,
and starts a persistent System.Speech recognizer whose grammar contains only
`WAKE_PHRASE`. After that phrase is accepted, the wake process releases the
microphone, the existing one-shot command recognizer records and routes one
command, and wake recognition starts again. Timeout, no-match, low confidence,
integration failure, and command failure all return to wake-phrase listening.
The legacy `DOUBLE_CLAP_MODE=voice` value maps to `clap_then_voice`; prefer the
new setting. `JARVIS_SESSION_MODE=desk` retains the original one-shot routine.

System.Speech wake recognition uses the Windows default input device. If
`JARVIS_INPUT_DEVICE` explicitly selects a different device, Jarvis stops with a
clear configuration error instead of silently listening on the wrong microphone.

### Start Jarvis automatically at Windows login

`start_jarvis.bat` derives the repository directory from its own location, uses
`.venv\Scripts\python.exe`, and keeps the console visible. After runtime behavior
has been physically validated, install a current-user Startup shortcut once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install_startup.ps1
```

This requires no administrator rights and does not create a service or scheduled
task. Remove only the Jarvis shortcut with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall_startup.ps1
```

## Audio calibration

Run the detector without launching Spotify, Chrome, Cursor, ElevenLabs, or any
other desktop action:

```powershell
python jarvis.py --debug-audio
```

Debug mode uses the same microphone selection, RMS calculation, noise-floor
adaptation, thresholds, timing window, re-arm rule, and cooldown as normal mode.
It prints event-driven clap decisions plus an RMS summary every two seconds.

## Tests

Run the hardware-free clap detector tests with:

```powershell
python -m unittest discover -s tests -v
```

## Tuning

The physically calibrated detector values remain internal constants in
`jarvis.py`. Change them only when new measurements justify recalibration:

| Constant      | Effect                                                            |
| ------------- | ----------------------------------------------------------------- |
| `SPIKE_RATIO` | Increase if you get false triggers; decrease if claps are missed. |
| `COOLDOWN_S`  | Minimum time between two logged claps.                            |
| `BLOCK_MS`    | Larger = slightly less CPU, a bit less precise timing.            |
| `MIN_RMS`     | Floor on how loud a block must be (helps in very quiet rooms).  |
| `SAMPLE_RATE` | Try `48000` if your device does not like `44100`.                 |

The optional Binance browser action in the upstream project is disabled by
default in this baseline.

## Troubleshooting

- **Wrong microphone:** Jarvis prefers `JARVIS_INPUT_DEVICE` when configured, then the Windows/sounddevice default input. Alternatives are tried in device-list order only when the intended device cannot be opened. Use an index or unique name substring from `sounddevice.query_devices()` to force a device.
- **Quiet microphone:** A near-zero probe RMS is diagnostic only. If the stream opens and returns audio frames, Jarvis keeps that microphone rather than scanning for a louder endpoint.
- **PortAudio / audio errors:** Update audio drivers or try another `SAMPLE_RATE`.
- **No reaction to claps:** Lower `SPIKE_RATIO` slightly or speak/clap closer to the mic.
- **Spam logs:** Raise `SPIKE_RATIO` or `COOLDOWN_S`.
- **No welcome speech:** Set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `.env`, then restart Jarvis. Other actions still run when speech is unavailable.
