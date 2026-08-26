"""Bounded Windows-native speech recognition for one Jarvis command."""

from __future__ import annotations

import json
import math
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import sounddevice as sd


DEFAULT_RECOGNIZER_ID = "MS-2057-80-DESK"
VOICE_ACTIVITY_RMS = 0.001
VOICE_END_SILENCE_S = 0.75
VOICE_MIN_ACTIVE_BLOCKS = 2
RECOGNIZER_TIMEOUT_BUFFER_S = 5.0
WAKE_PROCESS_STOP_TIMEOUT_S = 2.0
PROCESS_KILL_WAIT_TIMEOUT_S = 0.5
WAKE_OUTPUT_POLL_S = 0.1
WAKE_READER_JOIN_TIMEOUT_S = 0.5
RECOGNIZER_PROCESS_POLL_S = 0.1


def _stop_owned_process(
    process: subprocess.Popen[str],
    *,
    graceful_timeout_s: float = WAKE_PROCESS_STOP_TIMEOUT_S,
) -> None:
    """Terminate and reap exactly one Jarvis-owned child within bounded waits."""
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=graceful_timeout_s)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=PROCESS_KILL_WAIT_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            # There is no safe broader target to kill; never wait indefinitely or
            # terminate unrelated PowerShell processes.
            return


@dataclass(frozen=True)
class SpeechRecognitionResult:
    success: bool
    text: str | None = None
    confidence: float | None = None
    reason: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class WakeWordResult:
    detected: bool
    text: str | None = None
    confidence: float | None = None
    reason: str | None = None
    error: str | None = None


class WindowsWakeWordRecognizer:
    """Persistent System.Speech recognizer constrained to one wake phrase."""

    def __init__(
        self,
        *,
        wake_phrase: str,
        min_confidence: float,
        recognizer_id: str = DEFAULT_RECOGNIZER_ID,
        powershell_path: str | None = None,
        bridge_path: Path | None = None,
    ) -> None:
        self.wake_phrase = wake_phrase.strip()
        self.min_confidence = min_confidence
        self.recognizer_id = recognizer_id
        self.powershell_path = powershell_path or shutil.which("powershell.exe")
        self.bridge_path = bridge_path or (
            Path(__file__).resolve().parent / "scripts" / "recognize_wake_word.ps1"
        )
        self._process: subprocess.Popen[str] | None = None
        self._output_queue: queue.Queue[tuple[str, str | None]] | None = None
        self._reader_thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def start(self) -> None:
        if self.running:
            raise RuntimeError("Wake-word recognizer is already running")
        if sys.platform != "win32":
            raise RuntimeError("Wake-word recognition is supported on Windows only")
        if not self.wake_phrase:
            raise RuntimeError("Wake phrase is empty")
        if not self.powershell_path:
            raise RuntimeError("Windows PowerShell was not found")
        if not self.bridge_path.is_file():
            raise RuntimeError(f"Wake-word bridge was not found: {self.bridge_path}")

        command = [
            self.powershell_path,
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(self.bridge_path),
            "-WakePhrase",
            self.wake_phrase,
            "-RecognizerId",
            self.recognizer_id,
        ]
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self._stop_event.clear()
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        self._process = process
        self._output_queue = queue.Queue()
        output_queue = self._output_queue

        def _read_output() -> None:
            try:
                if process.stdout is None:
                    output_queue.put(("error", "recognizer stdout unavailable"))
                    return
                while True:
                    line = process.stdout.readline()
                    if not line:
                        return
                    output_queue.put(("line", line))
            except (OSError, ValueError) as exc:
                if not self._stop_event.is_set():
                    output_queue.put(("error", str(exc)))
            finally:
                output_queue.put(("eof", None))

        self._reader_thread = threading.Thread(
            target=_read_output,
            daemon=True,
            name="jarvis-wake-output-reader",
        )
        self._reader_thread.start()

    def wait_for_wake(
        self,
        *,
        shutdown_event: threading.Event | None = None,
    ) -> WakeWordResult:
        process = self._process
        output_queue = self._output_queue
        if process is None or output_queue is None:
            return WakeWordResult(
                False,
                reason="recognizer_error",
                error="Wake-word recognizer is not running",
            )

        while True:
            if self._stop_event.is_set() or (
                shutdown_event is not None and shutdown_event.is_set()
            ):
                return WakeWordResult(False, reason="shutdown")
            try:
                output_kind, output = output_queue.get(timeout=WAKE_OUTPUT_POLL_S)
            except queue.Empty:
                continue
            if output_kind == "line":
                line = output or ""
                break
            if output_kind == "error":
                return WakeWordResult(
                    False,
                    reason="recognizer_error",
                    error=output or "wake-word output reader failed",
                )
            detail = "Wake-word recognizer stopped unexpectedly"
            if process.poll() is not None and process.stderr is not None:
                stderr = process.stderr.read().strip()
                if stderr:
                    detail = stderr
            return WakeWordResult(False, reason="recognizer_error", error=detail)

        try:
            payload = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            return WakeWordResult(
                False,
                reason="recognizer_error",
                error="Wake-word recognizer returned invalid output",
            )
        if payload.get("status") == "error":
            return WakeWordResult(
                False,
                reason="recognizer_error",
                error=str(payload.get("error") or "wake-word recognizer error"),
            )
        if payload.get("status") != "success":
            return WakeWordResult(False, reason="no_match")

        text = str(payload.get("text", "")).strip()
        try:
            confidence = float(payload["confidence"])
        except (KeyError, TypeError, ValueError):
            return WakeWordResult(
                False,
                reason="recognizer_error",
                error="Wake-word result did not include a valid confidence score",
            )
        if text.casefold() != self.wake_phrase.casefold():
            return WakeWordResult(False, text=text, confidence=confidence, reason="no_match")
        if confidence < self.min_confidence:
            return WakeWordResult(
                False,
                text=text,
                confidence=confidence,
                reason="low_confidence",
            )
        return WakeWordResult(True, text=text, confidence=confidence)

    def stop(self) -> None:
        self._stop_event.set()
        process = self._process
        self._process = None
        if process is None:
            return
        try:
            _stop_owned_process(process)
            reader = self._reader_thread
            if reader is not None and reader is not threading.current_thread():
                reader.join(timeout=WAKE_READER_JOIN_TIMEOUT_S)
        finally:
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
            self._reader_thread = None
            self._output_queue = None


