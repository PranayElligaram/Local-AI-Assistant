import unittest
from unittest.mock import Mock, call, patch

import jarvis
from config import load_config


def action_config(**overrides: str):
    env = {
        "OPEN_SPOTIFY": "true",
        "SONG_URI": "https://open.spotify.com/track/test",
        "OPEN_CLAUDE": "true",
        "FOCUS_CURSOR": "true",
        "ENABLE_ELEVENLABS": "false",
        "OPEN_BINANCE": "false",
    }
    env.update(overrides)
    return load_config(env)


class DesktopRoutingTests(unittest.TestCase):
    @patch.object(jarvis.sys, "platform", "win32")
    def test_spotify_desktop_uri_uses_windows_registered_handler(self) -> None:
        uri = "spotify:track:08mG3Y1vljYA6bvDt4Wqkj"
        with patch.object(jarvis.os, "startfile", create=True) as startfile:
            jarvis.play_song(uri)

        startfile.assert_called_once_with(uri)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_spotify_https_url_remains_compatible(self) -> None:
        url = "https://open.spotify.com/track/08mG3Y1vljYA6bvDt4Wqkj"
        with patch.object(jarvis.os, "startfile", create=True) as startfile:
            jarvis.play_song(url)

        startfile.assert_called_once_with(url)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_claude_desktop_uri_uses_windows_registered_handler(self) -> None:
        config = action_config(
            CLAUDE_URL="claude://claude.ai/new",
            FOCUS_CURSOR="false",
        )
        with patch("jarvis._open_claude_desktop_verified") as desktop:
            jarvis.open_claude(config)

        desktop.assert_called_once_with(config)

    def test_claude_desktop_mode_bypasses_all_chrome_logic(self) -> None:
        config = action_config(
            CLAUDE_URL="claude://claude.ai/new",
            FOCUS_CURSOR="false",
        )
        with patch("jarvis._open_claude_desktop_verified") as desktop, patch(
            "jarvis._open_registered_uri"
        ) as dispatch, patch(
            "jarvis.open_claude_in_chrome"
        ) as browser, patch("jarvis._chrome_monitor_top_left") as position, patch(
            "jarvis._chrome_monitor_pixel_size"
        ) as size, patch("jarvis._wait_new_chrome_hwnd_win32") as wait:
            jarvis.open_claude(config)

        desktop.assert_called_once_with(config)
        dispatch.assert_not_called()
        browser.assert_not_called()
        position.assert_not_called()
        size.assert_not_called()
        wait.assert_not_called()

    def test_claude_https_uses_existing_browser_mode(self) -> None:
        config = action_config(CLAUDE_URL="https://claude.ai/new")
        with patch("jarvis.open_claude_in_chrome") as browser, patch(
            "jarvis._open_registered_uri"
        ) as dispatch:
            jarvis.open_claude(config)

        browser.assert_called_once_with(config)
        dispatch.assert_not_called()


