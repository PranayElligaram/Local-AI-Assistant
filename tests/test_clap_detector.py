import unittest
from unittest.mock import patch

import numpy as np

import jarvis
from config import load_config


def event_kinds(events: list[jarvis.ClapEvent]) -> list[jarvis.ClapEventType]:
    return [event.kind for event in events]


class ClapDetectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.detector = jarvis.ClapDetector()

    def rearm(self, now: float) -> list[jarvis.ClapEvent]:
        return self.detector.process(0.0, now)

    def spike(self, now: float) -> list[jarvis.ClapEvent]:
        return self.detector.process(0.04, now)

    def test_value_below_absolute_threshold_is_not_a_spike(self) -> None:
        events = self.detector.process(0.019, 1.0)

        self.assertEqual(events, [])
        self.assertTrue(self.detector.spike_armed)
        self.assertIsNone(self.detector.first_clap_time)

    def test_representative_clap_above_threshold_is_a_spike(self) -> None:
        kinds = event_kinds(self.detector.process(0.04, 1.0))

        self.assertIn(jarvis.ClapEventType.SPIKE, kinds)
        self.assertIn(jarvis.ClapEventType.FIRST_CLAP, kinds)

    def test_one_spike_does_not_produce_double_clap(self) -> None:
        kinds = event_kinds(self.spike(1.0))

        self.assertIn(jarvis.ClapEventType.FIRST_CLAP, kinds)
        self.assertNotIn(jarvis.ClapEventType.DOUBLE_CLAP, kinds)

    def test_two_valid_spikes_produce_double_clap(self) -> None:
        self.spike(1.0)
        self.rearm(1.08)

        kinds = event_kinds(self.spike(1.18))

        self.assertIn(jarvis.ClapEventType.DOUBLE_CLAP, kinds)

    def test_two_spikes_too_close_are_rejected(self) -> None:
        self.spike(1.0)
        self.rearm(1.02)

        events = self.spike(1.04)

        self.assertIn(jarvis.ClapEventType.TOO_CLOSE, event_kinds(events))
        self.assertNotIn(jarvis.ClapEventType.DOUBLE_CLAP, event_kinds(events))
        self.assertAlmostEqual(events[-1].interval, 0.04)

    def test_two_spikes_too_far_apart_are_rejected(self) -> None:
        self.spike(1.0)
        self.rearm(1.10)

        events = self.spike(1.40)

        self.assertIn(jarvis.ClapEventType.TOO_FAR, event_kinds(events))
        self.assertNotIn(jarvis.ClapEventType.DOUBLE_CLAP, event_kinds(events))
        self.assertEqual(self.detector.first_clap_time, 1.40)

    def test_signal_must_fall_before_second_clap(self) -> None:
        self.spike(1.0)

        still_high = self.spike(1.18)
        rearmed = self.rearm(1.19)
        second = self.spike(1.20)

        self.assertEqual(still_high, [])
        self.assertIn(jarvis.ClapEventType.REARMED, event_kinds(rearmed))
        self.assertIn(jarvis.ClapEventType.DOUBLE_CLAP, event_kinds(second))

    def test_background_samples_do_not_trigger(self) -> None:
        events = []
        for index in range(100):
            events.extend(self.detector.process(0.005, 1.0 + index * 0.04))

        self.assertEqual(events, [])
        self.assertTrue(self.detector.spike_armed)
        self.assertIsNone(self.detector.first_clap_time)

    def test_quiet_sample_updates_noise_floor_without_lowering_absolute_threshold(
        self,
    ) -> None:
        self.detector.process(0.0, 1.0)

        self.assertLess(self.detector.noise_floor, jarvis.INITIAL_NOISE_FLOOR)
        self.assertEqual(self.detector.threshold, jarvis.MIN_RMS)

    def test_same_high_event_does_not_repeatedly_fire(self) -> None:
        self.spike(1.0)
        self.rearm(1.08)
        detected = self.spike(1.18)

        repeated = self.spike(1.19) + self.spike(2.0)

        self.assertIn(jarvis.ClapEventType.DOUBLE_CLAP, event_kinds(detected))
        self.assertEqual(repeated, [])


class FakeInputStream:
    def __init__(self, levels: list[float]) -> None:
        self.levels = iter(levels)

    def __enter__(self) -> "FakeInputStream":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, blocksize: int) -> tuple[np.ndarray, bool]:
        try:
            level = next(self.levels)
        except StopIteration as exc:
            raise KeyboardInterrupt from exc
        return np.full((blocksize, 1), level, dtype=np.float32), False


class MainModeSafetyTests(unittest.TestCase):
    @patch("jarvis.run_double_clap_actions")
    @patch("jarvis.sd.query_devices", return_value={"name": "Test microphone"})
    @patch("jarvis._choose_input_device", return_value=1)
    def test_debug_audio_never_runs_desktop_actions(
        self,
        _choose_input_device,
        _query_devices,
        run_actions,
    ) -> None:
        stream = FakeInputStream([0.04, 0.0, 0.04])
        times = [0.0, 1.0, 1.08, 1.18]

        with patch("jarvis.sd.InputStream", return_value=stream), patch(
            "jarvis.time.monotonic", side_effect=times
        ):
            result = jarvis.main(["--debug-audio"], config=load_config({}))

        self.assertEqual(result, 0)
        run_actions.assert_not_called()

    @patch("jarvis.threading.Thread")
    @patch("jarvis._choose_input_device", return_value=1)
    def test_desk_mode_schedules_actions_only_once_per_process(
        self,
        _choose_input_device,
        thread,
    ) -> None:
        stream = FakeInputStream([0.04, 0.0, 0.04, 0.0, 0.04, 0.0, 0.04])
        times = [0.0, 1.0, 1.08, 1.18, 1.30, 1.70, 1.78, 1.88]

        with patch("jarvis.sd.InputStream", return_value=stream), patch(
            "jarvis.time.monotonic", side_effect=times
        ):
            result = jarvis.main(
                [],
                config=load_config({"DOUBLE_CLAP_MODE": "desk"}),
            )

        self.assertEqual(result, 0)
        self.assertEqual(thread.call_count, 1)
        thread.return_value.start.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
