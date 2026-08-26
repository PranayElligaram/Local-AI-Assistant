#!/usr/bin/env python3
"""
Desktop clap listener: reads the default microphone and logs when two loud transients
(a double clap) are detected within a short time window.

Run:
  python -m pip install -r requirements.txt
  python jarvis.py
  python jarvis.py --debug-audio  # detector diagnostics; never runs desktop actions

Detector constants below are physically calibrated; change only after measurement.
  SAMPLE_RATE   — usually 44100 or 48000; match your device if needed.
  BLOCK_MS      — analysis window size; smaller = snappier, noisier.
  SPIKE_RATIO   — how many times louder than the noise floor counts as a clap;
                    raise if false triggers; lower if claps are missed.
  COOLDOWN_S    — minimum seconds between double-clap logs (debounce).
  MIN_DOUBLE_GAP_S / MAX_DOUBLE_GAP_S — allowed time between the two claps.
  RETRIGGER_RATIO — audio must fall below threshold * this before another hit counts.
  NOISE_FLOOR_ALPHA — closer to 1 = slower baseline adaptation to room noise.
  MIN_RMS       — ignore spikes below this absolute level (float audio ~ [-1, 1]).
  User actions and credentials are configured in `.env`; see `.env.example`.
  With JARVIS_WELCOME_CACHE_ENABLED, audio is cached under `.cache/jarvis_welcome/`.
  The welcome sequence runs only once per process. The assistant speaks in the background so Cursor
    opens without waiting for playback to finish (restart the script to run again).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import numpy as np
import sounddevice as sd

from config import ConfigError, JarvisConfig, load_config

# --- tuning knobs -----------------------------------------------------------
SAMPLE_RATE = 44100
BLOCK_MS = 40
CHANNELS = 1

SPIKE_RATIO = 7.0
COOLDOWN_S = 0.45
MIN_DOUBLE_GAP_S = 0.05
MAX_DOUBLE_GAP_S = 0.35
RETRIGGER_RATIO = 0.55
NOISE_FLOOR_ALPHA = 0.992
MIN_RMS = 0.020
QUIET_GATE_MULT = 2.2  # update noise floor only when below floor * this
# Startup mic probe: confirm that the selected input can open and return audio frames.
INPUT_PROBE_S = 0.5
INITIAL_NOISE_FLOOR = 1e-4
DEBUG_AUDIO_SUMMARY_S = 2.0
DESKTOP_WINDOW_WAIT_S = 8.0
DESKTOP_WINDOW_POLL_S = 0.15
NETFLIX_STABLE_POLLS = 3
NETFLIX_VERIFY_TIMEOUT_S = 0.9
NETFLIX_MAXIMIZE_ATTEMPTS = 2
WINDOW_LIFECYCLE_DIAGNOSTIC_S = 3.0
WINDOW_LIFECYCLE_POLL_S = 0.2
SPOTIFY_FINAL_MINIMIZE_TIMEOUT_S = 2.0
SPOTIFY_FINAL_STABLE_POLLS = 3

# Temporary Milestone diagnostic. main() enables this only in production mode;
# direct unit-test calls and --debug-audio leave it disabled.
WINDOW_LIFECYCLE_DIAGNOSTICS_ENABLED = False

# Cursor's optional new-window mode remains an internal, disabled upstream behavior.
OPEN_NEW_CURSOR_ON_DOUBLE_CLAP = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("clap_listen")


def block_samples() -> int:
    n = int(SAMPLE_RATE * BLOCK_MS / 1000)
    return max(n, 1)


def rms_mono(block: np.ndarray) -> float:
    if block.ndim > 1:
        block = np.mean(block.astype(np.float64), axis=1)
    else:
        block = block.astype(np.float64)
    if block.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(block**2)))


class ClapEventType(Enum):
    REARMED = "rearmed"
    SPIKE = "spike"
    FIRST_CLAP = "first_clap"
    TOO_CLOSE = "too_close"
    TOO_FAR = "too_far"
    DOUBLE_CLAP = "double_clap"


@dataclass(frozen=True)
class ClapEvent:
    kind: ClapEventType
    level: float
    noise_floor: float
    threshold: float
    interval: float | None = None


@dataclass
class ClapDetector:
    """Stateful clap decisions, independent of microphone I/O."""

    noise_floor: float = INITIAL_NOISE_FLOOR
    last_double_time: float = 0.0
    first_clap_time: float | None = None
    spike_armed: bool = True

    @property
    def threshold(self) -> float:
        return max(self.noise_floor * SPIKE_RATIO, MIN_RMS)

    def process(self, level: float, now: float) -> list[ClapEvent]:
        quiet_gate = self.noise_floor * QUIET_GATE_MULT
        if level < quiet_gate:
            self.noise_floor = NOISE_FLOOR_ALPHA * self.noise_floor + (
                1.0 - NOISE_FLOOR_ALPHA
            ) * level
            self.noise_floor = max(self.noise_floor, 1e-7)

        threshold = self.threshold
        events: list[ClapEvent] = []
        retrigger_level = threshold * RETRIGGER_RATIO

        if level < retrigger_level and not self.spike_armed:
            self.spike_armed = True
            events.append(
                ClapEvent(
                    ClapEventType.REARMED,
                    level,
                    self.noise_floor,
                    threshold,
                )
            )

        if not (
            self.spike_armed
            and level >= threshold
            and (now - self.last_double_time) >= COOLDOWN_S
        ):
            return events

        self.spike_armed = False
        events.append(
            ClapEvent(ClapEventType.SPIKE, level, self.noise_floor, threshold)
        )

        if self.first_clap_time is None:
            self.first_clap_time = now
            events.append(
                ClapEvent(
                    ClapEventType.FIRST_CLAP,
                    level,
                    self.noise_floor,
                    threshold,
                )
            )
            return events

        interval = now - self.first_clap_time
        if interval < MIN_DOUBLE_GAP_S:
            events.append(
                ClapEvent(
                    ClapEventType.TOO_CLOSE,
                    level,
                    self.noise_floor,
                    threshold,
                    interval,
                )
            )
        elif interval <= MAX_DOUBLE_GAP_S:
            self.first_clap_time = None
            self.last_double_time = now
            events.append(
                ClapEvent(
                    ClapEventType.DOUBLE_CLAP,
                    level,
                    self.noise_floor,
                    threshold,
                    interval,
                )
            )
        else:
            self.first_clap_time = now
            events.append(
                ClapEvent(
                    ClapEventType.TOO_FAR,
                    level,
                    self.noise_floor,
                    threshold,
                    interval,
                )
            )

        return events


def _input_devices() -> list[tuple[int, dict]]:
    return [
        (i, dev)
        for i, dev in enumerate(sd.query_devices())
        if dev["max_input_channels"] >= 1
    ]


def _query_input_device(device: int) -> dict:
    try:
        info = sd.query_devices(device)
    except (sd.PortAudioError, ValueError) as exc:
        raise ValueError(f"Device index {device} was not found") from exc
    if info["max_input_channels"] < CHANNELS:
        raise ValueError(f"Device index {device} has no usable input channels")
    return info


def _resolve_input_device_index(spec: str) -> int:
    spec = spec.strip()
    if spec.isdigit():
        idx = int(spec)
        _query_input_device(idx)
        return idx
    needle = spec.lower()
    matches = [
        (idx, dev)
        for idx, dev in _input_devices()
        if needle in dev["name"].lower()
    ]
    if not matches:
        raise ValueError(f"No input device matches {spec!r}")
    if len(matches) > 1:
        choices = "; ".join(f"[{idx}] {dev['name']}" for idx, dev in matches[:5])
        if len(matches) > 5:
            choices += f"; and {len(matches) - 5} more"
        raise ValueError(
            f"Input device name {spec!r} is ambiguous: {choices}. Use an index or "
            "a more specific name."
        )
    return matches[0][0]


@dataclass(frozen=True)
class InputProbeResult:
    available: bool
    peak_rms: float | None = None
    error: str | None = None


def _brief_device_error(exc: BaseException) -> str:
    message = str(exc).splitlines()[0].strip() or type(exc).__name__
    return message[:240]


def _probe_input_device(device: int, blocksize: int) -> InputProbeResult:
    try:
        _query_input_device(device)
        sd.check_input_settings(
            device=device,
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
        )
        with sd.InputStream(
            device=device,
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
            blocksize=blocksize,
        ) as stream:
            peak = 0.0
            deadline = time.monotonic() + INPUT_PROBE_S
            while time.monotonic() < deadline:
                data, _ = stream.read(blocksize)
                peak = max(peak, rms_mono(data))
            return InputProbeResult(available=True, peak_rms=peak)
    except (sd.PortAudioError, ValueError, OSError) as exc:
        return InputProbeResult(available=False, error=_brief_device_error(exc))


def _log_probe_success(label: str, idx: int, name: str, peak: float | None) -> None:
    log.info("%s [%d] opened successfully: %s", label, idx, name)
    log.info("Probe RMS: %.5f", peak if peak is not None else 0.0)


def _choose_input_device(
    blocksize: int,
    *,
    configured_device: str | None = None,
    log_devices: bool = True,
) -> int:
    if log_devices:
        log.info("Audio devices:\n%s", sd.query_devices())

    override = (configured_device or "").strip()
    if override:
        try:
            idx = _resolve_input_device_index(override)
        except ValueError as e:
            log.error("Configured microphone %r is invalid: %s", override, e)
            raise SystemExit(1) from e
        name = _query_input_device(idx)["name"]
        probe = _probe_input_device(idx, blocksize)
        if not probe.available:
            log.error(
                "Configured microphone [%d] %s could not be opened: %s",
                idx,
                name,
                probe.error or "unknown device error",
            )
            raise SystemExit(1)
        _log_probe_success("Configured microphone", idx, name, probe.peak_rms)
        return idx

    default = sd.default.device[0]
    if default is not None and default >= 0:
        try:
            default_name = _query_input_device(default)["name"]
        except ValueError as exc:
            log.warning("Default microphone [%d] is invalid: %s", default, exc)
        else:
            probe = _probe_input_device(default, blocksize)
            if probe.available:
                _log_probe_success(
                    "Default microphone", default, default_name, probe.peak_rms
                )
                return default
            log.warning(
                "Default microphone [%d] %s could not be opened: %s",
                default,
                default_name,
                probe.error or "unknown device error",
            )
    else:
        log.warning("No default input device is configured.")

    log.info("Searching for another usable input device.")
    for idx, dev in _input_devices():
        if default is not None and idx == default:
            continue
        probe = _probe_input_device(idx, blocksize)
        if probe.available:
            _log_probe_success(
                "Alternative microphone", idx, dev["name"], probe.peak_rms
            )
            return idx
        log.warning(
            "Skipping input device [%d] %s: %s",
            idx,
            dev["name"],
            probe.error or "could not be opened",
        )

    log.error(
        "No usable input device could be opened at %d Hz with %d input channel(s).",
        SAMPLE_RATE,
        CHANNELS,
    )
    raise SystemExit(1)


def _jarvis_welcome_cache_path(
    config: JarvisConfig,
) -> Path:
    key = (
        f"{config.welcome_phrase}|{config.elevenlabs_voice_id}|"
        f"{config.elevenlabs_model_id}|{config.elevenlabs_output_format}"
    ).encode()
    digest = hashlib.sha256(key).hexdigest()[:24]
    return config.welcome_cache_dir / f"{digest}.wav"


def _play_pcm_wav_file(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as wf:
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
            rate = wf.getframerate()
            if ch != 1 or sw != 2:
                log.warning("Unsupported cached WAV (channels=%s, width=%s).", ch, sw)
                return False
            raw = wf.readframes(wf.getnframes())
    except (OSError, wave.Error) as e:
        log.warning("Could not read cached welcome audio: %s", e)
        return False
    if not raw:
        return False
    pcm_i16 = np.frombuffer(raw, dtype=np.int16)
    pcm_f = pcm_i16.astype(np.float32) / 32768.0
    try:
        sd.play(pcm_f, rate)
        sd.wait()
    except Exception as e:
        log.warning("Could not play cached welcome audio: %s", e)
        return False
    return True


def _save_pcm_wav_file(path: Path, pcm_bytes: bytes, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with wave.open(str(tmp), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_bytes)
        tmp.replace(path)
    except OSError:
        if tmp.is_file():
            tmp.unlink(missing_ok=True)
        raise


def _redact_error(exc: BaseException, *secrets: str) -> str:
    detail = str(exc).strip() or type(exc).__name__
    for secret in secrets:
        if secret:
            detail = detail.replace(secret, "<redacted>")
    return detail


def say_jarvis_welcome(config: JarvisConfig) -> None:
    """Generate and play the configured welcome; failures reach the action boundary."""
    if not config.elevenlabs_enabled:
        raise RuntimeError(config.elevenlabs_disabled_reason() or "not configured")

    cache_path = _jarvis_welcome_cache_path(config)
    if config.welcome_cache_enabled and cache_path.is_file():
        log.info("Playing welcome from cache: %s", cache_path)
        if _play_pcm_wav_file(cache_path):
            return
        log.warning("Cache miss after read failure; fetching from ElevenLabs.")

    try:
        from elevenlabs.client import ElevenLabs
    except ImportError as exc:
        raise RuntimeError(
            "ElevenLabs package is unavailable; install requirements.txt"
        ) from exc
    try:
        client = ElevenLabs(api_key=config.elevenlabs_api_key)
        chunks = client.text_to_speech.convert(
            voice_id=config.elevenlabs_voice_id,
            text=config.welcome_phrase,
            model_id=config.elevenlabs_model_id,
            output_format=config.elevenlabs_output_format,
        )
        raw = b"".join(chunks)
    except Exception as exc:
        detail = _redact_error(
            exc,
            config.elevenlabs_api_key,
            config.elevenlabs_voice_id,
        )
        raise RuntimeError(f"ElevenLabs TTS request failed: {detail}") from exc
    if not raw:
        raise RuntimeError("ElevenLabs returned empty audio")
    if config.welcome_cache_enabled:
        try:
            _save_pcm_wav_file(cache_path, raw, config.elevenlabs_pcm_sample_rate)
            log.info("Saved welcome audio to cache: %s", cache_path)
        except OSError as e:
            log.warning("Could not save welcome cache: %s", e)
    pcm_i16 = np.frombuffer(raw, dtype=np.int16)
    pcm_f = pcm_i16.astype(np.float32) / 32768.0
    try:
        sd.play(pcm_f, config.elevenlabs_pcm_sample_rate)
        sd.wait()
    except Exception as exc:
        raise RuntimeError(f"could not play ElevenLabs audio: {exc}") from exc


def _open_registered_uri(uri: str, *, label: str) -> None:
    """Ask the operating system to dispatch a URI to its registered handler."""
    target = uri.strip()
    if not target:
        raise ValueError(f"{label} is empty")
    try:
        if sys.platform == "win32":
            os.startfile(target)
        else:
            if not webbrowser.open(target):
                raise OSError("the operating system did not accept the URI")
    except OSError as exc:
        raise RuntimeError(f"could not open {label}: {exc}") from exc


def play_song(uri: str) -> None:
    _open_registered_uri(uri, label="SONG_URI")


@dataclass(frozen=True)
class DesktopWindow:
    hwnd: int
    process_name: str
    title: str
    area: int
    pid: int = 0
    class_name: str = ""
    rect: tuple[int, int, int, int] = (0, 0, 0, 0)
    visible: bool = False
    iconic: bool = False
    zoomed: bool = False
    owner_hwnd: int = 0


def _current_app_hwnds(
    *,
    process_names: tuple[str, ...],
    title_tokens: tuple[str, ...] = (),
    title_process_names: tuple[str, ...] = (),
    class_names: tuple[str, ...] = (),
) -> set[int]:
    if sys.platform != "win32":
        return set()
    return {
        window.hwnd
        for window in _matching_app_windows_win32(
            process_names=process_names,
            title_tokens=title_tokens,
            title_process_names=title_process_names,
            class_names=class_names,
        )
    }


def open_spotify(config: JarvisConfig) -> None:
    spotify_window_classes = ("Chrome_WidgetWin_1",)
    previous = (
        _current_app_hwnds(
            process_names=("spotify.exe",),
            class_names=spotify_window_classes,
        )
        if config.spotify_minimize or config.spotify_monitor is not None
        else set()
    )
    play_song(config.song_uri)
    log.info("Spotify URI opened.")
    if config.spotify_minimize:
        _minimize_desktop_window(
            label="Spotify",
            process_names=("spotify.exe",),
            previous_hwnds=previous,
            class_names=spotify_window_classes,
        )
        return
    _place_desktop_window(
        label="Spotify",
        monitor=config.spotify_monitor,
        process_names=("spotify.exe",),
        previous_hwnds=previous,
        class_names=spotify_window_classes,
    )


def _chrome_executable() -> str | None:
    if sys.platform == "win32":
        for base in (
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            os.environ.get("LOCALAPPDATA", ""),
        ):
            if not base:
                continue
            p = os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")
            if os.path.isfile(p):
                return p
    return shutil.which("google-chrome") or shutil.which("chrome")


def _win32_sorted_monitor_rects() -> list[tuple[int, int, int, int]]:
    """Each monitor as (left, top, right, bottom), sorted left-to-right then top-to-bottom."""
    if sys.platform != "win32":
        return []
    import ctypes
    from ctypes import wintypes

    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", wintypes.LONG),
            ("top", wintypes.LONG),
            ("right", wintypes.LONG),
            ("bottom", wintypes.LONG),
        ]

    collected: list[tuple[int, int, int, int]] = []

    @ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HMONITOR,
        wintypes.HDC,
        ctypes.POINTER(RECT),
        wintypes.LPARAM,
    )
    def _cb(_hm, _hdc, lprc, _lp):
        r = lprc.contents
        collected.append((int(r.left), int(r.top), int(r.right), int(r.bottom)))
        return True

    ctypes.windll.user32.EnumDisplayMonitors(None, None, _cb, 0)
    collected.sort(key=lambda t: (t[0], t[1]))
    return collected


def _visible_top_level_windows_win32() -> list[DesktopWindow]:
    """Visible application windows with their owning executable name."""
    if sys.platform != "win32":
        return []
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    GW_OWNER = 4
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    found: list[DesktopWindow] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd: wintypes.HWND, _lp: wintypes.LPARAM) -> bool:
        owner_hwnd = int(user32.GetWindow(hwnd, GW_OWNER) or 0)
        if owner_hwnd:
            return True
        if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        is_visible = bool(user32.IsWindowVisible(hwnd))
        is_iconic = bool(user32.IsIconic(hwnd))
        if not is_visible and not is_iconic:
            return True

        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        width = max(0, rect.right - rect.left)
        height = max(0, rect.bottom - rect.top)
        if (width < 120 or height < 80) and not is_iconic:
            return True

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        process_name = ""
        if pid.value:
            process = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value
            )
            if process:
                try:
                    path = ctypes.create_unicode_buffer(4096)
                    size = wintypes.DWORD(len(path))
                    if kernel32.QueryFullProcessImageNameW(
                        process, 0, path, ctypes.byref(size)
                    ):
                        process_name = os.path.basename(path.value).lower()
                finally:
                    kernel32.CloseHandle(process)

        title_length = user32.GetWindowTextLengthW(hwnd)
        title = ""
        if title_length:
            title_buffer = ctypes.create_unicode_buffer(title_length + 1)
            user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
            title = title_buffer.value

        class_buffer = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buffer, len(class_buffer))

        found.append(
            DesktopWindow(
                hwnd=int(hwnd),
                process_name=process_name,
                title=title,
                area=width * height,
                pid=int(pid.value),
                class_name=class_buffer.value,
                rect=(int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)),
                visible=is_visible,
                iconic=is_iconic,
                zoomed=bool(user32.IsZoomed(hwnd)),
                owner_hwnd=owner_hwnd,
            )
        )
        return True

    user32.EnumWindows(_enum, 0)
    return found


def _matching_app_windows_win32(
    *,
    process_names: tuple[str, ...],
    title_tokens: tuple[str, ...] = (),
    title_process_names: tuple[str, ...] = (),
    class_names: tuple[str, ...] = (),
) -> list[DesktopWindow]:
    processes = {name.lower() for name in process_names}
    tokens = tuple(token.lower() for token in title_tokens)
    title_processes = {name.lower() for name in title_process_names}
    classes = {name.lower() for name in class_names}
    matches = []
    for window in _visible_top_level_windows_win32():
        process_match = window.process_name in processes and (
            not classes or window.class_name.lower() in classes
        )
        title = window.title.lower()
        title_match = any(token in title for token in tokens) and (
            not title_processes or window.process_name in title_processes
        )
        if process_match or title_match:
            matches.append(window)
    return matches


def _monitor_number_for_window_win32(hwnd: int) -> int | None:
    import ctypes
    from ctypes import wintypes

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    user32 = ctypes.windll.user32
    MONITOR_DEFAULTTONEAREST = 2
    monitor_handle = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    if not monitor_handle:
        return None
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(info)
    if not user32.GetMonitorInfoW(monitor_handle, ctypes.byref(info)):
        return None
    target = (
        int(info.rcMonitor.left),
        int(info.rcMonitor.top),
        int(info.rcMonitor.right),
        int(info.rcMonitor.bottom),
    )
    try:
        return _win32_sorted_monitor_rects().index(target) + 1
    except ValueError:
        return None


def _lifecycle_candidate_windows_win32(label: str) -> list[DesktopWindow]:
    if label == "Spotify":
        return _matching_app_windows_win32(process_names=("spotify.exe",))
    if label == "Netflix":
        return _matching_app_windows_win32(
            process_names=("netflix.exe",),
            title_tokens=("netflix",),
            title_process_names=("applicationframehost.exe", "msedgewebview2.exe"),
        )
    return []


def _start_window_lifecycle_diagnostics(label: str) -> threading.Thread | None:
    if sys.platform != "win32" or not WINDOW_LIFECYCLE_DIAGNOSTICS_ENABLED:
        return None
    started = time.monotonic()

    def _worker() -> None:
        previous: dict[int, tuple] = {}
        deadline = started + WINDOW_LIFECYCLE_DIAGNOSTIC_S
        while True:
            elapsed = time.monotonic() - started
            current: dict[int, tuple] = {}
            for window in _lifecycle_candidate_windows_win32(label):
                state = (
                    window.pid,
                    window.process_name,
                    window.title,
                    window.class_name,
                    window.rect,
                    _monitor_number_for_window_win32(window.hwnd),
                    window.iconic,
                    window.zoomed,
                    window.visible,
                    window.owner_hwnd,
                )
                current[window.hwnd] = state
                if previous.get(window.hwnd) != state:
                    log.info(
                        "%s lifecycle t=%.2fs: hwnd=%d, pid=%d, process=%s, "
                        "title=%r, class=%s, rect=%s, monitor=%s, iconic=%s, "
                        "zoomed=%s, visible=%s, owner=%d",
                        label,
                        elapsed,
                        window.hwnd,
                        window.pid,
                        window.process_name or "unknown",
                        window.title,
                        window.class_name or "unknown",
                        window.rect,
                        state[5] if state[5] is not None else "unknown",
                        window.iconic,
                        window.zoomed,
                        window.visible,
                        window.owner_hwnd,
                    )
            for removed_hwnd in previous.keys() - current.keys():
                log.info(
                    "%s lifecycle t=%.2fs: hwnd=%d no longer matches",
                    label,
                    elapsed,
                    removed_hwnd,
                )
            previous = current
            if time.monotonic() >= deadline:
                return
            time.sleep(WINDOW_LIFECYCLE_POLL_S)

    thread = threading.Thread(
        target=_worker,
        daemon=True,
        name=f"jarvis-{label.lower()}-window-diagnostics",
    )
    thread.start()
    return thread


def _wait_for_app_window_win32(
    *,
    process_names: tuple[str, ...],
    title_tokens: tuple[str, ...] = (),
    title_process_names: tuple[str, ...] = (),
    class_names: tuple[str, ...] = (),
    previous_hwnds: set[int] | None = None,
    timeout: float = DESKTOP_WINDOW_WAIT_S,
) -> int | None:
    if sys.platform != "win32":
        return None
    previous = previous_hwnds or set()
    deadline = time.monotonic() + timeout
    while True:
        matches = _matching_app_windows_win32(
            process_names=process_names,
            title_tokens=title_tokens,
            title_process_names=title_process_names,
            class_names=class_names,
        )
        if matches:
            return max(
                matches,
                key=lambda window: (window.hwnd not in previous, window.area),
            ).hwnd
        if time.monotonic() >= deadline:
            return None
        time.sleep(DESKTOP_WINDOW_POLL_S)


def _monitor_rect_for_placement(
    monitor: int,
    *,
    label: str,
) -> tuple[int, int, int, int] | None:
    rects = _win32_sorted_monitor_rects()
    if monitor > len(rects):
        log.warning(
            "%s monitor %d is unavailable; leaving window on current monitor "
            "(%d monitor(s) detected).",
            label,
            monitor,
            len(rects),
        )
        return None
    return rects[monitor - 1]


def _window_rect_win32(hwnd: int) -> tuple[int, int, int, int] | None:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))


def _window_is_maximized_win32(hwnd: int) -> bool:
    import ctypes

    return bool(ctypes.windll.user32.IsZoomed(hwnd))


def _window_is_minimized_win32(hwnd: int) -> bool:
    import ctypes

    return bool(ctypes.windll.user32.IsIconic(hwnd))


def _show_window_win32(hwnd: int, command: int) -> None:
    import ctypes

    ctypes.windll.user32.ShowWindow(hwnd, command)


def _set_window_position_win32(
    hwnd: int,
    *,
    x: int,
    y: int,
    width: int,
    height: int,
) -> bool:
    import ctypes

    SWP_NOACTIVATE = 0x0010
    SWP_NOZORDER = 0x0004
    SWP_SHOWWINDOW = 0x0040
    return bool(
        ctypes.windll.user32.SetWindowPos(
            hwnd,
            0,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
        )
    )


def _maximize_window_win32(hwnd: int, *, label: str) -> bool:
    SW_MAXIMIZE = 3
    _show_window_win32(hwnd, SW_MAXIMIZE)
    if not _window_is_maximized_win32(hwnd):
        log.warning("%s window could not be maximized.", label)
        return False
    log.info("%s maximized.", label)
    return True


def _minimize_window_win32(hwnd: int, *, label: str) -> bool:
    SW_MINIMIZE = 6
    _show_window_win32(hwnd, SW_MINIMIZE)
    if not _window_is_minimized_win32(hwnd):
        log.warning("%s window could not be minimized.", label)
        return False
    log.info("%s minimized.", label)
    return True


def _move_window_to_monitor_win32(
    hwnd: int,
    monitor: int,
    *,
    label: str,
    maximize: bool = False,
) -> bool:
    target = _monitor_rect_for_placement(monitor, label=label)
    if target is None:
        return False
    rect = _window_rect_win32(hwnd)
    if rect is None:
        log.warning("%s window bounds could not be read for monitor placement.", label)
        return False

    left, top, right, bottom = target
    monitor_width = max(320, right - left)
    monitor_height = max(240, bottom - top)
    window_left, window_top, window_right, window_bottom = rect
    width = min(max(320, window_right - window_left), monitor_width)
    height = min(max(240, window_bottom - window_top), monitor_height)
    x = left + max(0, (monitor_width - width) // 2)
    y = top + max(0, (monitor_height - height) // 2)
    was_maximized = _window_is_maximized_win32(hwnd)
    was_minimized = _window_is_minimized_win32(hwnd)
    SW_RESTORE = 9
    if was_maximized or was_minimized:
        _show_window_win32(hwnd, SW_RESTORE)
    moved = _set_window_position_win32(
        hwnd,
        x=x,
        y=y,
        width=width,
        height=height,
    )
    if not moved:
        log.warning("%s window could not be moved to monitor %d.", label, monitor)
        return False
    log.info("%s moved to monitor %d.", label, monitor)
    if maximize or was_maximized:
        return _maximize_window_win32(hwnd, label=label)
    return True


def _place_desktop_window(
    *,
    label: str,
    monitor: int | None,
    process_names: tuple[str, ...],
    title_tokens: tuple[str, ...] = (),
    title_process_names: tuple[str, ...] = (),
    class_names: tuple[str, ...] = (),
    previous_hwnds: set[int] | None = None,
    maximize: bool = False,
) -> bool:
    if sys.platform != "win32" or (monitor is None and not maximize):
        return False
    valid_monitor = monitor
    if monitor is not None and _monitor_rect_for_placement(monitor, label=label) is None:
        valid_monitor = None
        if not maximize:
            return False
    hwnd = _wait_for_app_window_win32(
        process_names=process_names,
        title_tokens=title_tokens,
        title_process_names=title_process_names,
        class_names=class_names,
        previous_hwnds=previous_hwnds,
    )
    if hwnd is None:
        log.warning("%s window was not located for monitor placement.", label)
        return False
    if valid_monitor is None:
        return _maximize_window_win32(hwnd, label=label)
    return _move_window_to_monitor_win32(
        hwnd,
        valid_monitor,
        label=label,
        maximize=maximize,
    )


def _minimize_desktop_window(
    *,
    label: str,
    process_names: tuple[str, ...],
    previous_hwnds: set[int] | None = None,
    class_names: tuple[str, ...] = (),
) -> bool:
    if sys.platform != "win32":
        return False
    hwnd = _wait_for_app_window_win32(
        process_names=process_names,
        previous_hwnds=previous_hwnds,
        class_names=class_names,
    )
    if hwnd is None:
        log.warning("%s window was not located for minimization.", label)
        return False
    return _minimize_window_win32(hwnd, label=label)


def _spotify_main_windows_win32() -> list[DesktopWindow]:
    return _matching_app_windows_win32(
        process_names=("spotify.exe",),
        class_names=("Chrome_WidgetWin_1",),
    )


def _enforce_spotify_minimized_final(
    *,
    timeout: float = SPOTIFY_FINAL_MINIMIZE_TIMEOUT_S,
    poll_s: float = WINDOW_LIFECYCLE_POLL_S,
    stable_polls: int = SPOTIFY_FINAL_STABLE_POLLS,
) -> bool:
    """Boundedly enforce the final state without redispatching Spotify's URI."""
    if sys.platform != "win32":
        return False
    max_polls = max(stable_polls, int(timeout / poll_s) + 1)
    verified_polls = 0
    saw_frame = False
    for poll_number in range(max_polls):
        frames = _spotify_main_windows_win32()
        if not frames:
            verified_polls = 0
        else:
            saw_frame = True
            non_iconic = [
                window
                for window in frames
                if not _window_is_minimized_win32(window.hwnd)
            ]
            if non_iconic:
                verified_polls = 0
                for window in non_iconic:
                    log.info(
                        "Spotify final minimize requested: hwnd=%d, pid=%d, "
                        "class=%s",
                        window.hwnd,
                        window.pid,
                        window.class_name or "unknown",
                    )
                    _show_window_win32(window.hwnd, 6)  # SW_MINIMIZE
            else:
                verified_polls += 1
                if verified_polls >= stable_polls:
                    hwnds = ", ".join(str(window.hwnd) for window in frames)
                    log.info(
                        "Spotify final minimize verified: hwnd(s)=%s, "
                        "stable_polls=%d",
                        hwnds,
                        verified_polls,
                    )
                    return True
        if poll_number + 1 < max_polls:
            time.sleep(poll_s)

    if saw_frame:
        log.warning("Spotify could not be kept minimized.")
    else:
        log.warning("Spotify main window was not located for final minimization.")
    return False


