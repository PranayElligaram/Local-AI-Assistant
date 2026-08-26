import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import jarvis
from config import load_config
from speech import SpeechRecognitionResult, WakeWordResult, WindowsSpeechRecognizer


def shutdown_config():
    return load_config(
        {
            "JARVIS_SESSION_MODE": "clap_then_voice",
            "ENABLE_ELEVENLABS": "false",
            "OPEN_SPOTIFY": "false",
            "OPEN_CLAUDE": "false",
            "OPEN_NETFLIX": "false",
            "FOCUS_CURSOR": "false",
        }
    )


class InterruptingStream:
    def __init__(self):
        self.entered = False
        self.exited = False

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *_args):
        self.exited = True

    def read(self, _blocksize):
        raise KeyboardInterrupt


class ShutdownControlTests(unittest.TestCase):
    def test_ctrl_c_during_initial_clap_closes_stream_and_exits(self) -> None:
        stream = InterruptingStream()
        voice = Mock()
        session = Mock()
        with patch("jarvis._choose_input_device", return_value=1), patch(
            "jarvis.sd.query_devices", return_value={"name": "Test microphone"}
        ), patch("jarvis.sd.InputStream", return_value=stream), patch(
            "jarvis.VoiceWakeController", return_value=voice
        ), patch("jarvis.ActiveJarvisSession", return_value=session), self.assertLogs(
            "clap_listen", level="INFO"
        ) as captured:
            result = jarvis.main([], config=shutdown_config())

        self.assertEqual(result, 0)
        self.assertTrue(stream.exited)
        session.stop.assert_called_once_with()
        self.assertIn("Shutdown requested", "\n".join(captured.output))
        self.assertIn("Stopping Jarvis", "\n".join(captured.output))

    def test_ctrl_c_during_wake_wait_propagates_and_prevents_restart(self) -> None:
        wake = Mock()
        wake.wait_for_wake.side_effect = KeyboardInterrupt
        voice = Mock()
        session = jarvis.ActiveJarvisSession(
            shutdown_config(),
            voice_controller=voice,
            wake_recognizer=wake,
            restart_delay_s=0,
        )

        with self.assertRaises(KeyboardInterrupt):
            session.run_forever()

        wake.start.assert_called_once_with()
        wake.stop.assert_called_once_with()
        voice.run_cycle.assert_not_called()
        self.assertTrue(session._stop_event.is_set())

    def test_ctrl_c_during_command_execution_stops_recognizer_and_session(self) -> None:
        wake = Mock()
        wake.wait_for_wake.return_value = WakeWordResult(True, "Jarvis", 0.95)
        recognizer = Mock()
        recognizer.recognize_one_command.return_value = SpeechRecognitionResult(
            True, "open netflix", 0.95
        )
        router = Mock()
        router.accepted_phrases = ("open netflix",)
        router.route.side_effect = KeyboardInterrupt
        shutdown = jarvis.threading.Event()
        voice = jarvis.VoiceWakeController(
            shutdown_config(),
            input_idx=1,
            input_name="Test microphone",
            recognizer=recognizer,
            router=router,
            shutdown_event=shutdown,
        )
        session = jarvis.ActiveJarvisSession(
            shutdown_config(),
            voice_controller=voice,
            wake_recognizer=wake,
            restart_delay_s=0,
            shutdown_event=shutdown,
        )

        with patch("builtins.print"), self.assertRaises(KeyboardInterrupt):
            session.run_forever()

        recognizer.stop.assert_called_once_with()
        wake.start.assert_called_once_with()
        self.assertTrue(shutdown.is_set())

    def test_command_recording_keyboard_interrupt_closes_stream(self) -> None:
        stream = InterruptingStream()
        recognizer = WindowsSpeechRecognizer(
            timeout_s=5,
            min_confidence=0.75,
            powershell_path="powershell.exe",
            bridge_path=Path(__file__),
        )
        with patch("speech.sd.InputStream", return_value=stream):
            with self.assertRaises(KeyboardInterrupt):
                recognizer.recognize_one_command(
                    device_index=1,
                    phrases=("open netflix",),
                    sample_rate=44100,
                    blocksize=1764,
                )

        self.assertTrue(stream.exited)
        self.assertIsNone(recognizer._process)

    def test_stubborn_one_shot_child_is_killed_without_global_process_target(self) -> None:
        recognizer = WindowsSpeechRecognizer(
            timeout_s=5,
            min_confidence=0.75,
            powershell_path="powershell.exe",
            bridge_path=Path(__file__),
        )
        process = Mock()
        process.poll.return_value = None
        process.communicate.side_effect = KeyboardInterrupt
        process.wait.side_effect = [
            subprocess.TimeoutExpired("powershell.exe", 2.0),
            None,
        ]
        process.stdout = Mock()
        process.stderr = Mock()
        with patch("speech.subprocess.Popen", return_value=process), patch(
            "speech.subprocess.run"
        ) as global_process_action:
            with self.assertRaises(KeyboardInterrupt):
                recognizer._recognize_wave(Path("command.wav"), Path("grammar.json"))

        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)
        global_process_action.assert_not_called()

    def test_normal_wake_error_still_restarts_when_shutdown_not_requested(self) -> None:
        wake = Mock()
        wake.wait_for_wake.side_effect = [
            WakeWordResult(False, reason="recognizer_error", error="temporary"),
            KeyboardInterrupt,
        ]
        session = jarvis.ActiveJarvisSession(
            shutdown_config(),
            voice_controller=Mock(),
            wake_recognizer=wake,
            restart_delay_s=0,
        )

        with self.assertRaises(KeyboardInterrupt):
            session.run_forever()

        self.assertEqual(wake.start.call_count, 2)
        self.assertEqual(wake.stop.call_count, 2)


if __name__ == "__main__":
    unittest.main()
