import unittest
from unittest.mock import Mock, call, patch

import jarvis
from config import load_config


def lifecycle_config():
    return load_config(
        {
            "OPEN_SPOTIFY": "true",
            "SONG_URI": "spotify:track:test",
            "SPOTIFY_MINIMIZE": "true",
            "OPEN_CLAUDE": "true",
            "CLAUDE_URL": "claude://claude.ai/new",
            "CLAUDE_MONITOR": "2",
            "CLAUDE_MAXIMIZE": "true",
            "OPEN_NETFLIX": "false",
            "FOCUS_CURSOR": "false",
            "ENABLE_ELEVENLABS": "false",
        }
    )


def spotify_window(
    *,
    hwnd=50,
    rect=(200, 100, 1200, 800),
    visible=True,
    iconic=False,
):
    return jarvis.DesktopWindow(
        hwnd,
        "spotify.exe",
        "Spotify Premium",
        700_000,
        pid=500,
        class_name="Chrome_WidgetWin_1",
        rect=rect,
        visible=visible,
        iconic=iconic,
        owner_hwnd=0,
    )


def claude_window(
    *,
    hwnd=70,
    process="claude.exe",
    title="Claude",
    class_name="Chrome_WidgetWin_1",
    visible=True,
    iconic=False,
    zoomed=True,
    owner=0,
    rect=(0, 0, 1400, 900),
):
    return jarvis.DesktopWindow(
        hwnd,
        process,
        title,
        900_000,
        pid=700,
        class_name=class_name,
        rect=rect,
        visible=visible,
        iconic=iconic,
        zoomed=zoomed,
        owner_hwnd=owner,
    )