def _chrome_monitor_top_left(one_based_index: int) -> tuple[int, int]:
    """Top-left corner on virtual desktop for monitor N (1-based)."""
    l, t, _, _ = _chrome_monitor_bounds(one_based_index)
    return (l, t)


def _chrome_monitor_bounds(one_based_index: int) -> tuple[int, int, int, int]:
    """Monitor N as (left, top, right, bottom), 1-based index (sorted like other Chrome helpers)."""
    rects = _win32_sorted_monitor_rects()
    if not rects:
        return (0, 0, 1920, 1080)
    idx = one_based_index - 1
    if idx < 0:
        idx = 0
    if idx >= len(rects):
        log.warning(
            "Monitor %d requested but only %d found; using last monitor.",
            one_based_index,
            len(rects),
        )
        idx = len(rects) - 1
    return rects[idx]


def _chrome_monitor_pixel_size(one_based_index: int) -> tuple[int, int]:
    l, t, r, b = _chrome_monitor_bounds(one_based_index)
    return (max(320, r - l), max(240, b - t))


def _chrome_window_size(config: JarvisConfig) -> tuple[int, int]:
    return (config.chrome_window_width, config.chrome_window_height)


def _chrome_site_user_data_dir(site_key: str) -> str:
    p = Path(tempfile.gettempdir()) / "clap-trigger-chrome" / site_key
    p.mkdir(parents=True, exist_ok=True)
    return str(p)


