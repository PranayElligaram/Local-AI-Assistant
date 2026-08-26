import json
import io
import queue
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np

import jarvis
from config import load_config
from speech import (
    DEFAULT_RECOGNIZER_ID,
    SpeechRecognitionResult,
    WindowsSpeechRecognizer,
    WindowsWakeWordRecognizer,
)


class FakeInputStream:
    def __init__(self, blocks):
        self._blocks = iter(blocks)
        self.exited = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.exited = True
        return None

    def read(self, _blocksize):
        return next(self._blocks), False


def recognizer(**overrides):
    options = {
        "timeout_s": 5.0,
        "min_confidence": 0.75,
        "powershell_path": "powershell.exe",
        "bridge_path": Path(__file__),
    }
    options.update(overrides)
    return WindowsSpeechRecognizer(**options)


class SpeechCaptureTests(unittest.TestCase):
    def test_successful_capture_writes_pcm_wave_after_speech_ends(self) -> None:
        blocksize = 100
        loud = np.full((blocksize, 1), 0.02, dtype=np.float32)
        quiet = np.zeros((blocksize, 1), dtype=np.float32)
        stream = FakeInputStream([loud, loud, *([quiet] * 8)])
        with tempfile.TemporaryDirectory() as directory, patch(
            "speech.sd.InputStream", return_value=stream
        ):
            output = Path(directory) / "speech.wav"
            captured = recognizer(timeout_s=1.0)._capture_one_utterance(
                output,
                device_index=4,
                sample_rate=1000,
                blocksize=blocksize,
            )

            self.assertTrue(captured)
            self.assertTrue(output.is_file())

    def test_silence_returns_structured_timeout_without_running_recognizer(self) -> None:
        blocksize = 100
        quiet = np.zeros((blocksize, 1), dtype=np.float32)
        stream = FakeInputStream([quiet] * 10)
        speech = recognizer(timeout_s=1.0)
        with patch("speech.sd.InputStream", return_value=stream), patch.object(
            speech, "_recognize_wave"
        ) as recognize_wave:
            result = speech.recognize_one_command(
                device_index=2,
                phrases=("open netflix",),
                sample_rate=1000,
                blocksize=blocksize,
            )

        self.assertFalse(result.success)
        self.assertEqual(result.reason, "timeout")
        recognize_wave.assert_not_called()

    def test_microphone_failure_is_structured(self) -> None:
        speech = recognizer()
        with patch("speech.sd.InputStream", side_effect=RuntimeError("device busy")):
            result = speech.recognize_one_command(
                device_index=2,
                phrases=("open netflix",),
                sample_rate=44100,
                blocksize=1764,
            )

        self.assertEqual(result.reason, "microphone_error")
        self.assertIn("device busy", result.error)

    def test_router_aliases_are_written_to_constrained_grammar(self) -> None:
        config = load_config({})
        phrases = jarvis.create_command_router(config).accepted_phrases
        speech = recognizer()

        def inspect_grammar(_audio_path, grammar_path):
            self.assertEqual(json.loads(grammar_path.read_text()), list(phrases))
            return SpeechRecognitionResult(True, "open netflix", 0.9)

        with patch.object(
            speech, "_capture_one_utterance", return_value=True
        ), patch.object(speech, "_recognize_wave", side_effect=inspect_grammar):
            result = speech.recognize_one_command(
                device_index=1,
                phrases=phrases,
                sample_rate=44100,
                blocksize=1764,
            )

        self.assertTrue(result.success)

    def test_speech_stream_closes_before_recognition_and_temp_files_are_removed(
        self,
    ) -> None:
        blocksize = 100
        loud = np.full((blocksize, 1), 0.02, dtype=np.float32)
        quiet = np.zeros((blocksize, 1), dtype=np.float32)
        stream = FakeInputStream([loud, loud, *([quiet] * 8)])
        speech = recognizer(timeout_s=1.0)
        temp_parent = None

        def inspect_lifecycle(audio_path, _grammar_path):
            nonlocal temp_parent
            temp_parent = audio_path.parent
            self.assertTrue(stream.exited)
            self.assertTrue(audio_path.is_file())
            return SpeechRecognitionResult(False, reason="no_match")

        with patch("speech.sd.InputStream", return_value=stream), patch.object(
            speech, "_recognize_wave", side_effect=inspect_lifecycle
        ):
            result = speech.recognize_one_command(
                device_index=2,
                phrases=("open netflix",),
                sample_rate=1000,
                blocksize=blocksize,
            )

        self.assertEqual(result.reason, "no_match")
        self.assertIsNotNone(temp_parent)
        self.assertFalse(temp_parent.exists())

    def test_temp_files_are_removed_when_recognition_is_interrupted(self) -> None:
        speech = recognizer()
        temp_parent = None

        def interrupt(audio_path, _grammar_path):
            nonlocal temp_parent
            temp_parent = audio_path.parent
            raise KeyboardInterrupt

        with patch.object(
            speech, "_capture_one_utterance", return_value=True
        ), patch.object(speech, "_recognize_wave", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                speech.recognize_one_command(
                    device_index=2,
                    phrases=("open netflix",),
                    sample_rate=44100,
                    blocksize=1764,
                )

        self.assertIsNotNone(temp_parent)
        self.assertFalse(temp_parent.exists())


class SystemSpeechBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.speech = recognizer()
        self.audio = Path("command.wav")
        self.grammar = Path("grammar.json")

    @staticmethod
    def completed_process(*, returncode=0, stdout="", stderr=""):
        process = Mock()
        process.communicate.return_value = (stdout, stderr)
        process.returncode = returncode
        process.stdout = Mock()
        process.stderr = Mock()
        return process

    def test_successful_result_includes_text_and_confidence(self) -> None:
        completed = self.completed_process(
            stdout='{"status":"success","text":"open netflix","confidence":0.91}',
            stderr="",
        )
        with patch("speech.subprocess.Popen", return_value=completed) as popen:
            result = self.speech._recognize_wave(self.audio, self.grammar)

        self.assertTrue(result.success)
        self.assertEqual(result.text, "open netflix")
        self.assertEqual(result.confidence, 0.91)
        arguments = popen.call_args.args[0]
        self.assertIsInstance(arguments, list)
        self.assertIn(DEFAULT_RECOGNIZER_ID, arguments)
        self.assertNotIn("shell", popen.call_args.kwargs)
        completed.communicate.assert_called_once()

    def test_no_match_is_structured(self) -> None:
        completed = self.completed_process(
            stdout='{"status":"no_match"}', stderr=""
        )
        with patch("speech.subprocess.Popen", return_value=completed):
            result = self.speech._recognize_wave(self.audio, self.grammar)

        self.assertEqual(result.reason, "no_match")

    def test_low_confidence_is_rejected(self) -> None:
        completed = self.completed_process(
            stdout='{"status":"success","text":"open netflix","confidence":0.4}',
            stderr="",
        )
        with patch("speech.subprocess.Popen", return_value=completed):
            result = self.speech._recognize_wave(self.audio, self.grammar)

        self.assertEqual(result.reason, "low_confidence")
        self.assertEqual(result.text, "open netflix")

    def test_recognizer_process_error_is_structured(self) -> None:
        completed = self.completed_process(
            returncode=1,
            stdout='{"status":"error","error":"recognizer unavailable"}',
            stderr="",
        )
        with patch("speech.subprocess.Popen", return_value=completed):
            result = self.speech._recognize_wave(self.audio, self.grammar)

        self.assertEqual(result.reason, "recognizer_error")
        self.assertIn("unavailable", result.error)

    def test_malformed_output_is_structured(self) -> None:
        completed = self.completed_process(stdout="not json", stderr="bad output")
        with patch("speech.subprocess.Popen", return_value=completed):
            result = self.speech._recognize_wave(self.audio, self.grammar)

        self.assertEqual(result.reason, "recognizer_error")
        self.assertEqual(result.error, "bad output")

    def test_subprocess_timeout_is_bounded_and_structured(self) -> None:
        process = self.completed_process()
        process.poll.return_value = None
        process.communicate.side_effect = subprocess.TimeoutExpired(
            "powershell.exe", 0.1
        )
        with patch("speech.subprocess.Popen", return_value=process), patch(
            "speech.time.monotonic", side_effect=[0.0, 11.0]
        ):
            result = self.speech._recognize_wave(self.audio, self.grammar)

        self.assertEqual(result.reason, "recognizer_error")
        self.assertIn("timed out", result.error)
        process.terminate.assert_called_once_with()

    def test_keyboard_interrupt_stops_exact_one_shot_child(self) -> None:
        process = self.completed_process()
        process.poll.return_value = None
        process.communicate.side_effect = KeyboardInterrupt
        with patch("speech.subprocess.Popen", return_value=process):
            with self.assertRaises(KeyboardInterrupt):
                self.speech._recognize_wave(self.audio, self.grammar)

        process.terminate.assert_called_once_with()
        process.wait.assert_called_once()
        process.kill.assert_not_called()
        self.assertIsNone(self.speech._process)


class PersistentWakeRecognizerTests(unittest.TestCase):
    def wake_recognizer(self, **overrides):
        options = {
            "wake_phrase": "jarvis",
            "min_confidence": 0.80,
            "powershell_path": "powershell.exe",
            "bridge_path": Path(__file__),
        }
        options.update(overrides)
        return WindowsWakeWordRecognizer(**options)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_start_uses_fixed_single_phrase_bridge_without_shell(self) -> None:
        process = Mock()
        process.poll.return_value = None
        process.stdout = io.StringIO("")
        process.stderr = io.StringIO("")
        with patch("speech.subprocess.Popen", return_value=process) as popen:
            wake = self.wake_recognizer()
            wake.start()
            wake.stop()

        arguments = popen.call_args.args[0]
        self.assertIn("-WakePhrase", arguments)
        phrase_index = arguments.index("-WakePhrase") + 1
        self.assertEqual(arguments[phrase_index], "jarvis")
        self.assertNotIn("shell", popen.call_args.kwargs)

    def test_successful_wake_result_includes_confidence(self) -> None:
        wake = self.wake_recognizer()
        process = Mock()
        process.stdout = io.StringIO(
            '{"status":"success","text":"Jarvis","confidence":0.93}\n'
        )
        process.stderr = io.StringIO()
        process.poll.return_value = None
        wake._process = process
        wake._output_queue = queue.Queue()
        wake._output_queue.put(
            ("line", '{"status":"success","text":"Jarvis","confidence":0.93}\n')
        )

        result = wake.wait_for_wake()

        self.assertTrue(result.detected)
        self.assertEqual(result.text, "Jarvis")
        self.assertEqual(result.confidence, 0.93)

    def test_low_confidence_wake_is_rejected(self) -> None:
        wake = self.wake_recognizer()
        process = Mock()
        process.stdout = io.StringIO(
            '{"status":"success","text":"Jarvis","confidence":0.50}\n'
        )
        process.stderr = io.StringIO()
        process.poll.return_value = None
        wake._process = process
        wake._output_queue = queue.Queue()
        wake._output_queue.put(
            ("line", '{"status":"success","text":"Jarvis","confidence":0.50}\n')
        )

        result = wake.wait_for_wake()

        self.assertFalse(result.detected)
        self.assertEqual(result.reason, "low_confidence")

    def test_stop_terminates_and_waits_for_recognizer_process(self) -> None:
        wake = self.wake_recognizer()
        process = Mock()
        process.poll.return_value = None
        process.stdout = Mock()
        process.stderr = Mock()
        wake._process = process

        wake.stop()

        process.terminate.assert_called_once_with()
        process.wait.assert_called_once()
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()
        self.assertFalse(wake.running)

    def test_stubborn_wake_child_is_killed_after_bounded_wait(self) -> None:
        wake = self.wake_recognizer()
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [
            subprocess.TimeoutExpired("powershell.exe", 2.0),
            None,
        ]
        process.stdout = Mock()
        process.stderr = Mock()
        wake._process = process

        wake.stop()

        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)

    def test_shutdown_event_ends_pollable_wait_without_recognizer_failure(self) -> None:
        wake = self.wake_recognizer()
        process = Mock()
        process.poll.return_value = None
        wake._process = process
        wake._output_queue = queue.Queue()
        shutdown = jarvis.threading.Event()
        shutdown.set()

        result = wake.wait_for_wake(shutdown_event=shutdown)

        self.assertFalse(result.detected)
        self.assertEqual(result.reason, "shutdown")


class ListenCommandCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_config(
            {
                "OPEN_NETFLIX": "true",
                "NETFLIX_MONITOR": "3",
                "ENABLE_ELEVENLABS": "false",
                "FOCUS_CURSOR": "false",
            }
        )

    def test_dry_run_routes_recognized_command_without_desktop_action(self) -> None:
        recognition = SpeechRecognitionResult(True, "open netflix", 0.93)
        recognizer_mock = Mock()
        recognizer_mock.recognize_one_command.return_value = recognition
        with patch("jarvis._choose_input_device", return_value=3), patch(
            "jarvis.sd.query_devices", return_value={"name": "Test mic"}
        ), patch(
            "jarvis.WindowsSpeechRecognizer", return_value=recognizer_mock
        ), patch("jarvis.open_netflix") as action, patch("builtins.print") as output:
            exit_code = jarvis.main(
                ["--listen-command", "--dry-run"],
                config=self.config,
            )

        self.assertEqual(exit_code, 0)
        action.assert_not_called()
        output.assert_called_once_with("Would run command: open_netflix")

    def test_known_recognition_uses_production_router(self) -> None:
        recognition = SpeechRecognitionResult(True, "open netflix", 0.93)
        recognizer_mock = Mock()
        recognizer_mock.recognize_one_command.return_value = recognition
        with patch("jarvis._choose_input_device", return_value=3), patch(
            "jarvis.sd.query_devices", return_value={"name": "Test mic"}
        ), patch(
            "jarvis.WindowsSpeechRecognizer", return_value=recognizer_mock
        ), patch("jarvis.open_netflix") as action, patch("builtins.print"):
            exit_code = jarvis.main(["--listen-command"], config=self.config)

        self.assertEqual(exit_code, 0)
        action.assert_called_once_with(self.config)

    def test_unknown_recognition_is_rejected_without_process_action(self) -> None:
        recognition = SpeechRecognitionResult(True, "order me dinner", 0.99)
        recognizer_mock = Mock()
        recognizer_mock.recognize_one_command.return_value = recognition
        with patch("jarvis._choose_input_device", return_value=3), patch(
            "jarvis.sd.query_devices", return_value={"name": "Test mic"}
        ), patch(
            "jarvis.WindowsSpeechRecognizer", return_value=recognizer_mock
        ), patch("jarvis.subprocess.Popen") as process, patch(
            "jarvis.open_netflix"
        ) as action, patch("builtins.print"):
            exit_code = jarvis.main(["--listen-command"], config=self.config)

        self.assertEqual(exit_code, 1)
        process.assert_not_called()
        action.assert_not_called()

    def test_timeout_executes_no_desktop_action(self) -> None:
        recognizer_mock = Mock()
        recognizer_mock.recognize_one_command.return_value = SpeechRecognitionResult(
            False, reason="timeout"
        )
        with patch("jarvis._choose_input_device", return_value=3), patch(
            "jarvis.sd.query_devices", return_value={"name": "Test mic"}
        ), patch(
            "jarvis.WindowsSpeechRecognizer", return_value=recognizer_mock
        ), patch("jarvis.open_netflix") as action, patch("builtins.print") as output:
            exit_code = jarvis.main(["--listen-command"], config=self.config)

        self.assertEqual(exit_code, 1)
        action.assert_not_called()
        output.assert_called_once_with("No command heard.")


if __name__ == "__main__":
    unittest.main()
