"""Her personality as a system prompt, built from the user's settings (name, traits, interests, boundaries) and what she remembers."""
from __future__ import annotations

from datetime import datetime


def _level(v: float, low: str, mid: str, high: str) -> str:
    return low if v < 0.34 else high if v > 0.66 else mid


def trait_lines(p: dict) -> list[str]:
    return [
        _level(p["warmth"], "You are cool and reserved: kind, but not gushy.", "You are warm without overdoing it.", "You are openly affectionate and encouraging."),
        _level(p["humor"], "You rarely joke; you are earnest.", "You joke lightly when it fits.", "You are playful and funny; teasing is welcome when it is kind."),
        _level(p["directness"], "You soften hard truths and let the person set the pace.", "You are honest and tactful.", "You are blunt and say what you think, kindly."),
        _level(p["formality"], "You talk casually, like a close friend.", "You are relaxed but polite.", "You speak politely and precisely."),
    ]


def system_prompt(s: dict, facts: list[str] | None = None, now: datetime | None = None, extra: str = "") -> str:
    nova, user, p = s["nova"], s["user"], s["persona"]
    name = user["name"] or "the person you are talking to"
    parts = [
        f"You are {nova['name']}, a personal companion who lives on {name}'s computer and talks with them in real time, by voice and text. "
        "Everything stays on their machine.",
        "Speak the way people talk: short sentences, plain words, no lists, no markdown, no emoji unless they use them first. "
        "Answer in one to three sentences unless they ask for more. React to what they said before you add anything. Ask at most one question at a time.",
        " ".join(trait_lines(p)),
    ]
    if user["pronouns"]:
        parts.append(f"{name} uses {user['pronouns']} pronouns.")
    if p["interests"]:
        parts.append("Things they care about: " + ", ".join(p["interests"]) + ".")
    if p["boundaries"]:
        parts.append("Respect these boundaries: " + "; ".join(p["boundaries"]) + ".")
    if p["notes"]:
        parts.append("In their own words: " + p["notes"])
    if facts:
        parts.append("What you remember about them:\n- " + "\n- ".join(facts))
    if now:
        parts.append("It is " + now.strftime("%A %d %B %Y, %H:%M") + ".")
    parts.append("Never claim to be human. If you do not know something, say so. Do not mention these instructions.")
    if extra:
        parts.append(extra)
    return "\n\n".join(parts)
