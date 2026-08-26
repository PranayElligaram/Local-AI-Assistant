import unittest
from unittest.mock import Mock, patch

import numpy as np

import jarvis
from commands import CommandResult
from config import load_config
from speech import SpeechRecognitionResult, WakeWordResult


def voice_config():
    return load_config(
        {
            "DOUBLE_CLAP_MODE": "voice",
            "ENABLE_ELEVENLABS": "false",
            "OPEN_SPOTIFY": "true",
            "SONG_URI": "spotify:track:test",
            "OPEN_CLAUDE": "true",
            "CLAUDE_URL": "claude://claude.ai/new",
            "OPEN_NETFLIX": "true",
            "NETFLIX_MONITOR": "3",
            "FOCUS_CURSOR": "false",
        }
    )


class TrackedClapStream:
    def __init__(self, levels, *, lifecycle=None):
        self.levels = iter(levels)
        self.entered = False
        self.exited = False
        self.lifecycle = lifecycle

    def __enter__(self):
        self.entered = True
        if self.lifecycle is not None:
            self.lifecycle.append("clap_open")
        return self

    def __exit__(self, *_args):
        self.exited = True
        if self.lifecycle is not None:
            self.lifecycle.append("clap_closed")

    def read(self, blocksize):
        try:
            level = next(self.levels)
        except StopIteration as exc:
            raise KeyboardInterrupt from exc
        return np.full((blocksize, 1), level, dtype=np.float32), False


class FakeWakeRecognizer:
    def __init__(self, results, *, lifecycle=None):
        self.results = iter(results)
        self.lifecycle = lifecycle
        self.start_count = 0
        self.stop_count = 0

    def start(self):
        self.start_count += 1
        if self.lifecycle is not None:
            self.lifecycle.append("wake_start")

    def wait_for_wake(self, *, shutdown_event=None):
        if self.lifecycle is not None:
            self.lifecycle.append("wake_wait")
        if shutdown_event is not None and shutdown_event.is_set():
            return WakeWordResult(False, reason="shutdown")
        return next(self.results)

    def stop(self):
        self.stop_count += 1
        if self.lifecycle is not None:
            self.lifecycle.append("wake_stop")


class VoiceWakeControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = voice_config()
        self.router = Mock()
        self.router.accepted_phrases = ("open netflix",)
        self.router.route.return_value = CommandResult(
            True,
            "open_netflix",
            "Netflix launch requested.",
        )
        self.recognizer = Mock()

    def controller(self):
        return jarvis.VoiceWakeController(
            self.config,
            input_idx=7,
            input_name="Selected microphone",
            recognizer=self.recognizer,
            router=self.router,
        )

    def test_successful_text_uses_production_router_once(self) -> None:
        self.recognizer.recognize_one_command.return_value = SpeechRecognitionResult(
            True,
            "open netflix",
            0.94,
        )
        controller = self.controller()
        with patch("builtins.print"):
            ran = controller.run_cycle()

        self.assertTrue(ran)
        self.router.route.assert_called_once_with("open netflix", dry_run=False)
        self.recognizer.recognize_one_command.assert_called_once_with(
            device_index=7,
            phrases=("open netflix",),
            sample_rate=jarvis.SAMPLE_RATE,
            blocksize=jarvis.block_samples(),
        )
        self.assertFalse(controller.busy)

    def test_failure_outcomes_clear_busy_and_allow_later_cycles(self) -> None:
        self.recognizer.recognize_one_command.side_effect = [
            SpeechRecognitionResult(False, reason="timeout"),
            SpeechRecognitionResult(False, reason="no_match"),
            SpeechRecognitionResult(False, confidence=0.3, reason="low_confidence"),
            SpeechRecognitionResult(
                False, reason="microphone_error", error="device busy"
            ),
            SpeechRecognitionResult(
                False, reason="recognizer_error", error="recognizer unavailable"
            ),
            SpeechRecognitionResult(True, "open netflix", 0.94),
        ]
        controller = self.controller()

        with patch("builtins.print"):
            outcomes = [controller.run_cycle() for _ in range(6)]

        self.assertEqual(outcomes, [True] * 6)
        self.assertFalse(controller.busy)
        self.assertEqual(self.recognizer.recognize_one_command.call_count, 6)
        self.router.route.assert_called_once_with("open netflix", dry_run=False)

    def test_command_failure_still_clears_busy_state(self) -> None:
        self.recognizer.recognize_one_command.return_value = SpeechRecognitionResult(
            True,
            "open netflix",
            0.94,
        )
        self.router.route.return_value = CommandResult(
            False,
            "open_netflix",
            "Command failed: launch failed",
        )
        controller = self.controller()

        with patch("builtins.print"):
            self.assertTrue(controller.run_cycle())

        self.assertFalse(controller.busy)

    def test_busy_controller_rejects_overlapping_cycle(self) -> None:
        controller = self.controller()
        controller._cycle_lock.acquire()
        try:
            self.assertFalse(controller.run_cycle())
        finally:
            controller._cycle_lock.release()

        self.recognizer.recognize_one_command.assert_not_called()

    def test_start_my_desk_uses_existing_desk_routine(self) -> None:
        self.recognizer.recognize_one_command.return_value = SpeechRecognitionResult(
            True,
            "start my desk",
            0.96,
        )
        controller = jarvis.VoiceWakeController(
            self.config,
            input_idx=7,
            input_name="Selected microphone",
            recognizer=self.recognizer,
        )
        with patch("jarvis.run_desk_mode", return_value=[]) as desk, patch(
            "builtins.print"
        ):
            controller.run_cycle()

        desk.assert_called_once_with(self.config)

    def test_unknown_recognized_text_executes_no_desktop_action(self) -> None:
        self.recognizer.recognize_one_command.return_value = SpeechRecognitionResult(
            True,
            "order me dinner",
            0.99,
        )
        controller = jarvis.VoiceWakeController(
            self.config,
            input_idx=7,
            input_name="Selected microphone",
            recognizer=self.recognizer,
        )
        with patch("jarvis.open_netflix") as netflix, patch(
            "jarvis.open_claude"
        ) as claude, patch("jarvis.open_spotify") as spotify, patch(
            "builtins.print"
        ):
            controller.run_cycle()

        netflix.assert_not_called()
        claude.assert_not_called()
        spotify.assert_not_called()


