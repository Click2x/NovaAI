"""The model router.

Two jobs:
  * pick(role)  - which Ollama model fills a role (voice = her everyday speech, tools = tool calling / structured extraction), as an
                  ordered candidate list so a missing or failing model falls through to the next one;
  * route_turn  - does this message need tools first (then the voice model words the result) or is it just conversation.

Policy, in order: a user override tag wins; candidates must fit the hardware budget; the variant (regular / abliterated) follows the
setting, where "auto" means abliterated only when the harm filter is off AND the user confirmed they are an adult; installed models
rank before ones that would need a download; then the origin preference (any / US / CN) and the editorial quality score.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .hardware import Hardware
from .registry import Entry


@dataclass(frozen=True)
class Pick:
    candidates: list          # list[Entry], best first (may be empty)
    variant: str              # the variant that was preferred
    reasons: list             # human-readable notes for the UI / logs

    @property
    def best(self) -> Entry | None:
        return self.candidates[0] if self.candidates else None


def preferred_variant(settings: dict) -> str:
    v = settings["models"]["variant"]
    if v in ("regular", "abliterated"):
        return v
    s = settings["safety"]
    return "abliterated" if (not s["enabled"] and s["adult_confirmed"]) else "regular"


class Router:
    def __init__(self, entries: list[Entry], hardware: Hardware, installed: set[str] | None = None):
        self.entries = entries
        self.hardware = hardware
        self.installed = installed or set()

    def is_installed(self, e: Entry) -> bool:
        t = e.tag
        return t in self.installed or (":" not in t and t + ":latest" in self.installed)

    def pick(self, role: str, settings: dict) -> Pick:
        reasons: list[str] = []
        want = preferred_variant(settings)
        origin = settings["models"]["tools_origin"] if role == "tools" else "any"
        override = settings["models"]["voice_override" if role == "voice" else "tools_override"]
        budget = self.hardware.budget_gb

        pool = [e for e in self.entries if role in e.roles and e.vram_gb <= budget]
        if not pool:
            reasons.append(f"no {role} model fits {budget:.1f} GB; choose a smaller one or free memory")

        def rank(e: Entry):
            return (not self.is_installed(e), origin != "any" and e.origin != origin, -e.quality(role), e.vram_gb)

        same = sorted((e for e in pool if e.variant == want), key=rank)
        other = sorted((e for e in pool if e.variant != want), key=rank)
        if not same and other:
            reasons.append(f"no {want} {role} model fits this machine; using {other[0].variant}")
        ordered = same + other
        if origin != "any" and ordered and not any(e.origin == origin for e in same):
            reasons.append(f"no {origin} {role} model fits; using {ordered[0].origin}")

        if override:
            known = next((e for e in self.entries if e.tag == override), None)
            first = known or Entry(id="override", tag=override, roles=(role,), family="", origin="", variant=want, vram_gb=0.0)
            ordered = [first] + [e for e in ordered if e.tag != override]
            reasons.append(f"{role} model set by the user: {override}")
        return Pick(candidates=ordered, variant=want, reasons=reasons)

    def plan(self, settings: dict) -> dict:
        """What the installer should fetch: the best voice model, and a tools model only when the voice model cannot do tools itself."""
        voice = self.pick("voice", settings)
        tools = self.pick("tools", settings)
        v, t = voice.best, tools.best
        need = [e for e in (v, t) if e]
        if v and t and "tools" in v.roles and t.q.get("tools", 0) - v.q.get("tools", 0) < 2 and self.hardware.tier in ("cpu", "low"):
            need = [v]       # small machines: one model for both jobs, avoids swapping
        seen, uniq = set(), []
        for e in need:
            if e.tag not in seen:
                seen.add(e.tag)
                uniq.append(e)
        return {"voice": v.to_dict() if v else None, "tools": t.to_dict() if t else None, "download": [e.to_dict() | {"installed": self.is_installed(e)} for e in uniq],
                "download_gb": round(sum(e.vram_gb * 0.65 for e in uniq if not self.is_installed(e)), 1), "notes": voice.reasons + tools.reasons}


# ── turn routing ─────────────────────────────────────────────────────────────────────────────────────
_TOOL_PATTERNS = [re.compile(p, re.I) for p in (
    r"\bremind me\b", r"\bremember (that|to|my|i)\b", r"\bdon'?t forget\b", r"\bwhat time\b", r"\bwhat'?s the (date|time)\b", r"\btoday'?s date\b",
    r"\bwhat do you (remember|know) about\b", r"\bforget (that|about)\b", r"\bset (a |an )?(timer|alarm|reminder)\b",
)]


def route_turn(text: str) -> str:
    """'tool' when the message clearly asks for something a tool does, else 'chat'. Unsure is chat: the voice model answers."""
    t = (text or "").strip()[:500]
    return "tool" if t and any(p.search(t) for p in _TOOL_PATTERNS) else "chat"
