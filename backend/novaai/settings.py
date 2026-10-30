"""User settings: one JSON file in the data folder, validated on every load and patch (an invalid value keeps the previous one)."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

SAFETY_ACTIONS = ("block", "care", "allow")
VARIANTS = ("auto", "regular", "abliterated")
ORIGINS = ("any", "US", "CN")

# Category names are defined in safety.py; "minors_sexual" is deliberately not here: it is not a setting.
DEFAULTS: dict[str, Any] = {
    "user": {"name": "", "pronouns": ""},
    "nova": {"name": "Nova", "voice": "af_heart", "speed": 1.0, "avatar": "default"},
    "persona": {"warmth": 0.7, "humor": 0.5, "directness": 0.5, "formality": 0.2, "interests": [], "boundaries": [], "notes": ""},
    "models": {"variant": "auto", "tools_origin": "any", "voice_override": "", "tools_override": "", "ollama_url": "http://127.0.0.1:11434"},
    "safety": {
        "enabled": True,
        "adult_confirmed": False,
        "categories": {
            "self_harm": "care",
            "violence_weapons": "block",
            "illegal_activity": "block",
            "hate_harassment": "block",
            "sexual_explicit": "block",
            "dangerous_instructions": "block",
        },
    },
    "memory": {"auto_learn": True},     # after a turn she saves lasting facts the user told her (learn.py); off = only what the user asks her to remember
    "onboarding": {"done": False},
}

_TAG_OK = lambda s: isinstance(s, str) and (s == "" or (len(s) <= 200 and all(c.isalnum() or c in "._:/@+-" for c in s)))


def _clip_str(v: Any, fallback: str, n: int) -> str:
    return v.strip()[:n] if isinstance(v, str) else fallback


def _unit(v: Any, fallback: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return fallback
    return round(min(1.0, max(0.0, float(v))), 2)


def _strlist(v: Any, fallback: list[str], n: int = 12) -> list[str]:
    if not isinstance(v, list):
        return fallback
    out: list[str] = []
    for item in v:
        if isinstance(item, str) and item.strip() and item.strip().lower() not in [o.lower() for o in out]:
            out.append(item.strip()[:80])
        if len(out) >= n:
            break
    return out


def sanitize(raw: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """A complete, valid settings dict from anything. Unknown keys are dropped; an invalid value keeps `base`'s value."""
    b = base or DEFAULTS
    src = raw if isinstance(raw, dict) else {}
    g = lambda section: src.get(section) if isinstance(src.get(section), dict) else {}
    user, nova, persona, models, safety, onb, mem = g("user"), g("nova"), g("persona"), g("models"), g("safety"), g("onboarding"), g("memory")
    cats_in = safety.get("categories") if isinstance(safety.get("categories"), dict) else {}
    cats = {k: (cats_in.get(k) if cats_in.get(k) in SAFETY_ACTIONS else v) for k, v in b["safety"]["categories"].items()}
    speed = nova.get("speed")
    speed_ok = isinstance(speed, (int, float)) and not isinstance(speed, bool)
    return {
        "user": {"name": _clip_str(user.get("name"), b["user"]["name"], 60), "pronouns": _clip_str(user.get("pronouns"), b["user"]["pronouns"], 30)},
        "nova": {
            "name": _clip_str(nova.get("name"), b["nova"]["name"], 40) or b["nova"]["name"],
            "voice": nova["voice"] if isinstance(nova.get("voice"), str) and 3 <= len(nova["voice"]) <= 30 and nova["voice"].replace("_", "").isalnum() else b["nova"]["voice"],
            "speed": round(min(2.0, max(0.5, float(speed))), 2) if speed_ok else b["nova"]["speed"],
            "avatar": _avatar(nova.get("avatar"), b["nova"]["avatar"]),
        },
        "persona": {
            "warmth": _unit(persona.get("warmth"), b["persona"]["warmth"]),
            "humor": _unit(persona.get("humor"), b["persona"]["humor"]),
            "directness": _unit(persona.get("directness"), b["persona"]["directness"]),
            "formality": _unit(persona.get("formality"), b["persona"]["formality"]),
            "interests": _strlist(persona.get("interests"), b["persona"]["interests"]),
            "boundaries": _strlist(persona.get("boundaries"), b["persona"]["boundaries"]),
            "notes": _clip_str(persona.get("notes"), b["persona"]["notes"], 1000),
        },
        "models": {
            "variant": models.get("variant") if models.get("variant") in VARIANTS else b["models"]["variant"],
            "tools_origin": models.get("tools_origin") if models.get("tools_origin") in ORIGINS else b["models"]["tools_origin"],
            "voice_override": models["voice_override"] if _TAG_OK(models.get("voice_override")) else b["models"]["voice_override"],
            "tools_override": models["tools_override"] if _TAG_OK(models.get("tools_override")) else b["models"]["tools_override"],
            "ollama_url": _url(models.get("ollama_url"), b["models"]["ollama_url"]),
        },
        "safety": {
            "enabled": safety["enabled"] if isinstance(safety.get("enabled"), bool) else b["safety"]["enabled"],
            "adult_confirmed": safety["adult_confirmed"] if isinstance(safety.get("adult_confirmed"), bool) else b["safety"]["adult_confirmed"],
            "categories": cats,
        },
        "memory": {"auto_learn": mem["auto_learn"] if isinstance(mem.get("auto_learn"), bool) else b["memory"]["auto_learn"]},
        "onboarding": {"done": onb["done"] if isinstance(onb.get("done"), bool) else b["onboarding"]["done"]},
    }


def _avatar(v: Any, fallback: str) -> str:
    """"default" or a path to a .vrm file chosen in the desktop app: one line, no control characters, ends in .vrm."""
    if not isinstance(v, str):
        return fallback
    t = v.strip()
    if t == "default":
        return t
    return t if 0 < len(t) <= 260 and t.lower().endswith(".vrm") and not any(ord(c) < 32 for c in t) else fallback


def _url(v: Any, fallback: str) -> str:
    from urllib.parse import urlparse

    if not isinstance(v, str) or len(v) > 200:
        return fallback
    u = urlparse(v.strip())
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
        return fallback
    return v.strip().rstrip("/")


def merge(current: dict[str, Any], patch: Any) -> dict[str, Any]:
    """`patch` applied over `current` section by section (categories merge per key), then validated."""
    if not isinstance(patch, dict):
        return copy.deepcopy(current)
    merged = copy.deepcopy(current)
    for section, value in patch.items():
        if section not in merged or not isinstance(value, dict):
            continue
        for k, v in value.items():
            if isinstance(v, dict) and isinstance(merged[section].get(k), dict):
                merged[section][k] = {**merged[section][k], **v}
            else:
                merged[section][k] = v
    return sanitize(merged, current)


class SettingsStore:
    """Thread-safe load/patch/save of settings.json. A missing or corrupt file gives defaults (the corrupt one is kept as .bad)."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            return sanitize(json.loads(self.path.read_text(encoding="utf-8")))
        except FileNotFoundError:
            return sanitize(None)
        except (OSError, ValueError):
            try:
                os.replace(self.path, self.path.with_suffix(".bad"))
            except OSError:
                pass
            return sanitize(None)

    def get(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)

    def patch(self, patch: Any) -> dict[str, Any]:
        with self._lock:
            self._data = merge(self._data, patch)
            self._save()
            return copy.deepcopy(self._data)

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
            os.replace(tmp, self.path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
