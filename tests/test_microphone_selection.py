import unittest
from types import SimpleNamespace
from unittest.mock import call, patch

import numpy as np

import jarvis


BLOCKSIZE = jarvis.block_samples()


def device(name: str, input_channels: int) -> dict:
    return {"name": name, "max_input_channels": input_channels}


def device_query(devices: list[dict]):
    def query(index=None):
        if index is None:
            return devices
        if not isinstance(index, int) or index < 0 or index >= len(devices):
            raise ValueError(f"invalid device {index}")
        return devices[index]

    return query


AVAILABLE_QUIET = jarvis.InputProbeResult(available=True, peak_rms=0.00001)
UNAVAILABLE = jarvis.InputProbeResult(
    available=False, error="test device could not be opened"
)


class MicrophoneSelectionTests(unittest.TestCase):
    def choose_without_override(self, devices, default_input, probe_side_effect):
        with patch.object(
            jarvis.sd, "default", SimpleNamespace(device=(default_input, 9))
        ), patch(
            "jarvis.sd.query_devices", side_effect=device_query(devices)
        ), patch(
            "jarvis._probe_input_device", side_effect=probe_side_effect
        ) as probe:
            self.last_probe = probe
            result = jarvis._choose_input_device(BLOCKSIZE, log_devices=False)
        return result, probe

    def test_configured_valid_index_is_preferred(self) -> None:
        devices = [device("Output", 0), device("Default mic", 1), device("USB mic", 1)]
        with patch(
            "jarvis.sd.query_devices", side_effect=device_query(devices)
        ), patch("jarvis._probe_input_device", return_value=AVAILABLE_QUIET) as probe:
            result = jarvis._choose_input_device(
                BLOCKSIZE, configured_device="2", log_devices=False
            )

        self.assertEqual(result, 2)
        probe.assert_called_once_with(2, BLOCKSIZE)

    def test_configured_unique_name_is_preferred(self) -> None:
        devices = [device("Output", 0), device("Default mic", 1), device("USB Studio Mic", 1)]
        with patch(
            "jarvis.sd.query_devices", side_effect=device_query(devices)
        ), patch("jarvis._probe_input_device", return_value=AVAILABLE_QUIET) as probe:
            result = jarvis._choose_input_device(
                BLOCKSIZE, configured_device="Studio", log_devices=False
            )

        self.assertEqual(result, 2)
        probe.assert_called_once_with(2, BLOCKSIZE)

    def test_configured_invalid_device_fails_without_fallback(self) -> None:
        devices = [device("Default mic", 1)]
        with patch(
            "jarvis.sd.query_devices", side_effect=device_query(devices)
        ), patch("jarvis._probe_input_device") as probe:
            with self.assertRaises(SystemExit):
                jarvis._choose_input_device(
                    BLOCKSIZE, configured_device="99", log_devices=False
                )

        probe.assert_not_called()

    def test_configured_ambiguous_name_fails(self) -> None:
        devices = [device("Microphone Array MME", 1), device("Microphone Array WASAPI", 1)]
        with patch(
            "jarvis.sd.query_devices", side_effect=device_query(devices)
        ):
            with self.assertRaises(SystemExit):
                jarvis._choose_input_device(
                    BLOCKSIZE,
                    configured_device="Microphone Array",
                    log_devices=False,
                )

    def test_configured_device_that_cannot_open_fails_without_fallback(self) -> None:
        devices = [device("Default mic", 1), device("Configured mic", 1)]
        with patch(
            "jarvis.sd.query_devices", side_effect=device_query(devices)
        ), patch("jarvis._probe_input_device", return_value=UNAVAILABLE) as probe:
            with self.assertRaises(SystemExit):
                jarvis._choose_input_device(
                    BLOCKSIZE, configured_device="1", log_devices=False
                )

        probe.assert_called_once_with(1, BLOCKSIZE)

    def test_quiet_default_device_is_accepted(self) -> None:
        devices = [device("Output", 0), device("Quiet default", 1), device("Other mic", 1)]

        result, _probe = self.choose_without_override(devices, 1, [AVAILABLE_QUIET])

        self.assertEqual(result, 1)

    def test_low_probe_rms_does_not_scan_alternatives(self) -> None:
        devices = [device("Output", 0), device("Quiet default", 1), device("Other mic", 1)]

        _result, probe = self.choose_without_override(devices, 1, [AVAILABLE_QUIET])

        probe.assert_called_once_with(1, BLOCKSIZE)

    def test_default_open_failure_causes_alternative_scan(self) -> None:
        devices = [device("Output", 0), device("Broken default", 1), device("Broken alternative", 1)]

        with self.assertRaises(SystemExit):
            self.choose_without_override(devices, 1, [UNAVAILABLE, UNAVAILABLE])

        self.assertEqual(
            self.last_probe.call_args_list,
            [call(1, BLOCKSIZE), call(2, BLOCKSIZE)],
        )

    def test_devices_without_input_channels_are_skipped(self) -> None:
        devices = [device("Output only", 0), device("Usable mic", 1)]

        result, probe = self.choose_without_override(devices, -1, [AVAILABLE_QUIET])

        self.assertEqual(result, 1)
        probe.assert_called_once_with(1, BLOCKSIZE)

    def test_usable_alternative_is_selected_after_default_failure(self) -> None:
        devices = [device("Output", 0), device("Broken default", 1), device("Usable alternative", 1)]

        result, probe = self.choose_without_override(
            devices, 1, [UNAVAILABLE, AVAILABLE_QUIET]
        )

        self.assertEqual(result, 2)
        self.assertEqual(probe.call_args_list, [call(1, BLOCKSIZE), call(2, BLOCKSIZE)])

    def test_no_usable_input_device_fails_clearly(self) -> None:
        devices = [device("Output", 0), device("Broken mic", 1)]

        with self.assertLogs("clap_listen", level="ERROR") as captured:
            with self.assertRaises(SystemExit):
                self.choose_without_override(devices, -1, [UNAVAILABLE])

        self.assertTrue(
            any("No usable input device" in message for message in captured.output)
        )


class ZeroProbeStream:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, blocksize):
        return np.zeros((blocksize, 1), dtype=np.float32), False


class InputProbeTests(unittest.TestCase):
    def test_near_zero_audio_is_still_an_available_device(self) -> None:
        with patch("jarvis._query_input_device", return_value=device("Quiet mic", 1)), patch(
            "jarvis.sd.check_input_settings"
        ), patch("jarvis.sd.InputStream", return_value=ZeroProbeStream()), patch(
            "jarvis.time.monotonic", side_effect=[0.0, 0.1, 0.6]
        ):
            result = jarvis._probe_input_device(1, BLOCKSIZE)

        self.assertTrue(result.available)
        self.assertEqual(result.peak_rms, 0.0)
        self.assertIsNone(result.error)

    def test_stream_open_failure_is_unavailable(self) -> None:
        with patch("jarvis._query_input_device", return_value=device("Broken mic", 1)), patch(
            "jarvis.sd.check_input_settings"
        ), patch("jarvis.sd.InputStream", side_effect=ValueError("unsupported stream")):
            result = jarvis._probe_input_device(1, BLOCKSIZE)

        self.assertFalse(result.available)
        self.assertIsNone(result.peak_rms)
        self.assertEqual(result.error, "unsupported stream")


if __name__ == "__main__":
    unittest.main()
