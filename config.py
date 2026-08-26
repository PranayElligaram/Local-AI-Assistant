from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from dotenv import load_dotenv


DEFAULT_CLAUDE_URL = "https://claude.ai/new"
DEFAULT_BINANCE_URL = "https://www.binance.com/en/trade/BTC_USDT"
DEFAULT_WELCOME_PHRASE = "Welcome home."

TRUE_VALUES = frozenset({"true", "1", "yes", "on"})
FALSE_VALUES = frozenset({"false", "0", "no", "off"})
SPOTIFY_SCHEMES = frozenset({"spotify", "http", "https"})
CLAUDE_SCHEMES = frozenset({"claude", "http", "https"})


class ConfigError(ValueError):
    pass


def parse_bool(value: str, *, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    accepted = "true/false, 1/0, yes/no, or on/off"
    raise ConfigError(f"{name} must be {accepted}; got {value!r}")


def _text(
    env: Mapping[str, str],
    name: str,
    default: str = "",
    *,
    aliases: tuple[str, ...] = (),
) -> str:
    for candidate in (name, *aliases):
        if candidate in env:
            return env[candidate].strip()
    return default


def _bool(
    env: Mapping[str, str],
    name: str,
    default: bool,
    *,
    aliases: tuple[str, ...] = (),
) -> bool:
    raw = _text(env, name, aliases=aliases)
    if raw == "":
        return default
    return parse_bool(raw, name=name)


def _int(
    env: Mapping[str, str],
    name: str,
    default: int,
    *,
    minimum: int | None = None,
) -> int:
    raw = _text(env, name)
    if raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer; got {raw!r}") from exc
    if minimum is not None and value < minimum:
        raise ConfigError(f"{name} must be at least {minimum}; got {value}")
    return value


def _optional_int(
    env: Mapping[str, str],
    name: str,
    *,
    minimum: int = 1,
) -> int | None:
    raw = _text(env, name)
    if raw == "":
        return None
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a positive integer or blank; got {raw!r}") from exc
    if value < minimum:
        raise ConfigError(f"{name} must be at least {minimum} or blank; got {value}")
    return value


def _float(
    env: Mapping[str, str],
    name: str,
    default: float,
    *,
    minimum: float | None = None,
) -> float:
    raw = _text(env, name)
    if raw == "":
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number; got {raw!r}") from exc
    if minimum is not None and value < minimum:
        raise ConfigError(f"{name} must be at least {minimum}; got {value}")
    return value


def _pcm_sample_rate(env: Mapping[str, str], output_format: str) -> int:
    raw = _text(env, "ELEVENLABS_PCM_SAMPLE_RATE")
    if raw:
        try:
            rate = int(raw)
        except ValueError as exc:
            raise ConfigError(
                f"ELEVENLABS_PCM_SAMPLE_RATE must be an integer; got {raw!r}"
            ) from exc
        if rate <= 0:
            raise ConfigError("ELEVENLABS_PCM_SAMPLE_RATE must be greater than zero")
        return rate
    if output_format.startswith("pcm_"):
        try:
            return int(output_format.split("_", maxsplit=1)[1])
        except (ValueError, IndexError):
            pass
    return 24000


def _validate_target(name: str, target: str, allowed_schemes: frozenset[str]) -> str:
    parsed = urlsplit(target)
    scheme = parsed.scheme.lower()
    if scheme not in allowed_schemes:
        allowed = ", ".join(sorted(allowed_schemes))
        raise ConfigError(
            f"{name} uses unsupported URI scheme {scheme or '(missing)'!r}; "
            f"allowed schemes: {allowed}"
        )
    if scheme in {"http", "https", "claude"} and not parsed.netloc:
        raise ConfigError(f"{name} must include a host for the {scheme} scheme")
    if scheme == "spotify" and not parsed.path:
        raise ConfigError(f"{name} must include a Spotify resource")
    return scheme


@dataclass(frozen=True)
class JarvisConfig:
    input_device: str | None

    open_spotify: bool
    song_uri: str
    spotify_monitor: int | None
    spotify_minimize: bool

    open_claude: bool
    claude_url: str
    claude_monitor: int | None
    claude_maximize: bool
    claude_chrome_monitor: int

    open_netflix: bool
    netflix_monitor: int | None
    netflix_maximize: bool

    focus_cursor: bool
    cursor_fullscreen: bool

    open_chrome_fullscreen: bool
    chrome_separate_site_profiles: bool
    chrome_window_width: int
    chrome_window_height: int
    chrome_new_window_wait_s: float

    enable_elevenlabs: bool
    welcome_phrase: str
    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    elevenlabs_model_id: str
    elevenlabs_output_format: str
    elevenlabs_pcm_sample_rate: int
    welcome_cache_enabled: bool
    welcome_cache_dir: Path
    after_song_delay_s: float

    open_binance: bool
    binance_url: str
    binance_monitor: int

    @property
    def spotify_enabled(self) -> bool:
        return self.open_spotify and bool(self.song_uri)

    @property
    def claude_scheme(self) -> str:
        return urlsplit(self.claude_url).scheme.lower()

    @property
    def elevenlabs_enabled(self) -> bool:
        return (
            self.enable_elevenlabs
            and bool(self.welcome_phrase)
            and bool(self.elevenlabs_api_key)
            and bool(self.elevenlabs_voice_id)
        )

    def elevenlabs_disabled_reason(self) -> str | None:
        if not self.enable_elevenlabs:
            return "disabled by ENABLE_ELEVENLABS"
        if not self.elevenlabs_api_key:
            return "ELEVENLABS_API_KEY is not configured"
        if not self.elevenlabs_voice_id:
            return "ELEVENLABS_VOICE_ID is not configured"
        if not self.welcome_phrase:
            return "JARVIS_WELCOME_PHRASE is empty"
        return None


def load_config(
    env: Mapping[str, str] | None = None,
    *,
    base_dir: Path | None = None,
) -> JarvisConfig:
    project_dir = (base_dir or Path(__file__).resolve().parent).resolve()
    if env is None:
        load_dotenv(project_dir / ".env", override=False)
        source: Mapping[str, str] = os.environ
    else:
        source = env

    open_spotify = _bool(source, "OPEN_SPOTIFY", True)
    song_uri = _text(source, "SONG_URI")
    if open_spotify and song_uri:
        _validate_target("SONG_URI", song_uri, SPOTIFY_SCHEMES)
    spotify_monitor = (
        _optional_int(source, "SPOTIFY_MONITOR") if open_spotify else None
    )
    spotify_minimize = (
        _bool(source, "SPOTIFY_MINIMIZE", False) if open_spotify else False
    )

    open_claude = _bool(
        source,
        "OPEN_CLAUDE",
        True,
        aliases=("OPEN_CLAUDE_CODE_IN_CHROME",),
    )
    claude_url = _text(
        source,
        "CLAUDE_URL",
        DEFAULT_CLAUDE_URL,
        aliases=("CLAUDE_CODE_URL",),
    )
    if open_claude and not claude_url:
        raise ConfigError("CLAUDE_URL must be configured when OPEN_CLAUDE is true")
    claude_scheme = (
        _validate_target("CLAUDE_URL", claude_url, CLAUDE_SCHEMES)
        if open_claude
        else ""
    )
    claude_monitor = (
        _optional_int(source, "CLAUDE_MONITOR")
        if open_claude and claude_scheme == "claude"
        else None
    )
    claude_maximize = (
        _bool(source, "CLAUDE_MAXIMIZE", False)
        if open_claude and claude_scheme == "claude"
        else False
    )

    open_netflix = _bool(source, "OPEN_NETFLIX", False)
    netflix_monitor = (
        _optional_int(source, "NETFLIX_MONITOR") if open_netflix else None
    )
    netflix_maximize = (
        _bool(source, "NETFLIX_MAXIMIZE", False) if open_netflix else False
    )

    focus_cursor = _bool(
        source,
        "FOCUS_CURSOR",
        True,
        aliases=("FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP",),
    )
    cursor_fullscreen = (
        _bool(source, "CURSOR_FULLSCREEN", True) if focus_cursor else False
    )

    open_binance = _bool(source, "OPEN_BINANCE", False)
    binance_url = _text(source, "BINANCE_BTC_URL", DEFAULT_BINANCE_URL)
    if open_binance and not binance_url:
        raise ConfigError(
            "BINANCE_BTC_URL must be configured when OPEN_BINANCE is true"
        )

    claude_browser_enabled = open_claude and claude_scheme in {"http", "https"}
    chrome_enabled = claude_browser_enabled or open_binance
    if chrome_enabled:
        open_chrome_fullscreen = _bool(source, "OPEN_CHROME_FULLSCREEN", True)
        separate_profiles = _bool(source, "CHROME_SEPARATE_SITE_PROFILES", False)
        chrome_width = _int(source, "CHROME_WINDOW_WIDTH", 1400, minimum=400)
        chrome_height = _int(source, "CHROME_WINDOW_HEIGHT", 900, minimum=300)
        chrome_wait = _float(
            source, "CHROME_NEW_WINDOW_WAIT_S", 25.0, minimum=3.0
        )
    else:
        open_chrome_fullscreen = False
        separate_profiles = False
        chrome_width = 1400
        chrome_height = 900
        chrome_wait = 25.0

    claude_chrome_monitor = (
        _int(source, "CLAUDE_CHROME_MONITOR", 1, minimum=1)
        if claude_browser_enabled
        else 1
    )
    binance_monitor = (
        _int(source, "BINANCE_CHROME_MONITOR", 3, minimum=1)
        if open_binance
        else 3
    )

    enable_elevenlabs = _bool(
        source,
        "ENABLE_ELEVENLABS",
        True,
        aliases=("JARVIS_WELCOME_ENABLED",),
    )
    api_key = _text(source, "ELEVENLABS_API_KEY")
    voice_id = _text(source, "ELEVENLABS_VOICE_ID")
    welcome_phrase = _text(
        source, "JARVIS_WELCOME_PHRASE", DEFAULT_WELCOME_PHRASE
    )
    speech_configured = (
        enable_elevenlabs and bool(api_key) and bool(voice_id) and bool(welcome_phrase)
    )
    if speech_configured:
        model_id = _text(
            source, "ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"
        )
        output_format = _text(source, "ELEVENLABS_OUTPUT_FORMAT", "pcm_24000")
        pcm_sample_rate = _pcm_sample_rate(source, output_format)
        cache_enabled = _bool(source, "JARVIS_WELCOME_CACHE_ENABLED", True)
        after_song_delay_s = _float(
            source, "JARVIS_AFTER_SONG_DELAY_S", 1.0, minimum=0.0
        )
    else:
        model_id = "eleven_multilingual_v2"
        output_format = "pcm_24000"
        pcm_sample_rate = 24000
        cache_enabled = True
        after_song_delay_s = 1.0

    cache_override = _text(source, "JARVIS_WELCOME_CACHE_DIR")
    cache_dir = (
        Path(cache_override).expanduser().resolve()
        if cache_override and speech_configured
        else project_dir / ".cache" / "jarvis_welcome"
    )

    input_device = _text(source, "JARVIS_INPUT_DEVICE") or None

    return JarvisConfig(
        input_device=input_device,
        open_spotify=open_spotify,
        song_uri=song_uri,
        spotify_monitor=spotify_monitor,
        spotify_minimize=spotify_minimize,
        open_claude=open_claude,
        claude_url=claude_url,
        claude_monitor=claude_monitor,
        claude_maximize=claude_maximize,
        claude_chrome_monitor=claude_chrome_monitor,
        open_netflix=open_netflix,
        netflix_monitor=netflix_monitor,
        netflix_maximize=netflix_maximize,
        focus_cursor=focus_cursor,
        cursor_fullscreen=cursor_fullscreen,
        open_chrome_fullscreen=open_chrome_fullscreen,
        chrome_separate_site_profiles=separate_profiles,
        chrome_window_width=chrome_width,
        chrome_window_height=chrome_height,
        chrome_new_window_wait_s=chrome_wait,
        enable_elevenlabs=enable_elevenlabs,
        welcome_phrase=welcome_phrase,
        elevenlabs_api_key=api_key,
        elevenlabs_voice_id=voice_id,
        elevenlabs_model_id=model_id,
        elevenlabs_output_format=output_format,
        elevenlabs_pcm_sample_rate=pcm_sample_rate,
        welcome_cache_enabled=cache_enabled,
        welcome_cache_dir=cache_dir,
        after_song_delay_s=after_song_delay_s,
        open_binance=open_binance,
        binance_url=binance_url,
        binance_monitor=binance_monitor,
    )
