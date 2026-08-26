import ctypes
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import jarvis
from commands import CommandDefinition, CommandRouter, normalize_command
from config import load_config


def command_config():
    return load_config(
        {
            "ENABLE_ELEVENLABS": "false",
            "OPEN_SPOTIFY": "true",
            "SONG_URI": "spotify:track:test",
            "SPOTIFY_MINIMIZE": "true",
            "OPEN_CLAUDE": "true",
            "CLAUDE_URL": "claude://claude.ai/new",
            "CLAUDE_MONITOR": "2",
            "CLAUDE_MAXIMIZE": "true",
            "OPEN_NETFLIX": "true",
            "NETFLIX_MONITOR": "3",
            "NETFLIX_MAXIMIZE": "true",
            "FOCUS_CURSOR": "false",
            "OPEN_BINANCE": "false",
        }
    )


class NormalizationTests(unittest.TestCase):
    def test_normalization_trims_whitespace(self) -> None:
        self.assertEqual(normalize_command("  open netflix  "), "open netflix")

    def test_normalization_is_case_insensitive(self) -> None:
        self.assertEqual(normalize_command("Open NETFLIX"), "open netflix")

    def test_normalization_collapses_whitespace_and_simple_punctuation(self) -> None:
        self.assertEqual(
            normalize_command("  WHAT   time is it?! "),
            "what time is it",
        )


class CommandRouterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = command_config()

    def test_start_my_desk_routes_to_existing_desk_routine(self) -> None:
        with patch("jarvis.run_desk_mode", return_value=[]) as desk:
            result = jarvis.create_command_router(self.config).route("start my desk")

        self.assertTrue(result.success)
        self.assertEqual(result.command, "desk_mode")
        desk.assert_called_once_with(self.config)

    def test_desk_aliases_map_to_same_canonical_command(self) -> None:
        with patch("jarvis.run_desk_mode", return_value=[]) as desk:
            router = jarvis.create_command_router(self.config)
            results = [
                router.route("desk mode"),
                router.route("start desk mode"),
            ]

        self.assertEqual([result.command for result in results], ["desk_mode"] * 2)
        self.assertEqual(desk.call_count, 2)

    def test_router_exposes_registered_spoken_aliases_as_grammar(self) -> None:
        phrases = jarvis.create_command_router(self.config).accepted_phrases

        self.assertIn("start my desk", phrases)
        self.assertIn("open netflix", phrases)
        self.assertIn("what time is it", phrases)
        self.assertNotIn("desk_mode", phrases)

    def test_open_claude_routes_to_existing_desktop_action(self) -> None:
        with patch("jarvis.open_claude") as action:
            result = jarvis.create_command_router(self.config).route("launch claude")

        self.assertTrue(result.success)
        self.assertEqual(result.command, "open_claude")
        action.assert_called_once_with(self.config)

    def test_open_claude_rejects_browser_configuration(self) -> None:
        config = load_config(
            {
                "OPEN_CLAUDE": "true",
                "CLAUDE_URL": "https://claude.ai/new",
                "OPEN_SPOTIFY": "false",
                "FOCUS_CURSOR": "false",
                "ENABLE_ELEVENLABS": "false",
            }
        )
        with patch("jarvis.open_claude") as action:
            result = jarvis.create_command_router(config).route("open claude")

        self.assertFalse(result.success)
        self.assertIn("claude://", result.message)
        action.assert_not_called()

    def test_open_netflix_routes_to_existing_action(self) -> None:
        with patch("jarvis.open_netflix") as action:
            result = jarvis.create_command_router(self.config).route("open netflix")

        self.assertTrue(result.success)
        self.assertEqual(result.command, "open_netflix")
        action.assert_called_once_with(self.config)

    def test_play_spotify_routes_to_existing_background_action(self) -> None:
        with patch("jarvis.open_spotify") as action, patch(
            "jarvis._enforce_spotify_minimized_final", return_value=True
        ) as enforce, patch("jarvis.time.sleep") as settle:
            result = jarvis.create_command_router(self.config).route("play spotify")

        self.assertTrue(result.success)
        self.assertEqual(result.command, "play_spotify")
        self.assertEqual(result.message, "Spotify playing in background.")
        action.assert_called_once_with(self.config)
        settle.assert_called_once_with(jarvis.SPOTIFY_PLAY_SETTLE_S)
        enforce.assert_called_once_with()

    def test_play_spotify_fails_if_final_minimize_is_not_verified(self) -> None:
        with patch("jarvis.open_spotify"), patch(
            "jarvis._enforce_spotify_minimized_final", return_value=False
        ), patch("jarvis.time.sleep"):
            result = jarvis.create_command_router(self.config).route("play spotify")

        self.assertFalse(result.success)
        self.assertIn("could not be kept minimized", result.message)

    def test_play_spotify_is_background_even_if_general_launch_minimize_is_off(self) -> None:
        config = load_config(
            {
                "OPEN_SPOTIFY": "true",
                "SONG_URI": "spotify:track:test",
                "SPOTIFY_MINIMIZE": "false",
            }
        )
        with patch("jarvis.open_spotify"), patch(
            "jarvis.time.sleep"
        ), patch("jarvis._enforce_spotify_minimized_final", return_value=True) as enforce:
            result = jarvis.create_command_router(config).route("play spotify")

        self.assertTrue(result.success)
        self.assertEqual(result.message, "Spotify playing in background.")
        enforce.assert_called_once_with()

    def test_open_and_show_spotify_route_to_foreground_action(self) -> None:
        with patch("jarvis.show_spotify_window") as action:
            router = jarvis.create_command_router(self.config)
            open_result = router.route("open spotify")
            show_result = router.route("show spotify")

        self.assertEqual(open_result.command, "show_spotify")
        self.assertEqual(show_result.command, "show_spotify")
        self.assertEqual(action.call_count, 2)

    def test_close_netflix_targets_only_identified_netflix_hwnd(self) -> None:
        netflix = jarvis.DesktopWindow(
            16125526,
            "msedge.exe",
            "Netflix - Home - Netflix",
            2_000_000,
            class_name="Chrome_WidgetWin_1",
            visible=True,
        )
        with patch("jarvis._best_netflix_window_win32", return_value=netflix), patch(
            "jarvis._request_window_close_win32", return_value=True
        ) as close, patch("jarvis.subprocess.Popen") as popen:
            result = jarvis.create_command_router(self.config).route("close netflix")

        self.assertTrue(result.success)
        close.assert_called_once_with(16125526, label="Netflix")
        popen.assert_not_called()

    def test_close_claude_targets_visible_desktop_process_only(self) -> None:
        windows = [
            jarvis.DesktopWindow(10, "python.exe", "Claude CLI", 2_000_000),
            jarvis.DesktopWindow(
                11,
                "claude.exe",
                "Claude",
                1_000_000,
                class_name="Chrome_WidgetWin_1",
                visible=True,
            ),
        ]
        with patch(
            "jarvis._visible_top_level_windows_win32", return_value=windows
        ), patch(
            "jarvis._request_claude_window_close_win32", return_value=True
        ) as close:
            result = jarvis.create_command_router(self.config).route("close claude")

        self.assertTrue(result.success)
        close.assert_called_once_with(windows[1])

    def test_claude_close_succeeds_when_same_hwnd_becomes_invisible(self) -> None:
        visible = jarvis.DesktopWindow(
            11,
            "claude.exe",
            "Claude",
            1_000_000,
            pid=500,
            class_name="Chrome_WidgetWin_1",
            visible=True,
        )
        user32 = Mock()
        user32.PostMessageW.return_value = 1
        with patch.object(ctypes.windll, "user32", user32), patch(
            "jarvis._claude_desktop_windows_win32",
            side_effect=[[visible], [], [], []],
        ), patch("jarvis._window_exists_win32") as exists, patch(
            "jarvis.time.sleep"
        ), self.assertLogs(
            "clap_listen", level="INFO"
        ) as captured:
            closed = jarvis._request_claude_window_close_win32(
                visible,
                timeout=0.4,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(closed)
        user32.PostMessageW.assert_called_once_with(11, 0x0010, 0, 0)
        exists.assert_not_called()
        self.assertIn(
            "Claude close verified: no visible Claude Desktop window",
            "\n".join(captured.output),
        )

    def test_background_claude_process_does_not_affect_close_success(self) -> None:
        visible = jarvis.DesktopWindow(
            11,
            "claude.exe",
            "Claude",
            1_000_000,
            pid=500,
            class_name="Chrome_WidgetWin_1",
            visible=True,
        )
        user32 = Mock()
        user32.PostMessageW.return_value = 1
        with patch.object(ctypes.windll, "user32", user32), patch(
            "jarvis._claude_desktop_windows_win32", return_value=[]
        ), patch("jarvis._window_exists_win32") as exists, patch(
            "jarvis.subprocess.run"
        ) as process_action, patch("jarvis.time.sleep"):
            closed = jarvis._request_claude_window_close_win32(
                visible,
                timeout=0.3,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(closed)
        exists.assert_not_called()
        process_action.assert_not_called()

    def test_replacement_visible_claude_window_prevents_success(self) -> None:
        original = jarvis.DesktopWindow(
            11,
            "claude.exe",
            "Claude",
            1_000_000,
            visible=True,
        )
        replacement = jarvis.DesktopWindow(
            12,
            "claude.exe",
            "Claude",
            1_000_000,
            visible=True,
        )
        user32 = Mock()
        user32.PostMessageW.return_value = 1
        with patch.object(ctypes.windll, "user32", user32), patch(
            "jarvis._claude_desktop_windows_win32",
            return_value=[replacement],
        ) as windows, patch("jarvis.time.sleep"), self.assertLogs(
            "clap_listen", level="WARNING"
        ):
            closed = jarvis._request_claude_window_close_win32(
                original,
                timeout=0.2,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertFalse(closed)
        self.assertEqual(windows.call_count, 3)

    def test_claude_close_stability_resets_if_window_reappears(self) -> None:
        original = jarvis.DesktopWindow(
            11,
            "claude.exe",
            "Claude",
            1_000_000,
            visible=True,
        )
        replacement = jarvis.DesktopWindow(
            12,
            "claude.exe",
            "Claude",
            1_000_000,
            visible=True,
        )
        user32 = Mock()
        user32.PostMessageW.return_value = 1
        with patch.object(ctypes.windll, "user32", user32), patch(
            "jarvis._claude_desktop_windows_win32",
            side_effect=[[], [], [replacement], [], [], []],
        ), patch("jarvis.time.sleep"):
            closed = jarvis._request_claude_window_close_win32(
                original,
                timeout=0.5,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(closed)

    def test_window_close_uses_wm_close_and_verifies_window_disappears(self) -> None:
        user32 = Mock()
        user32.PostMessageW.return_value = 1
        with patch.object(ctypes.windll, "user32", user32), patch(
            "jarvis._window_exists_win32", side_effect=[True, False]
        ), patch("jarvis.time.sleep"):
            closed = jarvis._request_window_close_win32(
                77,
                label="Test app",
                timeout=0.3,
                poll_s=0.15,
            )

        self.assertTrue(closed)
        user32.PostMessageW.assert_called_once_with(77, 0x0010, 0, 0)

    def test_minimize_spotify_reuses_final_state_enforcement(self) -> None:
        with patch(
            "jarvis._enforce_spotify_minimized_final", return_value=True
        ) as minimize:
            result = jarvis.create_command_router(self.config).route(
                "hide spotify"
            )

        self.assertTrue(result.success)
        self.assertEqual(result.command, "minimize_spotify")
        minimize.assert_called_once_with()

    def test_time_command_returns_injected_local_time(self) -> None:
        router = jarvis.create_command_router(
            self.config,
            now_provider=lambda: datetime(2026, 8, 26, 14, 7),
        )

        result = router.route("tell me the time")

        self.assertTrue(result.success)
        self.assertEqual(result.command, "local_time")
        self.assertEqual(result.message, "The local time is 14:07.")

    def test_unknown_command_is_rejected_without_process_or_shell_action(self) -> None:
        with patch("jarvis.subprocess.Popen") as popen, patch(
            "jarvis._open_registered_uri"
        ) as uri, patch("jarvis._show_window_win32") as window_action:
            result = jarvis.create_command_router(self.config).route(
                "order me dinner"
            )

        self.assertFalse(result.success)
        self.assertFalse(result.recognized)
        self.assertIsNone(result.command)
        popen.assert_not_called()
        uri.assert_not_called()
        window_action.assert_not_called()

    def test_handler_failure_returns_result_and_router_remains_usable(self) -> None:
        handler = Mock(side_effect=[RuntimeError("temporary failure"), "Recovered."])
        router = CommandRouter(
            (CommandDefinition("test", ("run test",), handler),)
        )

        failed = router.route("run test")
        recovered = router.route("run test")

        self.assertFalse(failed.success)
        self.assertIn("temporary failure", failed.message)
        self.assertTrue(recovered.success)
        self.assertEqual(recovered.message, "Recovered.")

    def test_dry_run_resolves_without_executing_action(self) -> None:
        with patch("jarvis.open_netflix") as action:
            result = jarvis.create_command_router(self.config).route(
                "open netflix",
                dry_run=True,
            )

        self.assertTrue(result.success)
        self.assertEqual(result.command, "open_netflix")
        action.assert_not_called()


class CommandCliTests(unittest.TestCase):
    def test_cli_command_uses_production_router_and_bypasses_microphone(self) -> None:
        config = command_config()
        with patch("jarvis.open_claude") as action, patch(
            "jarvis._choose_input_device"
        ) as choose_input, patch("builtins.print") as output:
            exit_code = jarvis.main(["--command", "open claude"], config=config)

        self.assertEqual(exit_code, 0)
        action.assert_called_once_with(config)
        choose_input.assert_not_called()
        output.assert_called_once_with("Claude Desktop opened.")

    def test_cli_unknown_command_executes_no_action_and_exits_nonzero(self) -> None:
        with patch("jarvis._choose_input_device") as choose_input, patch(
            "jarvis.subprocess.Popen"
        ) as popen, patch("builtins.print"):
            exit_code = jarvis.main(
                ["--command", "do something arbitrary"],
                config=command_config(),
            )

        self.assertEqual(exit_code, 1)
        choose_input.assert_not_called()
        popen.assert_not_called()

    def test_debug_audio_and_command_modes_conflict(self) -> None:
        with self.assertRaises(SystemExit):
            jarvis._parse_args(
                ["--debug-audio", "--command", "open netflix"]
            )

    def test_listen_command_conflicts_with_other_execution_modes(self) -> None:
        for arguments in (
            ["--debug-audio", "--listen-command"],
            ["--command", "open netflix", "--listen-command"],
        ):
            with self.subTest(arguments=arguments):
                with self.assertRaises(SystemExit):
                    jarvis._parse_args(arguments)

    def test_listen_command_accepts_dry_run(self) -> None:
        args = jarvis._parse_args(["--listen-command", "--dry-run"])

        self.assertTrue(args.listen_command)
        self.assertTrue(args.dry_run)

    def test_dry_run_requires_command(self) -> None:
        with self.assertRaises(SystemExit):
            jarvis._parse_args(["--dry-run"])


if __name__ == "__main__":
    unittest.main()