def _chrome_top_level_browser_hwnds_win32() -> set[int]:
    """HWND ints for visible-or-minimized top-level Chrome browser windows."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    GW_OWNER = 4
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    found: set[int] = set()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd: wintypes.HWND, _lp: wintypes.LPARAM) -> bool:
        if user32.GetWindow(hwnd, GW_OWNER):
            return True
        if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        if not user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return True
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not hproc:
            return True
        try:
            buf = ctypes.create_unicode_buffer(4096)
            sz = wintypes.DWORD(len(buf))
            if not kernel32.QueryFullProcessImageNameW(hproc, 0, buf, ctypes.byref(sz)):
                return True
            exe_path = buf.value
        finally:
            kernel32.CloseHandle(hproc)
        if os.path.basename(exe_path).lower() != "chrome.exe":
            return True
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 80 or h < 80:
            return True
        found.add(int(hwnd))
        return True

    user32.EnumWindows(_enum, 0)
    return found


def _wait_new_chrome_hwnd_win32(before: set[int], timeout: float) -> int | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.12)
        now = _chrome_top_level_browser_hwnds_win32()
        new = now - before
        if not new:
            continue
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        best: int | None = None
        best_area = 0
        for h in new:
            r = wintypes.RECT()
            if user32.GetWindowRect(h, ctypes.byref(r)):
                a = max(0, r.right - r.left) * max(0, r.bottom - r.top)
                if a > best_area:
                    best_area = a
                    best = h
        if best is not None:
            return best
    return None


def _chrome_snap_window_to_monitor_win32(
    hwnd: int,
    one_based_monitor: int,
    *,
    fullscreen: bool,
    windowed_size: tuple[int, int] | None,
) -> None:
    import ctypes
    from ctypes import wintypes

    ml, mt, mr, mb = _chrome_monitor_bounds(one_based_monitor)
    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    SW_SHOWMAXIMIZED = 3
    HWND_TOP = 0
    SWP_SHOWWINDOW = 0x0040
    SWP_FRAMECHANGED = 0x0020
    flags = SWP_SHOWWINDOW | SWP_FRAMECHANGED

    user32.ShowWindow(hwnd, SW_RESTORE)
    if fullscreen:
        w, h = mr - ml, mb - mt
        x, y = ml, mt
    else:
        ww, wh = windowed_size or (1400, 900)
        w, h = ww, wh
        x = ml + max(0, (mr - ml - w) // 2)
        y = mt + max(0, (mb - mt - h) // 2)
    user32.SetWindowPos(hwnd, HWND_TOP, x, y, w, h, flags)

    if fullscreen:
        user32.ShowWindow(hwnd, SW_SHOWMAXIMIZED)
        KEYEVENTF_KEYUP = 0x0002
        VK_F11 = 0x7A
        fg = user32.GetForegroundWindow()
        tid_tgt = user32.GetWindowThreadProcessId(hwnd, None)
        tid_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        if tid_fg and tid_tgt:
            user32.AttachThreadInput(tid_fg, tid_tgt, True)
        user32.SetForegroundWindow(hwnd)
        if tid_fg and tid_tgt:
            user32.AttachThreadInput(tid_fg, tid_tgt, False)
        user32.keybd_event(VK_F11, 0, 0, 0)
        user32.keybd_event(VK_F11, 0, KEYEVENTF_KEYUP, 0)


def _open_url_in_chrome(
    url: str,
    *,
    new_window: bool = True,
    label: str = "URL",
    window_position: tuple[int, int] | None = None,
    window_size: tuple[int, int] | None = None,
    fullscreen: bool = False,
    win32_post_fullscreen_monitor: int | None = None,
    user_data_dir: str | None = None,
    new_window_wait_s: float = 25.0,
) -> None:
    u = url.strip()
    if not u:
        raise ValueError(f"{label} URL is empty")
    chrome = _chrome_executable()
    try:
        if chrome:
            args = [chrome]
            if user_data_dir:
                args.append(f"--user-data-dir={user_data_dir}")
                args.append("--no-first-run")
            if new_window:
                args.append("--new-window")
            if window_position is not None:
                x, y = window_position
                args.append(f"--window-position={x},{y}")
            if window_size:
                args.append(f"--window-size={window_size[0]},{window_size[1]}")
            if fullscreen and not (
                sys.platform == "win32" and win32_post_fullscreen_monitor is not None
            ):
                args.append("--start-fullscreen")
            args.append(u)
            popen_kw: dict = {
                "args": args,
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            if sys.platform == "win32":
                popen_kw["creationflags"] = subprocess.CREATE_NO_WINDOW
            before: set[int] | None = None
            if sys.platform == "win32" and win32_post_fullscreen_monitor is not None:
                before = _chrome_top_level_browser_hwnds_win32()
            subprocess.Popen(**popen_kw)
            if sys.platform == "win32" and win32_post_fullscreen_monitor is not None:
                mon = win32_post_fullscreen_monitor
                hwnd = _wait_new_chrome_hwnd_win32(before, new_window_wait_s)
                if hwnd is not None:
                    _chrome_snap_window_to_monitor_win32(
                        hwnd,
                        mon,
                        fullscreen=fullscreen,
                        windowed_size=window_size if not fullscreen else None,
                    )
                else:
                    log.warning(
                        "Chrome: timed out waiting for new window (%s); check "
                        "CHROME_NEW_WINDOW_WAIT_S or close extra Chrome instances.",
                        label,
                    )
        else:
            log.info("Chrome not found; requesting %s in the default browser.", label)
            if not webbrowser.open(u):
                raise OSError("the default browser did not accept the URL")
    except OSError as exc:
        raise RuntimeError(f"could not open {label}: {exc}") from exc


def open_claude_in_chrome(config: JarvisConfig) -> None:
    pos: tuple[int, int] | None = None
    size: tuple[int, int] | None = None
    fs = config.open_chrome_fullscreen
    post_mon: int | None = None
    user_data: str | None = None
    if sys.platform == "win32":
        post_mon = config.claude_chrome_monitor
        pos = _chrome_monitor_top_left(config.claude_chrome_monitor)
        if fs:
            size = _chrome_monitor_pixel_size(config.claude_chrome_monitor)
        else:
            size = _chrome_window_size(config)
        if config.chrome_separate_site_profiles:
            user_data = _chrome_site_user_data_dir("claude")
    elif not fs:
        size = _chrome_window_size(config)
    else:
        size = None
    _open_url_in_chrome(
        config.claude_url,
        new_window=True,
        label="Claude",
        window_position=pos,
        window_size=size,
        fullscreen=fs,
        win32_post_fullscreen_monitor=post_mon,
        user_data_dir=user_data,
        new_window_wait_s=config.chrome_new_window_wait_s,
    )


def open_claude(config: JarvisConfig) -> None:
    if config.claude_scheme == "claude":
        previous = (
            _current_app_hwnds(process_names=("claude.exe",))
            if config.claude_monitor is not None or config.claude_maximize
            else set()
        )
        _open_registered_uri(config.claude_url, label="Claude Desktop URI")
        log.info("Claude Desktop URI opened.")
        _place_desktop_window(
            label="Claude",
            monitor=config.claude_monitor,
            process_names=("claude.exe",),
            previous_hwnds=previous,
            maximize=config.claude_maximize,
        )
        return
    open_claude_in_chrome(config)


def _discover_netflix_aumid() -> str:
    """Find Netflix in the current user's installed Start-app catalog."""
    if sys.platform != "win32":
        raise RuntimeError("Netflix packaged-app discovery is supported on Windows only")
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        raise RuntimeError("Windows PowerShell was not found for Netflix discovery")
    command = (
        "Get-StartApps -Name '*Netflix*' | "
        "Select-Object Name,AppID | ConvertTo-Json -Compress"
    )
    run_kwargs: dict = {
        "args": [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ],
        "capture_output": True,
        "text": True,
        "timeout": 10.0,
    }
    if sys.platform == "win32":
        run_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        completed = subprocess.run(**run_kwargs)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"Netflix app discovery failed: {exc}") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        reason = detail[0] if detail else f"PowerShell exit code {completed.returncode}"
        raise RuntimeError(f"Netflix app discovery failed: {reason}")

    raw = completed.stdout.strip().lstrip("\ufeff")
    if not raw:
        raise FileNotFoundError("installed Netflix app was not found")
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Netflix app discovery returned invalid data") from exc
    entries = decoded if isinstance(decoded, list) else [decoded]
    candidates = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("AppID"), str)
        and entry["AppID"].strip()
    ]
    if not candidates:
        raise FileNotFoundError("installed Netflix app was not found")
    exact = [
        entry
        for entry in candidates
        if str(entry.get("Name", "")).strip().casefold() == "netflix"
    ]
    selected = exact if exact else candidates
    if len(selected) != 1:
        names = ", ".join(str(entry.get("Name", "Netflix")) for entry in selected)
        raise RuntimeError(f"multiple installed Netflix apps matched: {names}")
    return selected[0]["AppID"].strip()


