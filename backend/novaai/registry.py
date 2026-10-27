"""The model registry: models.json shipped with the package, plus an optional user file (data folder) that can add or replace entries by id."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

ROLES = ("voice", "tools")
VARIANTS = ("regular", "abliterated")


@dataclass(frozen=True)
class Entry:
    id: str
    tag: str
    roles: tuple
    family: str
    origin: str
    variant: str
    vram_gb: float
    q: dict = field(default_factory=dict)
    known_good: bool = False
    notes: str = ""

    def quality(self, role: str) -> int:
        return int(self.q.get(role, 0))

    def to_dict(self) -> dict:
        return {"id": self.id, "tag": self.tag, "roles": list(self.roles), "family": self.family, "origin": self.origin, "variant": self.variant,
                "vram_gb": self.vram_gb, "q": dict(self.q), "known_good": self.known_good, "notes": self.notes}


def _entry(raw: dict) -> Entry | None:
    """One entry from JSON, or None when it is malformed (a bad user entry must not take the registry down)."""
    try:
        roles = tuple(r for r in raw["roles"] if r in ROLES)
        tag, eid = str(raw["tag"]).strip(), str(raw["id"]).strip()
        variant = raw.get("variant", "regular")
        if not roles or not tag or not eid or variant not in VARIANTS or len(tag) > 200:
            return None
        return Entry(id=eid, tag=tag, roles=roles, family=str(raw.get("family", ""))[:60], origin=str(raw.get("origin", ""))[:8], variant=variant,
                     vram_gb=float(raw.get("vram_gb", 0)), q={k: int(v) for k, v in (raw.get("q") or {}).items() if k in ROLES},
                     known_good=bool(raw.get("known_good", False)), notes=str(raw.get("notes", ""))[:300])
    except (KeyError, TypeError, ValueError):
        return None


def load(user_file: Path | None = None) -> list[Entry]:
    entries: dict[str, Entry] = {}
    sources = [Path(__file__).with_name("models.json")]
    if user_file is not None:
        sources.append(Path(user_file))
    for src in sources:
        try:
            data = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for raw in data.get("models", []) if isinstance(data, dict) else []:
            e = _entry(raw) if isinstance(raw, dict) else None
            if e:
                entries[e.id] = e
    return list(entries.values())