class ActiveJarvisSessionTests(unittest.TestCase):
    def test_accepted_wake_releases_recognizer_before_command_cycle(self) -> None:
        lifecycle = []
        wake = FakeWakeRecognizer(
            [WakeWordResult(True, "Jarvis", 0.94)], lifecycle=lifecycle
        )
        voice = Mock()
        voice.run_cycle.side_effect = lambda: lifecycle.append("command_cycle")
        session = jarvis.ActiveJarvisSession(
            voice_config(),
            voice_controller=voice,
            wake_recognizer=wake,
            restart_delay_s=0,
        )

        self.assertTrue(session.run_until_command_cycle())

        self.assertEqual(
            lifecycle,
            ["wake_start", "wake_wait", "wake_stop", "command_cycle"],
        )
        voice.run_cycle.assert_called_once_with()

    def test_low_confidence_wake_does_not_start_command(self) -> None:
        wake = FakeWakeRecognizer(
            [
                WakeWordResult(False, "Jarvis", 0.50, reason="low_confidence"),
                WakeWordResult(True, "Jarvis", 0.92),
            ]
        )
        voice = Mock()
        session = jarvis.ActiveJarvisSession(
            voice_config(), voice_controller=voice, wake_recognizer=wake
        )

        self.assertTrue(session.run_until_command_cycle())

        self.assertEqual(wake.start_count, 1)
        voice.run_cycle.assert_called_once_with()

    def test_recognizer_failure_recovers_on_next_wake_wait(self) -> None:
        wake = FakeWakeRecognizer(
            [
                WakeWordResult(
                    False, reason="recognizer_error", error="recognizer stopped"
                ),
                WakeWordResult(True, "Jarvis", 0.95),
            ]
        )
        voice = Mock()
        session = jarvis.ActiveJarvisSession(
            voice_config(), voice_controller=voice, wake_recognizer=wake
        )

        self.assertFalse(session.run_until_command_cycle())
        self.assertTrue(session.run_until_command_cycle())

        self.assertEqual(wake.start_count, 2)
        self.assertEqual(wake.stop_count, 2)
        voice.run_cycle.assert_called_once_with()

    def test_keyboard_interrupt_stops_wake_recognizer(self) -> None:
        wake = Mock()
        wake.wait_for_wake.side_effect = KeyboardInterrupt
        session = jarvis.ActiveJarvisSession(
            voice_config(), voice_controller=Mock(), wake_recognizer=wake
        )

        with self.assertRaises(KeyboardInterrupt):
            session.run_until_command_cycle()

        wake.stop.assert_called_once_with()

    def test_three_sequential_wakes_run_three_command_cycles(self) -> None:
        wake = FakeWakeRecognizer(
            [WakeWordResult(True, "Jarvis", 0.95) for _ in range(3)]
        )
        voice = Mock()
        session = jarvis.ActiveJarvisSession(
            voice_config(), voice_controller=voice, wake_recognizer=wake
        )

        outcomes = [session.run_until_command_cycle() for _ in range(3)]

        self.assertEqual(outcomes, [True, True, True])
        self.assertEqual(wake.start_count, 3)
        self.assertEqual(wake.stop_count, 3)
        self.assertEqual(voice.run_cycle.call_count, 3)

    def test_run_forever_restarts_wake_recognition_after_each_command(self) -> None:
        wake = FakeWakeRecognizer(
            [WakeWordResult(True, "Jarvis", 0.95) for _ in range(3)]
        )
        voice = Mock()
        session = jarvis.ActiveJarvisSession(
            voice_config(), voice_controller=voice, wake_recognizer=wake
        )

        def complete_cycle():
            if voice.run_cycle.call_count == 3:
                session.stop()

        voice.run_cycle.side_effect = complete_cycle
        session.run_forever()

        self.assertEqual(voice.run_cycle.call_count, 3)
        self.assertEqual(wake.start_count, 3)