def _is_netflix_window(window: DesktopWindow) -> bool:
    """Return whether a top-level window has strong Netflix app evidence."""
    process = window.process_name.lower()
    class_name = window.class_name.lower()
    title_identifies_netflix = "netflix" in window.title.casefold()
    if not window.visible or window.owner_hwnd:
        return False
    if process == "netflix.exe":
        return True
    if not title_identifies_netflix:
        return False
    if (
        process == "applicationframehost.exe"
        and class_name == "applicationframewindow"
    ):
        return True
    if (
        process == "msedgewebview2.exe"
        and class_name.startswith("chrome_widgetwin_")
    ):
        return True
    return process == "msedge.exe" and class_name == "chrome_widgetwin_1"


def _netflix_windows_win32() -> list[DesktopWindow]:
    return [
        window
        for window in _visible_top_level_windows_win32()
        if _is_netflix_window(window)
    ]


def _current_netflix_hwnds_win32() -> set[int]:
    return {window.hwnd for window in _netflix_windows_win32()}


def _netflix_window_rank(window: DesktopWindow) -> tuple[int, int]:
    """Prefer the strongest controllable Netflix frame, then the largest."""
    process = window.process_name.lower()
    class_name = window.class_name.lower()
    if process == "netflix.exe":
        frame_rank = 4
    elif (
        process == "applicationframehost.exe"
        and class_name == "applicationframewindow"
    ):
        frame_rank = 3
    elif process == "msedge.exe" and class_name == "chrome_widgetwin_1":
        frame_rank = 2
    else:
        frame_rank = 1
    return (
        frame_rank,
        window.area,
    )


