import unittest
from pathlib import Path
from unittest.mock import patch

import jarvis
from config import ConfigError, load_config, parse_bool


class BooleanParsingTests(unittest.TestCase):
    def test_valid_boolean_values_are_case_insensitive(self) -> None:
        for value in ("true", "TRUE", "1", "yes", "YeS", "on"):
            with self.subTest(value=value):
                self.assertTrue(parse_bool(value, name="TEST_VALUE"))
        for value in ("false", "FALSE", "0", "no", "No", "off"):
            with self.subTest(value=value):
                self.assertFalse(parse_bool(value, name="TEST_VALUE"))

    def test_invalid_boolean_is_rejected_clearly(self) -> None:
        with self.assertRaisesRegex(ConfigError, "OPEN_SPOTIFY must be"):
            parse_bool("banana", name="OPEN_SPOTIFY")


class ConfigurationTests(unittest.TestCase):
    def test_defaults_when_environment_is_absent(self) -> None:
        config = load_config({})

        self.assertTrue(config.open_spotify)
        self.assertFalse(config.spotify_enabled)
        self.assertTrue(config.open_claude)
        self.assertTrue(config.focus_cursor)
        self.assertIsNone(config.input_device)

    def test_user_values_override_defaults(self) -> None:
        config = load_config(
            {
                "OPEN_SPOTIFY": "no",
                "OPEN_CLAUDE": "off",
                "FOCUS_CURSOR": "0",
                "JARVIS_WELCOME_PHRASE": "Good morning.",
            }
        )

        self.assertFalse(config.open_spotify)
        self.assertFalse(config.open_claude)
        self.assertFalse(config.focus_cursor)
        self.assertEqual(config.welcome_phrase, "Good morning.")

    def test_missing_elevenlabs_credentials_disable_only_speech(self) -> None:
        config = load_config({"ENABLE_ELEVENLABS": "true"})

        self.assertFalse(config.elevenlabs_enabled)
        self.assertEqual(
            config.elevenlabs_disabled_reason(),
            "ELEVENLABS_API_KEY is not configured",
        )
        self.assertTrue(config.open_claude)

    def test_disabled_feature_does_not_validate_unused_settings(self) -> None:
        config = load_config(
            {
                "OPEN_CLAUDE": "false",
                "OPEN_BINANCE": "false",
                "CLAUDE_URL": "",
                "CLAUDE_CHROME_MONITOR": "not-an-integer",
                "CHROME_WINDOW_WIDTH": "not-an-integer",
            }
        )

        self.assertFalse(config.open_claude)

    def test_enabled_feature_requires_its_configuration(self) -> None:
        with self.assertRaisesRegex(ConfigError, "CLAUDE_URL must be configured"):
            load_config({"OPEN_CLAUDE": "true", "CLAUDE_URL": ""})

    def test_spotify_desktop_uri_is_accepted(self) -> None:
        config = load_config(
            {"SONG_URI": "spotify:track:08mG3Y1vljYA6bvDt4Wqkj"}
        )

        self.assertEqual(
            config.song_uri, "spotify:track:08mG3Y1vljYA6bvDt4Wqkj"
        )

    def test_spotify_monitor_is_parsed(self) -> None:
        config = load_config({"SPOTIFY_MONITOR": "2"})

        self.assertEqual(config.spotify_monitor, 2)

    def test_spotify_minimize_is_strictly_parsed(self) -> None:
        self.assertTrue(load_config({"SPOTIFY_MINIMIZE": "true"}).spotify_minimize)
        self.assertFalse(load_config({}).spotify_minimize)
        with self.assertRaisesRegex(ConfigError, "SPOTIFY_MINIMIZE must be"):
            load_config({"SPOTIFY_MINIMIZE": "sometimes"})

    def test_claude_desktop_uri_is_accepted(self) -> None:
        config = load_config({"CLAUDE_URL": "claude://claude.ai/new"})

        self.assertEqual(config.claude_scheme, "claude")
        self.assertFalse(config.open_chrome_fullscreen)

    def test_claude_desktop_monitor_is_separate_from_browser_monitor(self) -> None:
        config = load_config(
            {
                "CLAUDE_URL": "claude://claude.ai/new",
                "CLAUDE_MONITOR": "2",
                "CLAUDE_CHROME_MONITOR": "not-used-in-desktop-mode",
            }
        )

        self.assertEqual(config.claude_monitor, 2)
        self.assertEqual(config.claude_chrome_monitor, 1)

    def test_claude_maximize_is_strictly_parsed(self) -> None:
        config = load_config(
            {
                "CLAUDE_URL": "claude://claude.ai/new",
                "CLAUDE_MAXIMIZE": "yes",
            }
        )
        self.assertTrue(config.claude_maximize)
        self.assertFalse(load_config({}).claude_maximize)
        with self.assertRaisesRegex(ConfigError, "CLAUDE_MAXIMIZE must be"):
            load_config(
                {
                    "CLAUDE_URL": "claude://claude.ai/new",
                    "CLAUDE_MAXIMIZE": "sometimes",
                }
            )

    def test_netflix_enable_and_monitor_are_parsed(self) -> None:
        config = load_config({"OPEN_NETFLIX": "true", "NETFLIX_MONITOR": "3"})

        self.assertTrue(config.open_netflix)
        self.assertEqual(config.netflix_monitor, 3)

    def test_netflix_maximize_is_strictly_parsed(self) -> None:
        config = load_config(
            {"OPEN_NETFLIX": "true", "NETFLIX_MAXIMIZE": "on"}
        )
        self.assertTrue(config.netflix_maximize)
        self.assertFalse(load_config({}).netflix_maximize)
        with self.assertRaisesRegex(ConfigError, "NETFLIX_MAXIMIZE must be"):
            load_config(
                {"OPEN_NETFLIX": "true", "NETFLIX_MAXIMIZE": "sometimes"}
            )

    def test_netflix_is_disabled_by_default(self) -> None:
        config = load_config({})

        self.assertFalse(config.open_netflix)
        self.assertIsNone(config.netflix_monitor)

    def test_blank_monitor_values_mean_no_forced_placement(self) -> None:
        config = load_config(
            {
                "SPOTIFY_MONITOR": "",
                "CLAUDE_URL": "claude://claude.ai/new",
                "CLAUDE_MONITOR": "",
                "OPEN_NETFLIX": "true",
                "NETFLIX_MONITOR": "",
            }
        )

        self.assertIsNone(config.spotify_monitor)
        self.assertIsNone(config.claude_monitor)
        self.assertIsNone(config.netflix_monitor)

    def test_invalid_monitor_value_is_rejected_cleanly(self) -> None:
        for name, env in (
            ("SPOTIFY_MONITOR", {"SPOTIFY_MONITOR": "zero"}),
            (
                "CLAUDE_MONITOR",
                {
                    "CLAUDE_URL": "claude://claude.ai/new",
                    "CLAUDE_MONITOR": "0",
                },
            ),
            (
                "NETFLIX_MONITOR",
                {"OPEN_NETFLIX": "true", "NETFLIX_MONITOR": "-1"},
            ),
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ConfigError, name):
                    load_config(env)

    def test_claude_desktop_does_not_validate_unused_chrome_settings(self) -> None:
        config = load_config(
            {
                "CLAUDE_URL": "claude://claude.ai/new",
                "OPEN_CHROME_FULLSCREEN": "banana",
                "CLAUDE_CHROME_MONITOR": "not-an-integer",
                "CHROME_WINDOW_WIDTH": "not-an-integer",
            }
        )

        self.assertEqual(config.claude_scheme, "claude")

    def test_unsupported_claude_uri_scheme_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            ConfigError, "CLAUDE_URL uses unsupported URI scheme 'file'"
        ):
            load_config({"CLAUDE_URL": "file:///C:/Windows/System32/calc.exe"})

    def test_invalid_action_boolean_is_rejected(self) -> None:
        with self.assertRaisesRegex(ConfigError, "OPEN_SPOTIFY must be"):
            load_config({"OPEN_SPOTIFY": "banana"})

    def test_microphone_override_is_preserved_for_selector(self) -> None:
        config = load_config({"JARVIS_INPUT_DEVICE": "Microphone Array"})

        self.assertEqual(config.input_device, "Microphone Array")

    def test_legacy_environment_names_remain_compatible(self) -> None:
        config = load_config(
            {
                "OPEN_CLAUDE_CODE_IN_CHROME": "false",
                "FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP": "no",
                "JARVIS_WELCOME_ENABLED": "off",
            }
        )

        self.assertFalse(config.open_claude)
        self.assertFalse(config.focus_cursor)
        self.assertFalse(config.enable_elevenlabs)

    def test_cache_path_defaults_inside_project(self) -> None:
        project = Path("test-project").resolve()
        config = load_config({}, base_dir=project)

        self.assertEqual(
            config.welcome_cache_dir,
            project / ".cache" / "jarvis_welcome",
        )

    def test_configuration_logging_never_emits_secret_values(self) -> None:
        secret = "test-secret-that-must-not-be-logged"
        voice = "test-voice-that-must-not-be-logged"
        config = load_config(
            {
                "ELEVENLABS_API_KEY": secret,
                "ELEVENLABS_VOICE_ID": voice,
            }
        )

        with self.assertLogs("clap_listen", level="INFO") as captured:
            jarvis._log_configuration(config)

        output = "\n".join(captured.output)
        self.assertNotIn(secret, output)
        self.assertNotIn(voice, output)
        self.assertIn("credentials configured", output)

    @patch("jarvis._choose_input_device")
    @patch("jarvis.load_config", side_effect=ConfigError("invalid setting"))
    def test_startup_rejects_configuration_error_before_microphone_access(
        self, _load_config, choose_input
    ) -> None:
        with self.assertLogs("clap_listen", level="ERROR") as captured:
            result = jarvis.main([])

        self.assertEqual(result, 2)
        choose_input.assert_not_called()
        self.assertIn("Configuration error: invalid setting", "\n".join(captured.output))


if __name__ == "__main__":
    unittest.main()