def _rms_mono(block: np.ndarray) -> float:
    mono = np.mean(block.astype(np.float64), axis=1) if block.ndim > 1 else block
    if mono.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))


def _write_pcm16_wav(path: Path, blocks: Sequence[np.ndarray], sample_rate: int) -> None:
    audio = np.concatenate(blocks, axis=0).reshape(-1)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


class WindowsSpeechRecognizer:
    """Capture one utterance, then recognize it with Windows System.Speech."""

    def __init__(
        self,
        *,
        timeout_s: float,
        min_confidence: float,
        recognizer_id: str = DEFAULT_RECOGNIZER_ID,
        powershell_path: str | None = None,
        bridge_path: Path | None = None,
    ) -> None:
        self.timeout_s = timeout_s
        self.min_confidence = min_confidence
        self.recognizer_id = recognizer_id
        self.powershell_path = powershell_path or shutil.which("powershell.exe")
        self.bridge_path = bridge_path or (
            Path(__file__).resolve().parent / "scripts" / "recognize_command.ps1"
        )
        self._process: subprocess.Popen[str] | None = None
        self._stop_event = threading.Event()

    def stop(self) -> None:
        """Stop only this recognizer's current child process, if one exists."""
        self._stop_event.set()
        process = self._process
        self._process = None
        if process is None:
            return
        try:
            _stop_owned_process(process)
        finally:
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()

    def recognize_one_command(
        self,
        *,
        device_index: int,
        phrases: Sequence[str],
        sample_rate: int,
        blocksize: int,
    ) -> SpeechRecognitionResult:
        self._stop_event.clear()
        if not self.powershell_path:
            return SpeechRecognitionResult(
                False,
                reason="recognizer_error",
                error="Windows PowerShell was not found",
            )
        if not self.bridge_path.is_file():
            return SpeechRecognitionResult(
                False,
                reason="recognizer_error",
                error=f"Speech bridge was not found: {self.bridge_path}",
            )
        grammar = tuple(dict.fromkeys(phrase.strip() for phrase in phrases if phrase.strip()))
        if not grammar:
            return SpeechRecognitionResult(
                False,
                reason="recognizer_error",
                error="The command grammar is empty",
            )

        with tempfile.TemporaryDirectory(prefix="jarvis-stt-") as temp_dir:
            temp_path = Path(temp_dir)
            audio_path = temp_path / "command.wav"
            grammar_path = temp_path / "grammar.json"
            try:
                heard_speech = self._capture_one_utterance(
                    audio_path,
                    device_index=device_index,
                    sample_rate=sample_rate,
                    blocksize=blocksize,
                )
            except Exception as exc:
                return SpeechRecognitionResult(
                    False,
                    reason="microphone_error",
                    error=str(exc).strip() or type(exc).__name__,
                )
            if not heard_speech:
                return SpeechRecognitionResult(False, reason="timeout")

            grammar_path.write_text(
                json.dumps(grammar, ensure_ascii=False),
                encoding="utf-8",
            )
            return self._recognize_wave(audio_path, grammar_path)

    def _capture_one_utterance(
        self,
        output_path: Path,
        *,
        device_index: int,
        sample_rate: int,
        blocksize: int,
    ) -> bool:
        block_duration_s = blocksize / sample_rate
        maximum_blocks = max(1, math.ceil(self.timeout_s / block_duration_s))
        silence_blocks_to_stop = max(
            1, math.ceil(VOICE_END_SILENCE_S / block_duration_s)
        )
        blocks: list[np.ndarray] = []
        active_blocks = 0
        trailing_silence_blocks = 0

        with sd.InputStream(
            device=device_index,
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            blocksize=blocksize,
        ) as stream:
            for _ in range(maximum_blocks):
                data, _overflowed = stream.read(blocksize)
                block = np.asarray(data, dtype=np.float32).copy()
                blocks.append(block)
                if _rms_mono(block) >= VOICE_ACTIVITY_RMS:
                    active_blocks += 1
                    trailing_silence_blocks = 0
                elif active_blocks:
                    trailing_silence_blocks += 1
                    if (
                        active_blocks >= VOICE_MIN_ACTIVE_BLOCKS
                        and trailing_silence_blocks >= silence_blocks_to_stop
                    ):
                        break

        if active_blocks < VOICE_MIN_ACTIVE_BLOCKS:
            return False
        _write_pcm16_wav(output_path, blocks, sample_rate)
        return True

    def _recognize_wave(
        self,
        audio_path: Path,
        grammar_path: Path,
    ) -> SpeechRecognitionResult:
        command = [
            self.powershell_path,
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(self.bridge_path),
            "-AudioPath",
            str(audio_path),
            "-GrammarPath",
            str(grammar_path),
            "-RecognizerId",
            self.recognizer_id,
        ]
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                creationflags=creationflags,
            )
        except OSError as exc:
            return SpeechRecognitionResult(
                False,
                reason="recognizer_error",
                error=str(exc).strip() or type(exc).__name__,
            )

        self._process = process
        deadline = time.monotonic() + self.timeout_s + RECOGNIZER_TIMEOUT_BUFFER_S
        try:
            while True:
                if self._stop_event.is_set():
                    raise KeyboardInterrupt
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _stop_owned_process(process)
                    return SpeechRecognitionResult(
                        False,
                        reason="recognizer_error",
                        error="Windows speech recognition timed out",
                    )
                try:
                    stdout, stderr = process.communicate(
                        timeout=min(RECOGNIZER_PROCESS_POLL_S, remaining)
                    )
                    break
                except subprocess.TimeoutExpired:
                    continue
        except KeyboardInterrupt:
            _stop_owned_process(process)
            raise
        finally:
            if self._process is process:
                self._process = None
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()

        try:
            payload = json.loads(stdout.strip())
        except (json.JSONDecodeError, TypeError):
            detail = stderr.strip() or "invalid recognizer output"
            return SpeechRecognitionResult(
                False,
                reason="recognizer_error",
                error=detail,
            )
        if process.returncode != 0 or payload.get("status") == "error":
            detail = payload.get("error") or stderr.strip() or "recognizer error"
            return SpeechRecognitionResult(False, reason="recognizer_error", error=detail)
        if payload.get("status") != "success":
            return SpeechRecognitionResult(False, reason="no_match")

        text = str(payload.get("text", "")).strip()
        try:
            confidence = float(payload["confidence"])
        except (KeyError, TypeError, ValueError):
            return SpeechRecognitionResult(
                False,
                reason="recognizer_error",
                error="recognizer result did not include a valid confidence score",
            )
        if not text:
            return SpeechRecognitionResult(False, reason="no_match")
        if confidence < self.min_confidence:
            return SpeechRecognitionResult(
                False,
                text=text,
                confidence=confidence,
                reason="low_confidence",
            )
        return SpeechRecognitionResult(True, text=text, confidence=confidence)