def _best_netflix_window_win32(
    *, previous_hwnds: set[int] | None = None
) -> DesktopWindow | None:
    matches = _netflix_windows_win32()
    if not matches:
        return None
    previous = previous_hwnds or set()
    return max(
        matches,
        key=lambda window: (
            window.hwnd not in previous,
            _netflix_window_rank(window),
        ),
    )


def _wait_for_stable_netflix_window_win32(
    *,
    previous_hwnds: set[int] | None = None,
    timeout: float = DESKTOP_WINDOW_WAIT_S,
    stable_polls: int = NETFLIX_STABLE_POLLS,
) -> DesktopWindow | None:
    deadline = time.monotonic() + timeout
    last_hwnd: int | None = None
    unchanged = 0
    while True:
        candidate = _best_netflix_window_win32(previous_hwnds=previous_hwnds)
        if candidate is not None:
            if candidate.hwnd == last_hwnd:
                unchanged += 1
            else:
                last_hwnd = candidate.hwnd
                unchanged = 1
            if unchanged >= stable_polls:
                return candidate
        else:
            last_hwnd = None
            unchanged = 0
        if time.monotonic() >= deadline:
            return None
        time.sleep(DESKTOP_WINDOW_POLL_S)


def _log_netflix_window(window: DesktopWindow) -> None:
    monitor = _monitor_number_for_window_win32(window.hwnd)
    log.info(
        "Netflix window found: hwnd=%d, title=%r, process=%s, pid=%d, class=%s, "
        "rect=%s, monitor=%s, visible=%s, iconic=%s, zoomed=%s, owner=%d",
        window.hwnd,
        window.title,
        window.process_name or "unknown",
        window.pid,
        window.class_name or "unknown",
        window.rect,
        monitor if monitor is not None else "unknown",
        window.visible,
        window.iconic,
        window.zoomed,
        window.owner_hwnd,
    )