class SpotifyForegroundLifecycleTests(unittest.TestCase):
    @patch.object(jarvis.sys, "platform", "win32")
    def test_hidden_spotify_frame_is_available_to_foreground_restore(self) -> None:
        hidden = spotify_window(visible=False, iconic=False)
        unrelated = jarvis.DesktopWindow(
            51,
            "chrome.exe",
            "Spotify - Web Player",
            2_000_000,
            class_name="Chrome_WidgetWin_1",
            visible=True,
            owner_hwnd=0,
        )
        with patch(
            "jarvis._visible_top_level_windows_win32",
            return_value=[hidden, unrelated],
        ) as enumerate_windows:
            selected = jarvis._best_spotify_main_window_win32()

        self.assertEqual(selected, hidden)
        enumerate_windows.assert_called_once_with(include_hidden=True)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_minimized_spotify_is_restored_without_redispatching_song(self) -> None:
        minimized = spotify_window(iconic=True)
        restored = spotify_window(iconic=False)
        with patch(
            "jarvis._best_spotify_main_window_win32", return_value=minimized
        ), patch(
            "jarvis._spotify_main_windows_win32", return_value=[restored]
        ), patch(
            "jarvis._window_rect_win32", return_value=restored.rect
        ), patch(
            "jarvis._rect_intersects_available_monitor_win32", return_value=True
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=False
        ), patch(
            "jarvis._activate_window_win32", return_value=True
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch("jarvis._show_window_win32") as show, patch(
            "jarvis._open_registered_uri"
        ) as dispatch, patch("jarvis.time.sleep"):
            jarvis.show_spotify_window(
                lifecycle_config(), timeout=0.3, poll_s=0.1, stable_polls=3
            )

        show.assert_any_call(50, 9)
        dispatch.assert_not_called()

    @patch.object(jarvis.sys, "platform", "win32")
    def test_offscreen_spotify_is_moved_to_primary_monitor_and_restored(self) -> None:
        offscreen = spotify_window(rect=(-32000, -32000, -31200, -31400))
        restored = spotify_window(rect=(100, 100, 900, 700))
        monitors = [(-1920, 0, 0, 1080), (0, 0, 1920, 1080)]
        with patch(
            "jarvis._best_spotify_main_window_win32", return_value=offscreen
        ), patch(
            "jarvis._spotify_main_windows_win32", return_value=[restored]
        ), patch(
            "jarvis._window_rect_win32",
            side_effect=[offscreen.rect, restored.rect, restored.rect, restored.rect],
        ), patch(
            "jarvis._win32_sorted_monitor_rects", return_value=monitors
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=False
        ), patch(
            "jarvis._activate_window_win32", return_value=True
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch(
            "jarvis._move_window_to_monitor_win32", return_value=True
        ) as move, patch("jarvis._show_window_win32"), patch("jarvis.time.sleep"):
            jarvis.show_spotify_window(
                lifecycle_config(), timeout=0.3, poll_s=0.1, stable_polls=3
            )

        move.assert_called_once_with(50, 2, label="Spotify", maximize=False)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_absent_spotify_launches_desktop_without_dispatching_song_uri(self) -> None:
        restored = spotify_window()
        with patch(
            "jarvis._best_spotify_main_window_win32", return_value=None
        ), patch(
            "jarvis._wait_for_spotify_main_window_win32", return_value=restored
        ), patch(
            "jarvis._spotify_main_windows_win32", return_value=[restored]
        ), patch(
            "jarvis._window_rect_win32", return_value=restored.rect
        ), patch(
            "jarvis._rect_intersects_available_monitor_win32", return_value=True
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=False
        ), patch(
            "jarvis._activate_window_win32", return_value=True
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch("jarvis._show_window_win32"), patch(
            "jarvis._open_registered_uri"
        ) as dispatch, patch("jarvis.play_song") as song, patch("jarvis.time.sleep"):
            jarvis.show_spotify_window(
                lifecycle_config(), timeout=0.3, poll_s=0.1, stable_polls=3
            )

        dispatch.assert_called_once_with("spotify:", label="Spotify Desktop URI")
        song.assert_not_called()

    def test_minimize_and_show_commands_are_reversible_across_cycles(self) -> None:
        router = jarvis.create_command_router(lifecycle_config())
        with patch(
            "jarvis._enforce_spotify_minimized_final", return_value=True
        ) as minimize, patch("jarvis.show_spotify_window") as show:
            results = [
                router.route("minimize spotify"),
                router.route("open spotify"),
                router.route("minimize spotify"),
                router.route("show spotify"),
            ]

        self.assertTrue(all(result.success for result in results))
        self.assertEqual(minimize.call_count, 2)
        self.assertEqual(show.call_count, 2)

    def test_play_spotify_retains_uri_and_configured_minimization(self) -> None:
        config = lifecycle_config()
        with patch("jarvis.play_song") as song, patch(
            "jarvis._current_app_hwnds", return_value={50}
        ), patch("jarvis._minimize_desktop_window", return_value=True) as minimize:
            with patch(
                "jarvis._enforce_spotify_minimized_final", return_value=True
            ) as final_minimize, patch("jarvis.time.sleep") as settle:
                result = jarvis.create_command_router(config).route("play spotify")

        self.assertTrue(result.success)
        self.assertEqual(result.command, "play_spotify")
        song.assert_called_once_with(config.song_uri)
        minimize.assert_called_once()
        settle.assert_called_once_with(jarvis.SPOTIFY_PLAY_SETTLE_S)
        final_minimize.assert_called_once_with()

    def test_play_spotify_settles_before_final_minimize_verification(self) -> None:
        lifecycle = []
        config = lifecycle_config()
        with patch(
            "jarvis.open_spotify",
            side_effect=lambda _config: lifecycle.append("uri_dispatched"),
        ), patch(
            "jarvis.time.sleep",
            side_effect=lambda _seconds: lifecycle.append("settled"),
        ), patch(
            "jarvis._enforce_spotify_minimized_final",
            side_effect=lambda: lifecycle.append("final_verified") or True,
        ):
            result = jarvis.create_command_router(config).route("play spotify")

        self.assertTrue(result.success)
        self.assertEqual(
            lifecycle,
            ["uri_dispatched", "settled", "final_verified"],
        )


class ClaudeOpenLifecycleTests(unittest.TestCase):
    def test_claude_matcher_accepts_only_desktop_frame(self) -> None:
        desktop = claude_window()
        cli = claude_window(process="python.exe", title="Claude CLI")
        helper = claude_window(class_name="#32770")
        owned = claude_window(owner=99)

        self.assertTrue(jarvis._is_claude_desktop_window(desktop))
        self.assertFalse(jarvis._is_claude_desktop_window(cli))
        self.assertFalse(jarvis._is_claude_desktop_window(helper))
        self.assertFalse(jarvis._is_claude_desktop_window(owned))

    @patch.object(jarvis.sys, "platform", "win32")
    def test_hidden_existing_claude_frame_dispatches_uri_and_reacquires(self) -> None:
        hidden = claude_window(visible=False, zoomed=True)
        reactivated = claude_window(visible=True, zoomed=False)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32", return_value=hidden
        ) as find, patch(
            "jarvis._wait_for_claude_desktop_window_win32",
            return_value=reactivated,
        ) as wait, patch(
            "jarvis._apply_claude_desktop_open_state"
        ) as apply_state, patch(
            "jarvis._verify_claude_desktop_open_state", return_value=True
        ) as verify, patch("jarvis._open_registered_uri") as dispatch:
            jarvis._open_claude_desktop_verified(config)

        find.assert_called_once_with(include_hidden=True)
        dispatch.assert_called_once_with(
            config.claude_url, label="Claude Desktop URI"
        )
        wait.assert_called_once_with(preferred_hwnd=70, require_presented=True)
        apply_state.assert_called_once_with(reactivated, config)
        verify.assert_called_once_with(config, preferred_hwnd=70)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_hidden_claude_can_reacquire_replacement_after_uri(self) -> None:
        hidden = claude_window(hwnd=70, visible=False)
        replacement = claude_window(hwnd=71, visible=True)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32", return_value=hidden
        ), patch(
            "jarvis._wait_for_claude_desktop_window_win32",
            return_value=replacement,
        ) as wait, patch(
            "jarvis._apply_claude_desktop_open_state"
        ) as apply_state, patch(
            "jarvis._verify_claude_desktop_open_state", return_value=True
        ) as verify, patch("jarvis._open_registered_uri"):
            jarvis._open_claude_desktop_verified(config)

        wait.assert_called_once_with(preferred_hwnd=70, require_presented=True)
        apply_state.assert_called_once_with(replacement, config)
        verify.assert_called_once_with(config, preferred_hwnd=71)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_hidden_claude_is_not_accepted_when_uri_does_not_present_a_frame(
        self,
    ) -> None:
        hidden = claude_window(visible=False)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32", return_value=hidden
        ), patch(
            "jarvis._wait_for_claude_desktop_window_win32", return_value=None
        ), patch("jarvis._open_registered_uri") as dispatch, patch(
            "jarvis._apply_claude_desktop_open_state"
        ) as apply_state:
            with self.assertRaisesRegex(RuntimeError, "window was not found"):
                jarvis._open_claude_desktop_verified(config)

        dispatch.assert_called_once()
        apply_state.assert_not_called()

    @patch.object(jarvis.sys, "platform", "win32")
    def test_absent_claude_dispatches_uri_and_waits_for_strict_frame(self) -> None:
        frame = claude_window()
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32", return_value=None
        ), patch(
            "jarvis._wait_for_claude_desktop_window_win32", return_value=frame
        ) as wait, patch(
            "jarvis._apply_claude_desktop_open_state"
        ), patch(
            "jarvis._verify_claude_desktop_open_state", return_value=True
        ), patch("jarvis._open_registered_uri") as dispatch:
            jarvis._open_claude_desktop_verified(config)

        dispatch.assert_called_once_with(
            config.claude_url, label="Claude Desktop URI"
        )
        wait.assert_called_once_with(require_presented=True)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_visible_claude_is_reused_without_uri_dispatch(self) -> None:
        frame = claude_window(visible=True, iconic=False)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32", return_value=frame
        ), patch(
            "jarvis._claude_window_is_cloaked_win32", return_value=False
        ), patch("jarvis._apply_claude_desktop_open_state") as apply_state, patch(
            "jarvis._verify_claude_desktop_open_state", return_value=True
        ), patch("jarvis._open_registered_uri") as dispatch:
            jarvis._open_claude_desktop_verified(config)

        dispatch.assert_not_called()
        apply_state.assert_called_once_with(frame, config)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_cloaked_claude_dispatches_uri_instead_of_reusing_frame(self) -> None:
        frame = claude_window(visible=True, iconic=False)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32", return_value=frame
        ), patch(
            "jarvis._claude_window_is_cloaked_win32", return_value=True
        ), patch(
            "jarvis._wait_for_claude_desktop_window_win32", return_value=None
        ), patch("jarvis._open_registered_uri") as dispatch:
            with self.assertRaises(RuntimeError):
                jarvis._open_claude_desktop_verified(config)

        dispatch.assert_called_once_with(
            config.claude_url, label="Claude Desktop URI"
        )

    def test_hidden_claude_is_restored_then_maximized_on_existing_monitor(self) -> None:
        hidden = claude_window(visible=False, zoomed=True)
        config = lifecycle_config()
        manager = Mock()
        with patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch("jarvis._show_window_win32") as show, patch(
            "jarvis._maximize_window_win32", return_value=True
        ) as maximize, patch(
            "jarvis._activate_window_win32", return_value=True
        ):
            manager.attach_mock(show, "show")
            manager.attach_mock(maximize, "maximize")
            jarvis._apply_claude_desktop_open_state(hidden, config)

        self.assertEqual(
            manager.mock_calls,
            [call.show(70, 9), call.maximize(70, label="Claude")],
        )

    def test_visible_claude_on_target_monitor_is_reused_and_verified(self) -> None:
        frame = claude_window(visible=True, zoomed=True)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_windows_win32", return_value=[frame]
        ), patch(
            "jarvis._claude_window_is_visible_win32", return_value=True
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=False
        ), patch(
            "jarvis._claude_window_is_cloaked_win32", return_value=False
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch(
            "jarvis._window_is_maximized_win32", return_value=True
        ), patch(
            "jarvis._claude_window_rect_matches_monitor_win32", return_value=True
        ), patch("jarvis.time.sleep"):
            verified = jarvis._verify_claude_desktop_open_state(
                config,
                preferred_hwnd=70,
                timeout=0.3,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(verified)

    def test_claude_verification_requires_visible_target_monitor_and_maximized(
        self,
    ) -> None:
        config = lifecycle_config()
        cases = (
            (False, False, False, 2, True, True),
            (True, True, False, 2, True, True),
            (True, False, True, 2, True, True),
            (True, False, False, 1, True, True),
            (True, False, False, 2, False, True),
            (True, False, False, 2, True, False),
        )
        for visible, iconic, cloaked, monitor, maximized, rect_ok in cases:
            frame = claude_window(visible=visible, iconic=iconic, zoomed=maximized)
            with self.subTest(
                visible=visible,
                iconic=iconic,
                cloaked=cloaked,
                monitor=monitor,
                maximized=maximized,
                rect_ok=rect_ok,
            ):
                with patch(
                    "jarvis._claude_desktop_windows_win32", return_value=[frame]
                ), patch(
                    "jarvis._claude_window_is_visible_win32",
                    return_value=visible,
                ), patch(
                    "jarvis._window_is_minimized_win32", return_value=iconic
                ), patch(
                    "jarvis._claude_window_is_cloaked_win32",
                    return_value=cloaked,
                ), patch(
                    "jarvis._monitor_number_for_window_win32", return_value=monitor
                ), patch(
                    "jarvis._window_is_maximized_win32", return_value=maximized
                ), patch(
                    "jarvis._claude_window_rect_matches_monitor_win32",
                    return_value=rect_ok,
                ), patch("jarvis._show_window_win32"), patch(
                    "jarvis._move_window_to_monitor_win32", return_value=True
                ), patch(
                    "jarvis._activate_window_win32", return_value=True
                ), patch("jarvis.time.sleep"):
                    verified = jarvis._verify_claude_desktop_open_state(
                        config,
                        preferred_hwnd=70,
                        timeout=0.2,
                        poll_s=0.1,
                        stable_polls=2,
                    )

                self.assertFalse(verified)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_visible_replacement_is_preferred_over_stale_hidden_hwnd(self) -> None:
        hidden = claude_window(hwnd=70, visible=False)
        replacement = claude_window(hwnd=71, visible=True)
        with patch("jarvis._claude_window_is_cloaked_win32", return_value=False):
            selected = jarvis._best_claude_desktop_window_win32(
                [hidden, replacement],
                preferred_hwnd=70,
            )

        self.assertEqual(selected.hwnd, 71)

    def test_same_hwnd_with_reactivated_state_can_be_reacquired(self) -> None:
        hidden = claude_window(hwnd=70, visible=False)
        active = claude_window(hwnd=70, visible=True)
        with patch(
            "jarvis._claude_desktop_windows_win32",
            side_effect=[[hidden], [active]],
        ), patch(
            "jarvis._claude_window_is_cloaked_win32", return_value=False
        ), patch("jarvis.time.sleep"):
            selected = jarvis._wait_for_claude_desktop_window_win32(
                preferred_hwnd=70,
                require_presented=True,
                timeout=0.2,
            )

        self.assertEqual(selected.hwnd, 70)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_repeated_hidden_claude_reopen_dispatches_uri_each_time(self) -> None:
        hidden = claude_window(visible=False)
        active = claude_window(visible=True)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32", return_value=hidden
        ), patch(
            "jarvis._wait_for_claude_desktop_window_win32", return_value=active
        ), patch("jarvis._apply_claude_desktop_open_state") as apply_state, patch(
            "jarvis._verify_claude_desktop_open_state", return_value=True
        ), patch("jarvis._open_registered_uri") as dispatch:
            jarvis._open_claude_desktop_verified(config)
            jarvis._open_claude_desktop_verified(config)

        self.assertEqual(apply_state.call_count, 2)
        self.assertEqual(dispatch.call_count, 2)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_repeated_close_open_cycles_keep_safe_close_and_uri_reactivation(
        self,
    ) -> None:
        visible = claude_window(visible=True)
        hidden = claude_window(visible=False)
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_window_win32",
            side_effect=[visible, hidden, visible, hidden],
        ), patch(
            "jarvis._request_claude_window_close_win32", return_value=True
        ) as close, patch(
            "jarvis._wait_for_claude_desktop_window_win32", return_value=visible
        ), patch(
            "jarvis._apply_claude_desktop_open_state"
        ), patch(
            "jarvis._verify_claude_desktop_open_state", return_value=True
        ), patch("jarvis._open_registered_uri") as dispatch:
            for _ in range(2):
                jarvis.close_claude_desktop_window()
                jarvis._open_claude_desktop_verified(config)

        self.assertEqual(close.call_args_list, [call(visible), call(visible)])
        self.assertEqual(dispatch.call_count, 2)

    def test_claude_verification_requires_three_stable_polls(self) -> None:
        frame = claude_window()
        config = lifecycle_config()
        with patch(
            "jarvis._claude_desktop_windows_win32", return_value=[frame]
        ) as enumerate_windows, patch(
            "jarvis._claude_window_is_visible_win32", return_value=True
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=False
        ), patch(
            "jarvis._claude_window_is_cloaked_win32", return_value=False
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch(
            "jarvis._window_is_maximized_win32", return_value=True
        ), patch(
            "jarvis._claude_window_rect_matches_monitor_win32", return_value=True
        ), patch("jarvis.time.sleep"):
            verified = jarvis._verify_claude_desktop_open_state(
                config,
                preferred_hwnd=70,
                timeout=0.3,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(verified)
        self.assertEqual(enumerate_windows.call_count, 3)

    def test_claude_open_verification_failure_is_bounded(self) -> None:
        frame = claude_window(visible=False)
        with patch(
            "jarvis._claude_desktop_windows_win32", return_value=[frame]
        ) as enumerate_windows, patch(
            "jarvis._claude_window_is_visible_win32", return_value=False
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=False
        ), patch(
            "jarvis._claude_window_is_cloaked_win32", return_value=False
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch(
            "jarvis._window_is_maximized_win32", return_value=True
        ), patch(
            "jarvis._claude_window_rect_matches_monitor_win32", return_value=True
        ), patch("jarvis._show_window_win32"), patch(
            "jarvis._activate_window_win32", return_value=True
        ), patch("jarvis.time.sleep"):
            verified = jarvis._verify_claude_desktop_open_state(
                lifecycle_config(),
                preferred_hwnd=70,
                timeout=0.2,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertFalse(verified)
        self.assertEqual(enumerate_windows.call_count, 3)

    def test_claude_open_verification_failure_is_structured_by_router(self) -> None:
        config = lifecycle_config()
        with patch(
            "jarvis.open_claude",
            side_effect=RuntimeError("Claude Desktop open state could not be verified"),
        ):
            result = jarvis.create_command_router(config).route("open claude")

        self.assertFalse(result.success)
        self.assertEqual(result.command, "open_claude")
        self.assertIn("could not be verified", result.message)


if __name__ == "__main__":
    unittest.main()