class MonitorPlacementTests(unittest.TestCase):
    def test_spotify_window_matching_uses_visible_owner_process(self) -> None:
        windows = [
            jarvis.DesktopWindow(
                10,
                "spotify.exe",
                "Spotify Premium",
                500_000,
                class_name="Chrome_WidgetWin_1",
            ),
            jarvis.DesktopWindow(
                13,
                "spotify.exe",
                "Spotify",
                600_000,
                class_name="#32770",
            ),
            jarvis.DesktopWindow(11, "spotifylauncher.exe", "", 600_000),
            jarvis.DesktopWindow(12, "chrome.exe", "Spotify - Web Player", 700_000),
        ]
        with patch("jarvis._visible_top_level_windows_win32", return_value=windows):
            matches = jarvis._matching_app_windows_win32(
                process_names=("spotify.exe",),
                class_names=("Chrome_WidgetWin_1",),
            )

        self.assertEqual([window.hwnd for window in matches], [10])

    def test_netflix_title_fallback_is_limited_to_packaged_window_hosts(self) -> None:
        windows = [
            jarvis.DesktopWindow(20, "applicationframehost.exe", "Netflix", 500_000),
            jarvis.DesktopWindow(21, "chrome.exe", "Netflix", 700_000),
        ]
        with patch("jarvis._visible_top_level_windows_win32", return_value=windows):
            matches = jarvis._matching_app_windows_win32(
                process_names=("netflix.exe",),
                title_tokens=("netflix",),
                title_process_names=(
                    "applicationframehost.exe",
                    "msedgewebview2.exe",
                ),
            )

        self.assertEqual([window.hwnd for window in matches], [20])

    def test_spotify_launch_is_followed_by_window_placement(self) -> None:
        config = action_config(SPOTIFY_MONITOR="2")
        with patch("jarvis._current_app_hwnds", return_value={10}) as current, patch(
            "jarvis.play_song"
        ) as launch, patch("jarvis._place_desktop_window", return_value=True) as place:
            jarvis.open_spotify(config)

        current.assert_called_once_with(
            process_names=("spotify.exe",),
            class_names=("Chrome_WidgetWin_1",),
        )
        launch.assert_called_once_with(config.song_uri)
        place.assert_called_once_with(
            label="Spotify",
            monitor=2,
            process_names=("spotify.exe",),
            previous_hwnds={10},
            class_names=("Chrome_WidgetWin_1",),
        )

    def test_spotify_uri_dispatch_precedes_minimization(self) -> None:
        config = action_config(SPOTIFY_MINIMIZE="true", SPOTIFY_MONITOR="")
        manager = Mock()
        with patch("jarvis._current_app_hwnds", return_value={10}), patch(
            "jarvis.play_song"
        ) as launch, patch("jarvis._minimize_desktop_window", return_value=True) as minimize:
            manager.attach_mock(launch, "launch")
            manager.attach_mock(minimize, "minimize")
            jarvis.open_spotify(config)

        self.assertEqual(
            manager.mock_calls,
            [
                call.launch(config.song_uri),
                call.minimize(
                    label="Spotify",
                    process_names=("spotify.exe",),
                    previous_hwnds={10},
                    class_names=("Chrome_WidgetWin_1",),
                ),
            ],
        )

    def test_spotify_minimization_uses_located_top_level_window(self) -> None:
        with patch("jarvis._wait_for_app_window_win32", return_value=4321) as wait, patch(
            "jarvis._minimize_window_win32", return_value=True
        ) as minimize:
            minimized = jarvis._minimize_desktop_window(
                label="Spotify",
                process_names=("spotify.exe",),
                previous_hwnds={10},
                class_names=("Chrome_WidgetWin_1",),
            )

        self.assertTrue(minimized)
        wait.assert_called_once_with(
            process_names=("spotify.exe",),
            previous_hwnds={10},
            class_names=("Chrome_WidgetWin_1",),
        )
        minimize.assert_called_once_with(4321, label="Spotify")

    def test_spotify_minimize_never_restores_or_maximizes(self) -> None:
        with patch("jarvis._show_window_win32") as show, patch(
            "jarvis._window_is_minimized_win32", return_value=True
        ):
            minimized = jarvis._minimize_window_win32(4321, label="Spotify")

        self.assertTrue(minimized)
        show.assert_called_once_with(4321, 6)

    def test_spotify_minimization_failure_is_non_fatal(self) -> None:
        config = action_config(SPOTIFY_MINIMIZE="true")
        with patch("jarvis._current_app_hwnds", return_value=set()), patch(
            "jarvis.play_song"
        ) as launch, patch("jarvis._minimize_desktop_window", return_value=False):
            jarvis.open_spotify(config)

        launch.assert_called_once_with(config.song_uri)

    def test_spotify_minimize_skips_monitor_placement(self) -> None:
        config = action_config(SPOTIFY_MINIMIZE="true", SPOTIFY_MONITOR="2")
        with patch("jarvis._current_app_hwnds", return_value=set()), patch(
            "jarvis.play_song"
        ), patch("jarvis._minimize_desktop_window", return_value=True), patch(
            "jarvis._place_desktop_window"
        ) as place:
            jarvis.open_spotify(config)

        place.assert_not_called()

    def test_later_actions_do_not_change_spotify_window_state(self) -> None:
        config = action_config(
            SPOTIFY_MINIMIZE="true",
            OPEN_NETFLIX="true",
            FOCUS_CURSOR="false",
        )
        with patch(
            "jarvis._current_app_hwnds", return_value={10}
        ), patch("jarvis.play_song"), patch(
            "jarvis._wait_for_app_window_win32", return_value=4321
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=True
        ), patch("jarvis._show_window_win32") as show, patch(
            "jarvis.open_claude"
        ), patch("jarvis.open_netflix"), patch(
            "jarvis._enforce_spotify_minimized_final", return_value=True
        ) as enforce:
            jarvis.run_double_clap_actions(config)

        show.assert_called_once_with(4321, 6)
        enforce.assert_called_once_with()

    def test_spotify_final_pass_reminimizes_restored_same_hwnd(self) -> None:
        frame = jarvis.DesktopWindow(
            50,
            "spotify.exe",
            "Spotify Premium",
            1_000_000,
            pid=500,
            class_name="Chrome_WidgetWin_1",
        )
        with patch(
            "jarvis._spotify_main_windows_win32", return_value=[frame]
        ), patch(
            "jarvis._window_is_minimized_win32",
            side_effect=[True, False, True, True, True],
        ), patch("jarvis._show_window_win32") as show, patch("jarvis.time.sleep"):
            verified = jarvis._enforce_spotify_minimized_final(
                timeout=0.5,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(verified)
        show.assert_called_once_with(50, 6)

    def test_spotify_final_pass_minimizes_replacement_main_frame(self) -> None:
        original = jarvis.DesktopWindow(
            50,
            "spotify.exe",
            "Spotify Premium",
            1_000_000,
            class_name="Chrome_WidgetWin_1",
        )
        replacement = jarvis.DesktopWindow(
            51,
            "spotify.exe",
            "Spotify Premium",
            1_000_000,
            class_name="Chrome_WidgetWin_1",
        )
        with patch(
            "jarvis._spotify_main_windows_win32",
            side_effect=[
                [original],
                [replacement],
                [replacement],
                [replacement],
                [replacement],
            ],
        ), patch(
            "jarvis._window_is_minimized_win32",
            side_effect=[True, False, True, True, True],
        ), patch("jarvis._show_window_win32") as show, patch("jarvis.time.sleep"):
            verified = jarvis._enforce_spotify_minimized_final(
                timeout=0.5,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(verified)
        show.assert_called_once_with(51, 6)

    def test_spotify_final_success_requires_every_main_frame_iconic(self) -> None:
        first = jarvis.DesktopWindow(
            50,
            "spotify.exe",
            "Spotify Premium",
            1_000_000,
            class_name="Chrome_WidgetWin_1",
        )
        second = jarvis.DesktopWindow(
            51,
            "spotify.exe",
            "Spotify Premium",
            900_000,
            class_name="Chrome_WidgetWin_1",
        )
        with patch(
            "jarvis._spotify_main_windows_win32", return_value=[first, second]
        ), patch(
            "jarvis._window_is_minimized_win32",
            side_effect=[True, False, True, True, True, True, True, True],
        ), patch("jarvis._show_window_win32") as show, patch("jarvis.time.sleep"):
            verified = jarvis._enforce_spotify_minimized_final(
                timeout=0.4,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(verified)
        show.assert_called_once_with(51, 6)

    def test_spotify_final_pass_retry_is_bounded(self) -> None:
        frame = jarvis.DesktopWindow(
            50,
            "spotify.exe",
            "Spotify Premium",
            1_000_000,
            class_name="Chrome_WidgetWin_1",
        )
        with patch(
            "jarvis._spotify_main_windows_win32", return_value=[frame]
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=False
        ), patch("jarvis._show_window_win32") as show, patch(
            "jarvis.time.sleep"
        ), self.assertLogs("clap_listen", level="WARNING"):
            verified = jarvis._enforce_spotify_minimized_final(
                timeout=0.3,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertFalse(verified)
        self.assertLessEqual(show.call_count, 4)

    def test_spotify_final_pass_never_redispatches_uri(self) -> None:
        frame = jarvis.DesktopWindow(
            50,
            "spotify.exe",
            "Spotify Premium",
            1_000_000,
            class_name="Chrome_WidgetWin_1",
        )
        with patch(
            "jarvis._spotify_main_windows_win32", return_value=[frame]
        ), patch(
            "jarvis._window_is_minimized_win32", return_value=True
        ), patch("jarvis.play_song") as dispatch, patch("jarvis.time.sleep"):
            verified = jarvis._enforce_spotify_minimized_final(
                timeout=0.3,
                poll_s=0.1,
                stable_polls=3,
            )

        self.assertTrue(verified)
        dispatch.assert_not_called()

    def test_spotify_launch_remains_successful_when_placement_fails(self) -> None:
        config = action_config(SPOTIFY_MONITOR="2")
        with patch("jarvis._current_app_hwnds", return_value=set()), patch(
            "jarvis.play_song"
        ) as launch, patch("jarvis._place_desktop_window", return_value=False):
            jarvis.open_spotify(config)

        launch.assert_called_once_with(config.song_uri)

    def test_claude_desktop_launch_is_followed_by_window_placement(self) -> None:
        config = action_config(
            CLAUDE_URL="claude://claude.ai/new",
            CLAUDE_MONITOR="1",
        )
        with patch("jarvis._open_claude_desktop_verified") as desktop:
            jarvis.open_claude(config)

        desktop.assert_called_once_with(config)

    def test_claude_moves_then_maximizes(self) -> None:
        self._assert_move_then_maximize(
            "Claude", monitor=2, already_maximized=False
        )

    def test_already_maximized_claude_is_restored_moved_and_remaximized(self) -> None:
        self._assert_move_then_maximize(
            "Claude", monitor=2, already_maximized=True
        )

    def test_netflix_moves_then_maximizes(self) -> None:
        self._assert_move_then_maximize(
            "Netflix", monitor=1, already_maximized=False
        )

    def test_already_maximized_netflix_is_restored_moved_and_remaximized(self) -> None:
        self._assert_move_then_maximize(
            "Netflix", monitor=1, already_maximized=True
        )

    def _assert_move_then_maximize(
        self, label: str, *, monitor: int, already_maximized: bool
    ) -> None:
        manager = Mock()
        with patch(
            "jarvis._monitor_rect_for_placement", return_value=(0, 0, 1920, 1080)
        ), patch("jarvis._window_rect_win32", return_value=(50, 50, 1050, 750)), patch(
            "jarvis._window_is_maximized_win32",
            side_effect=[already_maximized, True],
        ), patch("jarvis._window_is_minimized_win32", return_value=False), patch(
            "jarvis._show_window_win32"
        ) as show, patch("jarvis._set_window_position_win32", return_value=True) as move:
            manager.attach_mock(show, "show")
            manager.attach_mock(move, "move")
            result = jarvis._move_window_to_monitor_win32(
                99,
                monitor,
                label=label,
                maximize=True,
            )

        self.assertTrue(result)
        expected = []
        if already_maximized:
            expected.append(call.show(99, 9))
        expected.extend(
            [
                call.move(99, x=460, y=190, width=1000, height=700),
                call.show(99, 3),
            ]
        )
        self.assertEqual(manager.mock_calls, expected)

    @patch.object(jarvis.sys, "platform", "win32")
    def test_unavailable_monitor_skips_window_wait_without_crashing(self) -> None:
        with patch(
            "jarvis._win32_sorted_monitor_rects", return_value=[(0, 0, 1920, 1080)]
        ), patch("jarvis._wait_for_app_window_win32") as wait:
            with self.assertLogs("clap_listen", level="WARNING") as captured:
                placed = jarvis._place_desktop_window(
                    label="Spotify",
                    monitor=3,
                    process_names=("spotify.exe",),
                )

        self.assertFalse(placed)
        wait.assert_not_called()
        self.assertIn("monitor 3 is unavailable", "\n".join(captured.output))

    @patch.object(jarvis.sys, "platform", "win32")
    def test_unavailable_monitor_can_still_maximize_on_current_monitor(self) -> None:
        with patch(
            "jarvis._win32_sorted_monitor_rects", return_value=[(0, 0, 1920, 1080)]
        ), patch("jarvis._wait_for_app_window_win32", return_value=77), patch(
            "jarvis._maximize_window_win32", return_value=True
        ) as maximize:
            placed = jarvis._place_desktop_window(
                label="Claude",
                monitor=2,
                process_names=("claude.exe",),
                maximize=True,
            )

        self.assertTrue(placed)
        maximize.assert_called_once_with(77, label="Claude")


class NetflixTests(unittest.TestCase):
    @staticmethod
    def _netflix_window(
        hwnd: int,
        *,
        process: str = "applicationframehost.exe",
        class_name: str = "ApplicationFrameWindow",
        title: str = "Netflix",
        zoomed: bool = False,
        visible: bool = True,
        owner_hwnd: int = 0,
    ) -> jarvis.DesktopWindow:
        return jarvis.DesktopWindow(
            hwnd,
            process,
            title,
            1_000_000,
            pid=100 + hwnd,
            class_name=class_name,
            rect=(0, 0, 1200, 800),
            visible=visible,
            zoomed=zoomed,
            owner_hwnd=owner_hwnd,
        )

    def test_edge_hosted_netflix_title_is_valid_candidate(self) -> None:
        window = self._netflix_window(
            41,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            title="Netflix",
        )

        self.assertTrue(jarvis._is_netflix_window(window))

    def test_edge_hosted_netflix_home_title_is_valid_candidate(self) -> None:
        window = self._netflix_window(
            41,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            title="Netflix - Home - Netflix",
        )

        self.assertTrue(jarvis._is_netflix_window(window))

    def test_edge_hosted_netflix_title_match_is_case_insensitive(self) -> None:
        window = self._netflix_window(
            41,
            process="MSEDGE.EXE",
            class_name="CHROME_WIDGETWIN_1",
            title="nEtFlIx - home - NETFLIX",
        )

        self.assertTrue(jarvis._is_netflix_window(window))

    def test_unrelated_edge_window_is_rejected(self) -> None:
        window = self._netflix_window(
            41,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            title="Microsoft Edge",
        )

        self.assertFalse(jarvis._is_netflix_window(window))

    def test_unrelated_chromium_window_is_rejected(self) -> None:
        window = self._netflix_window(
            41,
            process="chrome.exe",
            class_name="Chrome_WidgetWin_1",
            title="Netflix",
        )

        self.assertFalse(jarvis._is_netflix_window(window))

    def test_edge_candidate_must_be_visible_and_ownerless(self) -> None:
        hidden = self._netflix_window(
            41,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            visible=False,
        )
        owned = self._netflix_window(
            42,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            owner_hwnd=99,
        )

        self.assertFalse(jarvis._is_netflix_window(hidden))
        self.assertFalse(jarvis._is_netflix_window(owned))

    def test_netflix_prefers_controlling_application_frame(self) -> None:
        transient = self._netflix_window(
            40,
            process="msedgewebview2.exe",
            class_name="#32770",
        )
        frame = self._netflix_window(41)
        with patch(
            "jarvis._visible_top_level_windows_win32",
            return_value=[transient, frame],
        ):
            selected = jarvis._best_netflix_window_win32(previous_hwnds={41})

        self.assertEqual(selected, frame)

    def test_new_edge_hosted_netflix_window_is_preferred_after_launch(self) -> None:
        existing = self._netflix_window(
            40,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            title="Netflix - Home - Netflix",
        )
        launched = self._netflix_window(
            41,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            title="Netflix",
        )
        with patch(
            "jarvis._netflix_windows_win32",
            return_value=[existing, launched],
        ):
            selected = jarvis._best_netflix_window_win32(previous_hwnds={40})

        self.assertEqual(selected, launched)

    def test_same_hwnd_remains_selected_when_netflix_title_changes(self) -> None:
        initial = self._netflix_window(
            41,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            title="Netflix",
        )
        settled = self._netflix_window(
            41,
            process="msedge.exe",
            class_name="Chrome_WidgetWin_1",
            title="Netflix - Home - Netflix",
        )
        with patch(
            "jarvis._best_netflix_window_win32",
            side_effect=[initial, settled, settled],
        ), patch("jarvis.time.sleep"):
            selected = jarvis._wait_for_stable_netflix_window_win32(
                timeout=1.0,
                stable_polls=3,
            )

        self.assertEqual(selected.hwnd, 41)
        self.assertEqual(selected.title, "Netflix - Home - Netflix")

    def test_transient_netflix_window_is_replaced_before_selection(self) -> None:
        transient = self._netflix_window(40)
        final = self._netflix_window(41)
        with patch(
            "jarvis._best_netflix_window_win32",
            side_effect=[transient, final, final, final],
        ), patch("jarvis.time.sleep"):
            selected = jarvis._wait_for_stable_netflix_window_win32(
                timeout=1.0,
                stable_polls=3,
            )

        self.assertEqual(selected, final)

    def test_netflix_move_occurs_before_maximize_request(self) -> None:
        window = self._netflix_window(41)
        manager = Mock()
        with patch(
            "jarvis._window_is_maximized_win32", return_value=False
        ), patch("jarvis._window_is_minimized_win32", return_value=False), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch(
            "jarvis._move_window_to_monitor_win32", return_value=True
        ) as move, patch("jarvis._show_window_win32") as show:
            manager.attach_mock(move, "move")
            manager.attach_mock(show, "show")
            jarvis._request_netflix_placement_and_maximize(window, monitor=1)

        self.assertEqual(
            manager.mock_calls,
            [
                call.move(41, 1, label="Netflix", maximize=False),
                call.show(41, 3),
            ],
        )

    def test_netflix_already_on_requested_monitor_skips_move(self) -> None:
        window = self._netflix_window(41)
        with patch(
            "jarvis._window_is_maximized_win32", return_value=False
        ), patch("jarvis._window_is_minimized_win32", return_value=False), patch(
            "jarvis._monitor_number_for_window_win32", return_value=1
        ), patch("jarvis._move_window_to_monitor_win32") as move, patch(
            "jarvis._show_window_win32"
        ) as show:
            jarvis._request_netflix_placement_and_maximize(window, monitor=1)

        move.assert_not_called()
        show.assert_called_once_with(41, 3)

    def test_netflix_maximize_is_verified_over_stable_polls(self) -> None:
        window = self._netflix_window(41)
        with patch(
            "jarvis._netflix_windows_win32", return_value=[window]
        ), patch(
            "jarvis._window_is_maximized_win32",
            side_effect=[False, True, True, True],
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=1
        ), patch("jarvis.time.sleep"):
            verified, final = jarvis._verify_netflix_maximized_win32(
                41,
                monitor=1,
                timeout=1.0,
            )

        self.assertTrue(verified)
        self.assertEqual(final, window)

    def test_netflix_verification_requires_requested_monitor(self) -> None:
        window = self._netflix_window(41, zoomed=True)
        with patch(
            "jarvis._netflix_windows_win32", return_value=[window]
        ), patch(
            "jarvis._window_is_maximized_win32", return_value=True
        ), patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ):
            verified, final = jarvis._verify_netflix_maximized_win32(
                41,
                monitor=1,
                timeout=0,
            )

        self.assertFalse(verified)
        self.assertEqual(final, window)

    def test_netflix_reacquires_replacement_and_retries_once(self) -> None:
        transient = self._netflix_window(40)
        final = self._netflix_window(41)
        with patch(
            "jarvis._wait_for_stable_netflix_window_win32",
            side_effect=[transient, final],
        ), patch(
            "jarvis._request_netflix_placement_and_maximize"
        ) as request, patch(
            "jarvis._verify_netflix_maximized_win32",
            side_effect=[(False, final), (True, final)],
        ):
            placed = jarvis._place_and_verify_netflix_window(
                monitor=1,
                previous_hwnds=set(),
            )

        self.assertTrue(placed)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[1], call(final, monitor=1))

    def test_netflix_maximize_retry_is_bounded_and_nonfatal(self) -> None:
        window = self._netflix_window(41)
        with patch(
            "jarvis._wait_for_stable_netflix_window_win32", return_value=window
        ), patch(
            "jarvis._request_netflix_placement_and_maximize"
        ) as request, patch(
            "jarvis._verify_netflix_maximized_win32",
            return_value=(False, window),
        ), self.assertLogs("clap_listen", level="WARNING") as captured:
            placed = jarvis._place_and_verify_netflix_window(
                monitor=1,
                previous_hwnds=set(),
            )

        self.assertFalse(placed)
        self.assertEqual(request.call_count, jarvis.NETFLIX_MAXIMIZE_ATTEMPTS)
        self.assertIn(
            "Netflix maximize could not be verified",
            "\n".join(captured.output),
        )

    @patch.object(jarvis.sys, "platform", "win32")
    def test_netflix_discovery_returns_installed_aumid(self) -> None:
        completed = Mock(
            returncode=0,
            stdout='{"Name":"Netflix","AppID":"Netflix.Package!App"}',
            stderr="",
        )
        with patch("jarvis.shutil.which", return_value="powershell.exe"), patch(
            "jarvis.subprocess.run", return_value=completed
        ):
            aumid = jarvis._discover_netflix_aumid()

        self.assertEqual(aumid, "Netflix.Package!App")

    def test_netflix_not_installed_fails_clearly(self) -> None:
        config = action_config(OPEN_NETFLIX="true")
        with patch(
            "jarvis._discover_netflix_aumid",
            side_effect=FileNotFoundError("installed Netflix app was not found"),
        ), patch("jarvis.subprocess.Popen") as popen:
            with self.assertRaisesRegex(FileNotFoundError, "Netflix app was not found"):
                jarvis.open_netflix(config)

        popen.assert_not_called()

    def test_netflix_launch_is_followed_by_placement(self) -> None:
        config = action_config(OPEN_NETFLIX="true", NETFLIX_MONITOR="3")
        window = self._netflix_window(41)
        with patch(
            "jarvis._discover_netflix_aumid", return_value="Netflix.Package!App"
        ), patch("jarvis._current_netflix_hwnds_win32", return_value={30}), patch(
            "jarvis.shutil.which", return_value=r"C:\Windows\explorer.exe"
        ), patch("jarvis.subprocess.Popen") as popen, patch(
            "jarvis._wait_for_stable_netflix_window_win32", return_value=window
        ) as wait, patch(
            "jarvis._monitor_number_for_window_win32", return_value=2
        ), patch("jarvis._move_window_to_monitor_win32", return_value=True) as move:
            jarvis.open_netflix(config)

        popen.assert_called_once()
        self.assertEqual(
            popen.call_args.args[0],
            [r"C:\Windows\explorer.exe", r"shell:AppsFolder\Netflix.Package!App"],
        )
        wait.assert_called_once_with(previous_hwnds={30})
        move.assert_called_once_with(41, 3, label="Netflix", maximize=False)

    def test_netflix_maximize_failure_does_not_fail_launch_action(self) -> None:
        config = action_config(
            OPEN_NETFLIX="true",
            NETFLIX_MONITOR="1",
            NETFLIX_MAXIMIZE="true",
        )
        with patch(
            "jarvis._discover_netflix_aumid", return_value="Netflix.Package!App"
        ), patch("jarvis._current_netflix_hwnds_win32", return_value=set()), patch(
            "jarvis.shutil.which", return_value=r"C:\Windows\explorer.exe"
        ), patch("jarvis.subprocess.Popen"), patch(
            "jarvis._place_and_verify_netflix_window", return_value=False
        ) as place:
            jarvis.open_netflix(config)

        place.assert_called_once_with(monitor=1, previous_hwnds=set())


class ActionBoundaryTests(unittest.TestCase):
    @patch("jarvis.open_cursor_window")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify")
    def test_all_enabled_synchronous_actions_execute(
        self, open_spotify, open_claude, open_cursor
    ) -> None:
        config = action_config()

        results = jarvis.run_double_clap_actions(config)

        open_spotify.assert_called_once_with(config)
        open_claude.assert_called_once_with(config)
        open_cursor.assert_called_once_with(config)
        self.assertEqual([result.succeeded for result in results], [True, True, True])

    @patch("jarvis.open_cursor_window")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify", side_effect=OSError("Spotify unavailable"))
    def test_first_action_failure_does_not_prevent_later_actions(
        self, _open_spotify, open_claude, open_cursor
    ) -> None:
        results = jarvis.run_double_clap_actions(action_config())

        open_claude.assert_called_once()
        open_cursor.assert_called_once()
        self.assertEqual([result.succeeded for result in results], [False, True, True])

    @patch("jarvis.open_cursor_window")
    @patch("jarvis.open_claude", side_effect=RuntimeError("Claude unavailable"))
    @patch("jarvis.open_spotify")
    def test_middle_action_failure_does_not_prevent_later_action(
        self, _open_spotify, _open_claude, open_cursor
    ) -> None:
        results = jarvis.run_double_clap_actions(action_config())

        open_cursor.assert_called_once()
        self.assertEqual([result.succeeded for result in results], [True, False, True])

    @patch("jarvis.say_jarvis_welcome")
    @patch("jarvis.open_cursor_window")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify")
    def test_disabled_actions_are_not_called(
        self, open_spotify, open_claude, open_cursor, say_welcome
    ) -> None:
        config = action_config(
            OPEN_SPOTIFY="false",
            OPEN_CLAUDE="false",
            FOCUS_CURSOR="false",
            ENABLE_ELEVENLABS="false",
        )

        results = jarvis.run_double_clap_actions(config)

        self.assertEqual(results, [])
        open_spotify.assert_not_called()
        open_claude.assert_not_called()
        open_cursor.assert_not_called()
        say_welcome.assert_not_called()

    def test_action_failure_is_reported_and_logged(self) -> None:
        failure = Mock(side_effect=RuntimeError("useful failure"))

        with self.assertLogs("clap_listen", level="WARNING") as captured:
            result = jarvis.run_action("Example", failure)

        self.assertFalse(result.succeeded)
        self.assertEqual(result.error, "useful failure")
        self.assertIn("Example action failed: useful failure", "\n".join(captured.output))

    @patch("jarvis._cursor_executable")
    @patch("jarvis.open_cursor_window")
    def test_disabled_cursor_performs_no_discovery_or_launch(
        self, open_cursor, cursor_executable
    ) -> None:
        config = action_config(
            OPEN_SPOTIFY="false",
            OPEN_CLAUDE="false",
            FOCUS_CURSOR="false",
        )

        jarvis.run_double_clap_actions(config)

        open_cursor.assert_not_called()
        cursor_executable.assert_not_called()

    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify", side_effect=RuntimeError("Spotify unavailable"))
    def test_spotify_failure_still_attempts_claude_desktop(
        self, _open_spotify, open_claude
    ) -> None:
        config = action_config(
            CLAUDE_URL="claude://claude.ai/new",
            FOCUS_CURSOR="false",
        )

        results = jarvis.run_double_clap_actions(config)

        open_claude.assert_called_once_with(config)
        self.assertEqual([result.succeeded for result in results], [False, True])

    @patch("jarvis.open_netflix")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify")
    def test_active_actions_run_in_spotify_claude_netflix_order(
        self, open_spotify, open_claude, open_netflix
    ) -> None:
        config = action_config(OPEN_NETFLIX="true", FOCUS_CURSOR="false")
        manager = Mock()
        manager.attach_mock(open_spotify, "spotify")
        manager.attach_mock(open_claude, "claude")
        manager.attach_mock(open_netflix, "netflix")

        jarvis.run_double_clap_actions(config)

        self.assertEqual(
            manager.mock_calls,
            [call.spotify(config), call.claude(config), call.netflix(config)],
        )

    @patch("jarvis._enforce_spotify_minimized_final", return_value=True)
    @patch("jarvis.open_netflix")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify")
    def test_spotify_final_enforcement_runs_after_all_launch_actions(
        self, open_spotify, open_claude, open_netflix, enforce
    ) -> None:
        config = action_config(
            OPEN_NETFLIX="true",
            FOCUS_CURSOR="false",
            SPOTIFY_MINIMIZE="true",
        )
        manager = Mock()
        manager.attach_mock(open_spotify, "spotify")
        manager.attach_mock(open_claude, "claude")
        manager.attach_mock(open_netflix, "netflix")
        manager.attach_mock(enforce, "enforce")

        jarvis.run_double_clap_actions(config)

        self.assertEqual(
            manager.mock_calls,
            [
                call.spotify(config),
                call.claude(config),
                call.netflix(config),
                call.enforce(),
            ],
        )

    @patch("jarvis.open_netflix")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify", side_effect=RuntimeError("Spotify failed"))
    def test_spotify_failure_does_not_prevent_claude_or_netflix(
        self, _open_spotify, open_claude, open_netflix
    ) -> None:
        config = action_config(OPEN_NETFLIX="true", FOCUS_CURSOR="false")

        results = jarvis.run_double_clap_actions(config)

        open_claude.assert_called_once_with(config)
        open_netflix.assert_called_once_with(config)
        self.assertEqual([result.succeeded for result in results], [False, True, True])

    @patch("jarvis.open_netflix")
    @patch("jarvis.open_claude", side_effect=RuntimeError("Claude failed"))
    @patch("jarvis.open_spotify")
    def test_claude_failure_does_not_prevent_netflix(
        self, _open_spotify, _open_claude, open_netflix
    ) -> None:
        config = action_config(OPEN_NETFLIX="true", FOCUS_CURSOR="false")

        results = jarvis.run_double_clap_actions(config)

        open_netflix.assert_called_once_with(config)
        self.assertEqual([result.succeeded for result in results], [True, False, True])

    @patch("jarvis._discover_netflix_aumid")
    @patch("jarvis.open_netflix")
    def test_disabled_netflix_is_never_discovered_or_launched(
        self, open_netflix, discover
    ) -> None:
        config = action_config(
            OPEN_SPOTIFY="false",
            OPEN_CLAUDE="false",
            OPEN_NETFLIX="false",
            FOCUS_CURSOR="false",
        )

        jarvis.run_double_clap_actions(config)

        open_netflix.assert_not_called()
        discover.assert_not_called()

    @patch("jarvis.open_cursor_window")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify")
    @patch("jarvis.threading.Thread")
    def test_speech_remains_asynchronous(
        self, thread, _open_spotify, _open_claude, _open_cursor
    ) -> None:
        config = action_config(
            ELEVENLABS_API_KEY="configured-key",
            ELEVENLABS_VOICE_ID="configured-voice",
            ENABLE_ELEVENLABS="true",
            JARVIS_AFTER_SONG_DELAY_S="0",
        )

        jarvis.run_double_clap_actions(config)

        thread.assert_called_once_with(
            target=jarvis._run_speech_action,
            args=(config,),
            daemon=True,
            name="jarvis-elevenlabs",
        )
        thread.return_value.start.assert_called_once_with()

    def test_speech_worker_uses_action_boundary(self) -> None:
        config = action_config(
            ELEVENLABS_API_KEY="configured-key",
            ELEVENLABS_VOICE_ID="configured-voice",
            ENABLE_ELEVENLABS="true",
        )
        with patch("jarvis.say_jarvis_welcome", side_effect=RuntimeError("API down")):
            with self.assertLogs("clap_listen", level="WARNING") as captured:
                jarvis._run_speech_action(config)

        self.assertIn(
            "ElevenLabs speech action failed: API down", "\n".join(captured.output)
        )

    @patch("jarvis.open_cursor_window")
    @patch("jarvis.open_claude")
    @patch("jarvis.open_spotify")
    @patch("jarvis.threading.Thread")
    def test_speech_thread_start_failure_does_not_prevent_cursor(
        self, thread, _open_spotify, _open_claude, open_cursor
    ) -> None:
        config = action_config(
            ELEVENLABS_API_KEY="configured-key",
            ELEVENLABS_VOICE_ID="configured-voice",
            ENABLE_ELEVENLABS="true",
            JARVIS_AFTER_SONG_DELAY_S="0",
        )
        thread.return_value.start.side_effect = RuntimeError("thread unavailable")

        results = jarvis.run_double_clap_actions(config)

        open_cursor.assert_called_once_with(config)
        self.assertIn(False, [result.succeeded for result in results])

    def test_speech_api_error_redacts_credentials(self) -> None:
        config = action_config(
            ELEVENLABS_API_KEY="configured-key",
            ELEVENLABS_VOICE_ID="configured-voice",
            ENABLE_ELEVENLABS="true",
        )
        fake_client = Mock()
        fake_client.text_to_speech.convert.side_effect = RuntimeError(
            "request configured-key voice configured-voice failed"
        )
        with patch("elevenlabs.client.ElevenLabs", return_value=fake_client):
            with self.assertRaises(RuntimeError) as captured:
                jarvis.say_jarvis_welcome(config)

        message = str(captured.exception)
        self.assertNotIn("configured-key", message)
        self.assertNotIn("configured-voice", message)
        self.assertIn("<redacted>", message)


if __name__ == "__main__":
    unittest.main()