def _request_netflix_placement_and_maximize(
    window: DesktopWindow,
    *,
    monitor: int | None,
) -> None:
    SW_RESTORE = 9
    SW_MAXIMIZE = 3
    if _window_is_maximized_win32(window.hwnd) or _window_is_minimized_win32(
        window.hwnd
    ):
        _show_window_win32(window.hwnd, SW_RESTORE)
    if monitor is not None:
        current_monitor = _monitor_number_for_window_win32(window.hwnd)
        if current_monitor == monitor:
            log.info("Netflix already on monitor %d.", monitor)
        else:
            _move_window_to_monitor_win32(
                window.hwnd,
                monitor,
                label="Netflix",
                maximize=False,
            )
    log.info("Netflix maximize requested: hwnd=%d", window.hwnd)
    _show_window_win32(window.hwnd, SW_MAXIMIZE)


def _verify_netflix_maximized_win32(
    hwnd: int,
    *,
    monitor: int | None = None,
    timeout: float = NETFLIX_VERIFY_TIMEOUT_S,
) -> tuple[bool, DesktopWindow | None]:
    deadline = time.monotonic() + timeout
    verified_polls = 0
    latest: DesktopWindow | None = None
    while True:
        matches = _netflix_windows_win32()
        latest = next((window for window in matches if window.hwnd == hwnd), None)
        if latest is None and matches:
            latest = max(matches, key=_netflix_window_rank)
        if latest is not None and latest.hwnd != hwnd:
            log.info(
                "Netflix window changed after maximize: old_hwnd=%d, new_hwnd=%d",
                hwnd,
                latest.hwnd,
            )
            return False, latest
        monitor_matches = (
            monitor is None
            or _monitor_number_for_window_win32(hwnd) == monitor
        )
        if (
            latest is not None
            and monitor_matches
            and _window_is_maximized_win32(hwnd)
        ):
            verified_polls += 1
            if verified_polls >= NETFLIX_STABLE_POLLS:
                return True, latest
        else:
            verified_polls = 0
        if time.monotonic() >= deadline:
            return False, latest
        time.sleep(DESKTOP_WINDOW_POLL_S)


def _place_and_verify_netflix_window(
    *,
    monitor: int | None,
    previous_hwnds: set[int] | None,
) -> bool:
    window = _wait_for_stable_netflix_window_win32(previous_hwnds=previous_hwnds)
    if window is None:
        log.warning("Netflix window was not located for monitor placement.")
        return False

    for attempt in range(1, NETFLIX_MAXIMIZE_ATTEMPTS + 1):
        _log_netflix_window(window)
        _request_netflix_placement_and_maximize(window, monitor=monitor)
        verified, replacement = _verify_netflix_maximized_win32(
            window.hwnd,
            monitor=monitor,
        )
        if verified:
            log.info(
                "Netflix maximize verified: hwnd=%d, monitor=%s",
                window.hwnd,
                monitor if monitor is not None else "current",
            )
            return True
        if attempt >= NETFLIX_MAXIMIZE_ATTEMPTS:
            break
        log.warning(
            "Netflix maximize was not stable; reacquiring the final window "
            "and retrying (%d/%d).",
            attempt + 1,
            NETFLIX_MAXIMIZE_ATTEMPTS,
        )
        window = _wait_for_stable_netflix_window_win32(
            timeout=NETFLIX_VERIFY_TIMEOUT_S,
            stable_polls=NETFLIX_STABLE_POLLS,
        ) or replacement or window

    log.warning("Netflix maximize could not be verified.")
    return False