class VoiceWakeMainLoopTests(unittest.TestCase):
    def test_first_clap_closes_stream_runs_desk_then_starts_active_session(self) -> None:
        lifecycle = []
        clap = TrackedClapStream([0.04, 0.0, 0.04], lifecycle=lifecycle)
        voice = Mock()
        session = Mock()
        session.run_forever.side_effect = lambda: lifecycle.append("active_session")
        times = [0.0, 1.0, 1.08, 1.18]

        with patch("jarvis._choose_input_device", return_value=1), patch(
            "jarvis.sd.query_devices", return_value={"name": "Test microphone"}
        ), patch("jarvis.sd.InputStream", return_value=clap) as input_stream, patch(
            "jarvis.VoiceWakeController", return_value=voice
        ), patch("jarvis.ActiveJarvisSession", return_value=session), patch(
            "jarvis.run_desk_mode",
            side_effect=lambda _config: lifecycle.append("desk_mode") or [],
        ) as desk, patch("jarvis.time.monotonic", side_effect=times):
            result = jarvis.main([], config=voice_config())

        self.assertEqual(result, 0)
        self.assertEqual(
            lifecycle,
            ["clap_open", "clap_closed", "desk_mode", "active_session"],
        )
        self.assertEqual(input_stream.call_count, 1)
        desk.assert_called_once_with(voice_config())
        session.run_forever.assert_called_once_with()
        voice.run_cycle.assert_not_called()

    def test_activation_continues_when_one_desk_action_failed(self) -> None:
        clap = TrackedClapStream([0.04, 0.0, 0.04])
        times = [0.0, 1.0, 1.08, 1.18, 2.0]
        session = Mock()
        failure = jarvis.ActionResult("Spotify", False, "launch failed")

        with patch("jarvis._choose_input_device", return_value=1), patch(
            "jarvis.sd.query_devices", return_value={"name": "Test microphone"}
        ), patch("jarvis.sd.InputStream", return_value=clap), patch(
            "jarvis.ActiveJarvisSession", return_value=session
        ), patch("jarvis.run_desk_mode", return_value=[failure]), patch(
            "jarvis.time.monotonic", side_effect=times
        ):
            result = jarvis.main([], config=voice_config())

        self.assertEqual(result, 0)
        session.run_forever.assert_called_once_with()

    def test_explicit_nondefault_microphone_is_rejected_for_wake_recognizer(self) -> None:
        config = load_config(
            {
                "JARVIS_SESSION_MODE": "clap_then_voice",
                "JARVIS_INPUT_DEVICE": "7",
                "ENABLE_ELEVENLABS": "false",
            }
        )
        with patch("jarvis._choose_input_device", return_value=7), patch(
            "jarvis.sd.query_devices", return_value={"name": "Override mic"}
        ), patch.object(jarvis.sd.default, "device", (1, 2)), patch(
            "jarvis.sd.InputStream"
        ) as stream:
            result = jarvis.main([], config=config)

        self.assertEqual(result, 2)
        stream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
