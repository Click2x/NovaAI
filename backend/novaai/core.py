"""The shared services of one running backend, so the API, the chat engine and onboarding all see the same settings, models and memory."""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import registry
from .hardware import Hardware, detect
from .llm import FakeLLM, OllamaClient
from .memory import Memory
from .router import Router
from .safety import HarmFilter
from .settings import SettingsStore
from .tools import Toolbox


def data_dir() -> Path:
    return Path(os.environ.get("NOVAAI_HOME") or (Path.home() / ".novaai"))


@dataclass
class Core:
    home: Path
    settings: SettingsStore
    llm: Any
    memory: Memory
    hardware: Hardware
    entries: list
    harm: HarmFilter
    tools: Toolbox
    tts: Any = None
    stt: Any = None
    _installed: tuple = field(default=(0.0, frozenset()))

    @classmethod
    def create(cls, home: Path | None = None, llm: Any = None, hardware: Hardware | None = None, tts: Any = None, stt: Any = None) -> "Core":
        home = Path(home) if home else data_dir()
        home.mkdir(parents=True, exist_ok=True)
        settings = SettingsStore(home / "settings.json")
        memory = Memory(home / "nova.db")
        llm = llm or OllamaClient(lambda: settings.get()["models"]["ollama_url"])
        if tts is None:
            from .tts import TTS
            tts = TTS(home / "audio")
        if stt is None:
            from .stt import STT
            stt = STT()
        return cls(home=home, settings=settings, llm=llm, memory=memory, hardware=hardware or detect(),
                   entries=registry.load(home / "models.json"), harm=HarmFilter(lambda: settings.get()["safety"]), tools=Toolbox(memory), tts=tts, stt=stt)

    def s(self) -> dict:
        return self.settings.get()

    async def installed(self, max_age: float = 20.0) -> set[str]:
        at, tags = self._installed
        if time.monotonic() - at < max_age and tags:
            return set(tags)
        got = await self.llm.list_models()
        self._installed = (time.monotonic(), frozenset(got))
        return set(got)

    def forget_installed(self) -> None:
        self._installed = (0.0, frozenset())

    async def router(self) -> Router:
        return Router(self.entries, self.hardware, await self.installed())