def open_netflix(config: JarvisConfig) -> None:
    aumid = _discover_netflix_aumid()
    previous = (
        _current_netflix_hwnds_win32()
        if config.netflix_monitor is not None or config.netflix_maximize
        else set()
    )
    explorer = shutil.which("explorer.exe") or shutil.which("explorer")
    if not explorer:
        raise RuntimeError("Windows Explorer was not found for Netflix launch")
    try:
        subprocess.Popen(
            [explorer, f"shell:AppsFolder\\{aumid}"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        raise RuntimeError(f"could not launch the installed Netflix app: {exc}") from exc
    log.info("Netflix launch requested.")
    if config.netflix_maximize:
        _place_and_verify_netflix_window(
            monitor=config.netflix_monitor,
            previous_hwnds=previous,
        )
        return
    if config.netflix_monitor is None:
        return
    window = _wait_for_stable_netflix_window_win32(previous_hwnds=previous)
    if window is None:
        log.warning("Netflix window was not located for monitor placement.")
        return
    _log_netflix_window(window)
    current_monitor = _monitor_number_for_window_win32(window.hwnd)
    if current_monitor == config.netflix_monitor:
        log.info("Netflix already on monitor %d.", config.netflix_monitor)
        return
    _move_window_to_monitor_win32(
        window.hwnd,
        config.netflix_monitor,
        label="Netflix",
        maximize=False,
    )


def open_binance_btc_in_chrome(config: JarvisConfig) -> None:
    pos: tuple[int, int] | None = None
    size: tuple[int, int] | None = None
    fs = config.open_chrome_fullscreen
    post_mon: int | None = None
    user_data: str | None = None
    if sys.platform == "win32":
        post_mon = config.binance_monitor
        pos = _chrome_monitor_top_left(config.binance_monitor)
        if fs:
            size = _chrome_monitor_pixel_size(config.binance_monitor)
        else:
            size = _chrome_window_size(config)
        if config.chrome_separate_site_profiles:
            user_data = _chrome_site_user_data_dir("binance")
    elif not fs:
        size = _chrome_window_size(config)
    else:
        size = None
    _open_url_in_chrome(
        config.binance_url,
        new_window=True,
        label="Binance BTC",
        window_position=pos,
        window_size=size,
        fullscreen=fs,
        win32_post_fullscreen_monitor=post_mon,
        user_data_dir=user_data,
        new_window_wait_s=config.chrome_new_window_wait_s,
    )


def _cursor_executable() -> str | None:
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        for sub in ("Programs\\cursor\\Cursor.exe", "Programs\\Cursor\\Cursor.exe"):
            if local:
                p = os.path.join(local, *sub.split("\\"))
                if os.path.isfile(p):
                    return p
    return shutil.which("cursor")


def _cursor_largest_main_hwnd_win32() -> int | None:
    """Largest top-level Cursor.exe window (visible or minimized)."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    GW_OWNER = 4
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    candidates: list[tuple[int, wintypes.HWND]] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd: wintypes.HWND, _lp: wintypes.LPARAM) -> bool:
        if user32.GetWindow(hwnd, GW_OWNER):
            return True
        if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        if not user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return True
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not hproc:
            return True
        try:
            buf = ctypes.create_unicode_buffer(4096)
            sz = wintypes.DWORD(len(buf))
            if not kernel32.QueryFullProcessImageNameW(hproc, 0, buf, ctypes.byref(sz)):
                return True
            exe_path = buf.value
        finally:
            kernel32.CloseHandle(hproc)
        if os.path.basename(exe_path).lower() != "cursor.exe":
            return True
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 200 or h < 200:
            return True
        candidates.append((w * h, hwnd))
        return True

    user32.EnumWindows(_enum, 0)
    if not candidates:
        return None
    return int(max(candidates, key=lambda t: t[0])[1])


def _cursor_foreground_hwnd_win32(hwnd: int) -> None:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    user32.ShowWindow(hwnd, SW_RESTORE)
    fg = user32.GetForegroundWindow()
    tid_tgt = user32.GetWindowThreadProcessId(hwnd, None)
    tid_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    if tid_fg and tid_tgt:
        user32.AttachThreadInput(tid_fg, tid_tgt, True)
    user32.SetForegroundWindow(hwnd)
    if tid_fg and tid_tgt:
        user32.AttachThreadInput(tid_fg, tid_tgt, False)


def _cursor_send_f11_fullscreen_win32(hwnd: int) -> None:
    """F11 toggles Zen/fullscreen in Cursor (Electron)."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    KEYEVENTF_KEYUP = 0x0002
    VK_F11 = 0x7A
    _cursor_foreground_hwnd_win32(hwnd)
    user32.keybd_event(VK_F11, 0, 0, 0)
    user32.keybd_event(VK_F11, 0, KEYEVENTF_KEYUP, 0)


def _focus_existing_cursor_window_win32() -> bool:
    """Bring an existing Cursor.exe main window to the foreground (no new process)."""
    if sys.platform != "win32":
        return False
    hwnd = _cursor_largest_main_hwnd_win32()
    if hwnd is None:
        return False
    _cursor_foreground_hwnd_win32(hwnd)
    return True


@dataclass(frozen=True)
class ActionResult:
    name: str
    succeeded: bool
    error: str | None = None


def run_action(
    name: str,
    function: Callable[[], None],
    *,
    success_message: str = "completed",
) -> ActionResult:
    """Run one desktop integration without allowing it to stop later actions."""
    log.info("Starting %s action.", name)
    try:
        function()
    except Exception as exc:
        detail = str(exc).strip() or type(exc).__name__
        log.warning("%s action failed: %s", name, detail)
        return ActionResult(name=name, succeeded=False, error=detail)
    log.info("%s action %s.", name, success_message)
    return ActionResult(name=name, succeeded=True)


def _run_speech_action(config: JarvisConfig) -> None:
    run_action("ElevenLabs speech", lambda: say_jarvis_welcome(config))


def _schedule_speech_action(config: JarvisConfig) -> None:
    if config.after_song_delay_s:
        time.sleep(config.after_song_delay_s)
    threading.Thread(
        target=_run_speech_action,
        args=(config,),
        daemon=True,
        name="jarvis-elevenlabs",
    ).start()


def run_double_clap_actions(config: JarvisConfig) -> list[ActionResult]:
    """Run outside the mic loop so sleeps and integrations do not stall capture."""
    log.info("Running startup sequence.")
    results: list[ActionResult] = []

    if config.open_spotify:
        if config.song_uri:
            _start_window_lifecycle_diagnostics("Spotify")
            results.append(
                run_action(
                    "Spotify",
                    lambda: open_spotify(config),
                    success_message="completed",
                )
            )
        else:
            log.warning("Spotify action disabled: SONG_URI is not configured.")

    if config.open_claude:
        desktop_mode = config.claude_scheme == "claude"
        results.append(
            run_action(
                "Claude Desktop" if desktop_mode else "Claude",
                lambda: open_claude(config),
                success_message="completed",
            )
        )

    if config.open_netflix:
        results.append(
            run_action(
                "Netflix",
                lambda: open_netflix(config),
                success_message="completed",
            )
        )

    if config.open_binance:
        results.append(
            run_action("Binance", lambda: open_binance_btc_in_chrome(config))
        )

    speech_scheduled = False
    if config.elevenlabs_enabled:
        scheduling = run_action(
            "ElevenLabs speech scheduling",
            lambda: _schedule_speech_action(config),
            success_message="completed",
        )
        if scheduling.succeeded:
            speech_scheduled = True
            log.info("ElevenLabs speech action scheduled asynchronously.")
        else:
            results.append(scheduling)

    if config.focus_cursor:
        results.append(run_action("Cursor", lambda: open_cursor_window(config)))

    if config.spotify_enabled and config.spotify_minimize:
        log.info("Enforcing final desktop state: Spotify minimized.")
        try:
            _enforce_spotify_minimized_final()
        except Exception as exc:
            detail = str(exc).strip() or type(exc).__name__
            log.warning("Spotify final minimization failed: %s", detail)

    succeeded = sum(result.succeeded for result in results)
    failed = len(results) - succeeded
    suffix = ", 1 asynchronous speech action scheduled" if speech_scheduled else ""
    log.info(
        "Startup sequence complete: %d succeeded, %d failed%s.",
        succeeded,
        failed,
        suffix,
    )
    return results


def open_cursor_window(config: JarvisConfig) -> None:
    exe = _cursor_executable()
    if not exe:
        raise FileNotFoundError(
            "Cursor was not found; install it or add the `cursor` command to PATH"
        )
    popen_kw: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        popen_kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        focused = sys.platform == "win32" and _focus_existing_cursor_window_win32()
        if not focused:
            subprocess.Popen([exe], **popen_kw)
        if OPEN_NEW_CURSOR_ON_DOUBLE_CLAP:
            subprocess.Popen([exe, "-n"], **popen_kw)
    except OSError as exc:
        raise RuntimeError(f"could not start or focus Cursor: {exc}") from exc
    if sys.platform == "win32" and config.cursor_fullscreen:
        time.sleep(0.5)
        hwnd = _cursor_largest_main_hwnd_win32()
        if hwnd is not None:
            log.info("Sending F11 to Cursor (F11 is a fullscreen toggle).")
            _cursor_send_f11_fullscreen_win32(hwnd)
        else:
            raise RuntimeError("Cursor fullscreen requested, but no window was found")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Jarvis desktop clap listener")
    parser.add_argument(
        "--debug-audio",
        action="store_true",
        help="log clap diagnostics without running desktop actions",
    )
    return parser.parse_args(argv)


def _log_debug_events(events: list[ClapEvent]) -> None:
    for event in events:
        if event.kind is ClapEventType.REARMED:
            log.info(
                "Signal re-armed: rms=%.5f, rearm_below=%.5f",
                event.level,
                event.threshold * RETRIGGER_RATIO,
            )
        elif event.kind is ClapEventType.SPIKE:
            log.info(
                "Spike detected: rms=%.5f, noise_floor=%.5f, threshold=%.5f",
                event.level,
                event.noise_floor,
                event.threshold,
            )
        elif event.kind is ClapEventType.FIRST_CLAP:
            log.info("First clap detected; waiting for second spike.")
        elif event.kind is ClapEventType.TOO_CLOSE:
            log.info(
                "Second spike rejected (too close): interval=%.3fs, minimum=%.3fs",
                event.interval,
                MIN_DOUBLE_GAP_S,
            )
        elif event.kind is ClapEventType.TOO_FAR:
            log.info(
                "Second spike rejected (too slow): interval=%.3fs, maximum=%.3fs; "
                "using this spike as a new first clap.",
                event.interval,
                MAX_DOUBLE_GAP_S,
            )
        elif event.kind is ClapEventType.DOUBLE_CLAP:
            log.info(
                "Double clap detected: interval=%.3fs (debug mode: no actions run).",
                event.interval,
            )


def _log_configuration(config: JarvisConfig) -> None:
    """Log the effective feature plan without exposing credential values."""
    log.info("Jarvis configuration:")
    if config.spotify_enabled:
        if config.spotify_minimize:
            placement = "minimize after URI dispatch"
        else:
            placement = (
                f"monitor {config.spotify_monitor}"
                if config.spotify_monitor is not None
                else "default monitor"
            )
        log.info("  Spotify: enabled (URI configured, %s)", placement)
    elif config.open_spotify:
        log.warning("  Spotify: disabled because SONG_URI is not configured")
    else:
        log.info("  Spotify: disabled")

    if config.open_claude:
        mode = "desktop URI" if config.claude_scheme == "claude" else "browser"
        if config.claude_scheme == "claude" and config.claude_monitor is not None:
            mode += f", monitor {config.claude_monitor}"
        if config.claude_scheme == "claude" and config.claude_maximize:
            mode += ", maximize"
        log.info("  Claude: enabled (%s)", mode)
    else:
        log.info("  Claude: disabled")
    if config.open_netflix:
        placement = (
            f"monitor {config.netflix_monitor}"
            if config.netflix_monitor is not None
            else "default monitor"
        )
        if config.netflix_maximize:
            placement += ", maximize"
        log.info("  Netflix: enabled (%s)", placement)
    else:
        log.info("  Netflix: disabled")
    log.info(
        "  Cursor focus: %s", "enabled" if config.focus_cursor else "disabled"
    )
    if config.focus_cursor and config.cursor_fullscreen and sys.platform == "win32":
        log.info("  Cursor fullscreen: enabled (F11 toggle)")

    if config.elevenlabs_enabled:
        log.info("  ElevenLabs: enabled (credentials configured)")
    else:
        log.warning(
            "  ElevenLabs: disabled (%s)",
            config.elevenlabs_disabled_reason() or "not configured",
        )

    log.info(
        "  Microphone override: %s",
        "configured" if config.input_device else "not configured",
    )
    if config.open_binance:
        log.info("  Legacy Binance action: enabled")


def _log_normal_mode_configuration(config: JarvisConfig) -> None:
    _log_configuration(config)
    if config.focus_cursor:
        log.info(
            "Double clap will foreground an existing Cursor window (Windows API); "
            "falls back to launching Cursor if none is running."
        )
    if OPEN_NEW_CURSOR_ON_DOUBLE_CLAP:
        log.info("Double clap will also open a new Cursor window (-n).")
    if config.open_claude:
        if config.claude_scheme == "claude":
            log.info("Open Claude Desktop through its registered Windows URI handler.")
        else:
            log.info(
                "Open Claude in Chrome%s on monitor %d: %s",
                " fullscreen" if config.open_chrome_fullscreen else "",
                config.claude_chrome_monitor,
                config.claude_url,
            )
    if config.open_binance:
        log.info(
            "Open Binance BTC in Chrome%s on monitor %d: %s",
            " fullscreen" if config.open_chrome_fullscreen else "",
            config.binance_monitor,
            config.binance_url,
        )
    if config.elevenlabs_enabled:
        log.info(
            "Welcome voice ready (delay=%.2fs, model=%s, format=%s, pcm_rate=%d).",
            config.after_song_delay_s,
            config.elevenlabs_model_id,
            config.elevenlabs_output_format,
            config.elevenlabs_pcm_sample_rate,
        )


def main(
    argv: list[str] | None = None,
    *,
    config: JarvisConfig | None = None,
) -> int:
    global WINDOW_LIFECYCLE_DIAGNOSTICS_ENABLED
    args = _parse_args(argv)
    debug_audio = args.debug_audio
    WINDOW_LIFECYCLE_DIAGNOSTICS_ENABLED = not debug_audio
    if config is None:
        try:
            config = load_config()
        except ConfigError as exc:
            log.error("Configuration error: %s", exc)
            return 2
    blocksize = block_samples()
    detector = ClapDetector()
    welcome_sequence_done = False

    if debug_audio:
        log.info("Audio debug mode enabled: all desktop actions are disabled.")
        log.info(
            "Detector settings: sample_rate=%d Hz, block=%d ms (%d samples), "
            "initial_noise_floor=%.5f, spike_ratio=%.2f, absolute_threshold=%.5f",
            SAMPLE_RATE,
            BLOCK_MS,
            blocksize,
            detector.noise_floor,
            SPIKE_RATIO,
            MIN_RMS,
        )
        log.info(
            "Double-clap window: %.2f-%.2fs; re-arm below threshold x %.2f; "
            "post-detection cooldown=%.2fs.",
            MIN_DOUBLE_GAP_S,
            MAX_DOUBLE_GAP_S,
            RETRIGGER_RATIO,
            COOLDOWN_S,
        )
    else:
        log.info(
            "Listening (double clap: %.2f–%.2fs apart, rate=%d, block=%d ms, "
            "spike_ratio=%.1f, cooldown=%.2fs). Ctrl+C to stop.",
            MIN_DOUBLE_GAP_S,
            MAX_DOUBLE_GAP_S,
            SAMPLE_RATE,
            BLOCK_MS,
            SPIKE_RATIO,
            COOLDOWN_S,
        )
        _log_normal_mode_configuration(config)

    input_idx = _choose_input_device(
        blocksize,
        configured_device=config.input_device,
        log_devices=not debug_audio,
    )
    if debug_audio:
        input_name = sd.query_devices(input_idx)["name"]
        log.info("Input device [%d]: %s", input_idx, input_name)
        log.info("Ready for calibration test. Ctrl+C to stop.")

    try:
        with sd.InputStream(
            device=input_idx,
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
            blocksize=blocksize,
        ) as stream:
            summary_started = time.monotonic()
            summary_count = 0
            summary_total = 0.0
            summary_min = float("inf")
            summary_max = 0.0

            while True:
                data, overflowed = stream.read(blocksize)
                if overflowed:
                    log.warning("Input overflow; try a larger BLOCK_MS")

                level = rms_mono(data)
                now = time.monotonic()
                events = detector.process(level, now)

                if debug_audio:
                    _log_debug_events(events)
                    summary_count += 1
                    summary_total += level
                    summary_min = min(summary_min, level)
                    summary_max = max(summary_max, level)
                    elapsed = now - summary_started
                    if elapsed >= DEBUG_AUDIO_SUMMARY_S:
                        log.info(
                            "Audio RMS summary (%.1fs): mean=%.5f, min=%.5f, "
                            "max=%.5f, noise_floor=%.5f, threshold=%.5f",
                            elapsed,
                            summary_total / summary_count,
                            summary_min,
                            summary_max,
                            detector.noise_floor,
                            detector.threshold,
                        )
                        summary_started = now
                        summary_count = 0
                        summary_total = 0.0
                        summary_min = float("inf")
                        summary_max = 0.0
                    continue

                for event in events:
                    if (
                        event.kind is ClapEventType.DOUBLE_CLAP
                        and not welcome_sequence_done
                    ):
                        welcome_sequence_done = True
                        log.info(
                            "Double clap detected (gap=%.3fs, rms=%.5f, "
                            "noise_floor=%.5f, threshold=%.5f) — running welcome once",
                            event.interval,
                            event.level,
                            event.noise_floor,
                            event.threshold,
                        )
                        threading.Thread(
                            target=run_double_clap_actions,
                            args=(config,),
                            daemon=True,
                            name="jarvis-startup-sequence",
                        ).start()

    except KeyboardInterrupt:
        log.info("Stopped.")
        return 0
    except sd.PortAudioError as e:
        log.error("Audio error: %s", e)
        log.error("If PortAudio fails, install/repair drivers or try another SAMPLE_RATE.")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
