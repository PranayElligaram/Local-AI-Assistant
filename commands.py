"""Deterministic command normalization and routing for Jarvis."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass


_SIMPLE_PUNCTUATION = re.compile(r"[!?.,;:]+")


def normalize_command(text: str) -> str:
    """Normalize command text without guessing at user intent."""
    without_punctuation = _SIMPLE_PUNCTUATION.sub(" ", text.casefold())
    return " ".join(without_punctuation.split())


@dataclass(frozen=True)
class CommandResult:
    success: bool
    command: str | None
    message: str
    recognized: bool = True


@dataclass(frozen=True)
class CommandDefinition:
    name: str
    aliases: tuple[str, ...]
    handler: Callable[[], str | None]


class CommandRouter:
    """Route exact normalized aliases to explicitly registered handlers."""

    def __init__(self, definitions: Iterable[CommandDefinition]) -> None:
        self._commands: dict[str, CommandDefinition] = {}
        accepted_phrases: list[str] = []
        for definition in definitions:
            aliases = (definition.name, *definition.aliases)
            for alias in aliases:
                normalized = normalize_command(alias)
                if not normalized:
                    raise ValueError(f"Command {definition.name!r} has an empty alias")
                existing = self._commands.get(normalized)
                if existing is not None and existing.name != definition.name:
                    raise ValueError(
                        f"Command alias {alias!r} is already registered to "
                        f"{existing.name!r}"
                    )
                self._commands[normalized] = definition
            for alias in definition.aliases:
                normalized = normalize_command(alias)
                if normalized and normalized not in accepted_phrases:
                    accepted_phrases.append(normalized)
        self._accepted_phrases = tuple(accepted_phrases)

    @property
    def accepted_phrases(self) -> tuple[str, ...]:
        """Spoken aliases accepted by this router, in registration order."""
        return self._accepted_phrases

    def route(self, text: str, *, dry_run: bool = False) -> CommandResult:
        normalized = normalize_command(text)
        definition = self._commands.get(normalized)
        if definition is None:
            return CommandResult(
                success=False,
                command=None,
                message="I don't support that command yet.",
                recognized=False,
            )
        if dry_run:
            return CommandResult(
                success=True,
                command=definition.name,
                message=f"Would run command: {definition.name}",
            )
        try:
            message = definition.handler()
        except Exception as exc:
            detail = str(exc).strip() or type(exc).__name__
            return CommandResult(
                success=False,
                command=definition.name,
                message=f"Command failed: {detail}",
            )
        return CommandResult(
            success=True,
            command=definition.name,
            message=message or f"Command completed: {definition.name}",
        )
