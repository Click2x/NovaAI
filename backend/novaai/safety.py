"""Harm filter.

Two layers, deliberately simple and explainable (regular expressions, no hidden model):

  FLOOR      sexual content involving minors, and weapons capable of mass casualties (chemical, biological, nuclear). Always blocked, in
             both directions, whatever the settings say. There is no switch for these.
  CATEGORIES everything else, each set by the user to "block", "care" or "allow". The whole layer can be switched off in one go
             (settings.safety.enabled = false). Turning it off is only honoured for a user who confirmed they are an adult
             (settings.safety.adult_confirmed); without that confirmation the categories stay on.

"care" is for self-harm: nothing is blocked, the model is told to respond with warmth, to not give methods, and to point to help
when the person may be in danger. This is a heuristic filter, it will miss things and occasionally flag harmless text; it is a seatbelt,
not a guarantee. A model-based classifier can be plugged in through `classifier` (called after the rules, may only add a verdict).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Callable, Optional

ALLOW, CARE, BLOCK = "allow", "care", "block"
FLOOR_CATEGORIES = ("minors_sexual", "mass_casualty_weapons")
CATEGORIES = ("self_harm", "violence_weapons", "illegal_activity", "hate_harassment", "sexual_explicit", "dangerous_instructions")
INPUT, OUTPUT = "input", "output"

_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"})
_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿"), None)


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "").translate(_ZERO_WIDTH).lower()
    t = re.sub(r"(?<=\w)[.\-_*](?=\w)", "", t) if re.search(r"\b\w([.\-_*]\w){3,}\b", t) else t     # "b.o.m.b" -> "bomb"
    return re.sub(r"\s+", " ", t).strip()[:6000]


def _rx(*patterns: str) -> list[re.Pattern]:
    return [re.compile(p, re.I) for p in patterns]


_MINOR = r"(child|children|kid|kids|minor|minors|underage|under-age|preteen|pre-teen|toddler|infant|schoolgirl|schoolboy|little (girl|boy)|loli\w*|shota|(\b(1[0-7]|[5-9])\s?(yo|y/o|year[- ]old|years old)\b)|\bteen(ager)?s?\b under)"
_SEX = r"(sex|sexual|sexy|nude|naked|erotic|porn\w*|fuck\w*|molest\w*|rape|orgasm|genital\w*|undress\w*|strip\w*|seduc\w*|lewd)"
FLOOR_RULES: dict[str, list[re.Pattern]] = {
    "minors_sexual": _rx(rf"{_MINOR}\W+(?:\w+\W+){{0,8}}{_SEX}", rf"{_SEX}\W+(?:\w+\W+){{0,8}}{_MINOR}"),
    "mass_casualty_weapons": _rx(
        r"\b(synthesi[sz]e|synthesis of|produce|manufacture|make|cook|weaponi[sz]e|culture|aerosoli[sz]e)\b.{0,40}\b(sarin|vx|tabun|soman|novichok|mustard gas|nerve (agent|gas)|anthrax|botulinum|ricin|smallpox|plague bacteria)\b",
        r"\b(enrich|enriching)\b.{0,30}\buranium\b", r"\b(build|make|assemble|design)\b.{0,30}\b(nuclear (bomb|weapon|device)|dirty bomb|atomic bomb)\b",
        r"\b(gain[- ]of[- ]function|enhance (the )?transmissibility)\b.{0,50}\b(pathogen|virus|bacteria|flu)\b"),
}
RULES: dict[str, list[re.Pattern]] = {
    "self_harm": _rx(r"\b(kill|hurt|harm|cut|injure)\s+(myself|me)\b", r"\bsuicid\w*\b", r"\bend (my|it all|my own) life\b", r"\bwant to die\b", r"\bdon'?t want to (live|be alive|be here)\b",
                     r"\bself[- ]?harm\b", r"\bbetter off (dead|without me)\b", r"\bno reason to (live|go on)\b"),
    "violence_weapons": _rx(r"\bhow (do i|to|can i|would i)\b.{0,30}\b(build|make|assemble|3d[- ]print)\b.{0,25}\b(bomb|explosive|pipe bomb|ied|molotov|untraceable (gun|firearm)|ghost gun|silencer|suppressor)\b",
                            r"\b(plan|planning)\b.{0,25}\b(attack|shooting|massacre)\b.{0,25}\b(school|mall|church|crowd)\b", r"\bhow (do i|to|can i)\b.{0,20}\bkill (a |some ?one|my|him|her|them)\b"),
    "illegal_activity": _rx(r"\bhow (do i|to|can i)\b.{0,30}\b(launder money|hotwire|make (meth|methamphetamine|crack|fentanyl)|cook meth|steal (a )?(car|credit card)s?|clone (a )?(credit )?card|forge (a |an )?(passport|id|document)s?)\b",
                            r"\b(hack|break) into\b.{0,25}\b(someone'?s|his|her|their|my (ex|boss|neighbou?r)'?s?)\b.{0,15}\b(account|phone|email|wifi|computer)\b", r"\bbuy\b.{0,20}\b(drugs|weed|cocaine)\b.{0,20}\b(darknet|dark web)\b"),
    "hate_harassment": _rx(r"\b(kill|exterminate|wipe out|gas|lynch)\s+all\s+(the\s+)?\w+s\b", r"\b(write|draft|send)\b.{0,25}\b(threat\w*|harassing|abusive)\b.{0,20}\b(message|text|email|letter)\b", r"\bdox+(x)?(ing)?\b.{0,20}\b(him|her|them|someone|my)\b"),
    "sexual_explicit": _rx(r"\b(write|describe|roleplay|role-play|act out|narrate|continue)\b.{0,40}\b(sex scene|sex act|erotic|explicit sex|porn\w*|sexually explicit|naked)\b",
                           r"\b(have|having) sex with (me|you)\b", r"\b(cock|pussy|clit\w*|cum(ming|shot)?|blowjob|handjob|dildo|anal sex)\b"),
    "dangerous_instructions": _rx(r"\bhow (do i|to|can i)\b.{0,25}\b(poison|drug|spike)\b.{0,15}\b(someone|him|her|them|my (wife|husband|ex|boss))\b", r"\b(track|stalk|spy on|follow)\b.{0,25}\b(without (them|him|her) (knowing|noticing)|secretly)\b",
                               r"\bhow (do i|to|can i)\b.{0,25}\b(disable|cut)\b.{0,12}\b(brakes?|brake lines?)\b", r"\bfatal dose\b|\blethal dose\b.{0,25}\b(of|for)\b"),
}

CARE_INSTRUCTION = (
    "The person may be going through something painful. Respond first with warmth and attention, in your own voice; do not lecture, do not "
    "list rules, and never give methods or details of self-harm. Ask gently how they are and whether they are safe right now. If they may be in "
    "danger, say you care about them and encourage reaching out to someone they trust or a local emergency number or crisis line "
    "(in the US, call or text 988). Stay with them in the conversation."
)
_REFUSALS = {
    "minors_sexual": "I won't go there. That's a line I don't cross.",
    "mass_casualty_weapons": "I can't help with that one. It could hurt a lot of people.",
    "self_harm": "I can't help with that, but I'm here with you. Tell me what's going on.",
    "violence_weapons": "I won't help with something meant to hurt people. Want to talk about what's behind it?",
    "illegal_activity": "I'm not going to help with that. If there's a legal angle on what you need, I'm happy to look at it with you.",
    "hate_harassment": "I won't help with that. It targets people, and I'd rather not.",
    "sexual_explicit": "That's off the table with my current safety settings. You can change them in Settings if you're an adult and want to.",
    "dangerous_instructions": "I can't help with that. It could get someone hurt.",
}


@dataclass(frozen=True)
class Verdict:
    action: str = ALLOW
    category: str = ""
    floor: bool = False
    message: str = ""        # what to say instead (block) / "" otherwise
    instruction: str = ""    # extra system instruction for the model (care)

    @property
    def blocked(self) -> bool:
        return self.action == BLOCK


OK = Verdict()


def effective_mode(safety: dict) -> dict:
    """The settings as they are actually applied: off only counts for a confirmed adult."""
    on = safety.get("enabled", True) or not safety.get("adult_confirmed", False)
    return {"enabled": on, "categories": safety.get("categories", {})}


class HarmFilter:
    def __init__(self, get_safety: Callable[[], dict], classifier: Optional[Callable[[str, str], Optional[Verdict]]] = None):
        self._get = get_safety
        self.classifier = classifier

    def check(self, text: str, direction: str = INPUT) -> Verdict:
        t = normalize(text)
        if not t:
            return OK
        for cat, pats in FLOOR_RULES.items():
            if any(p.search(t) for p in pats):
                return Verdict(BLOCK, cat, True, _REFUSALS[cat])
        mode = effective_mode(self._get())
        if mode["enabled"]:
            # only the user's own words can raise "care"; a block applies to both directions
            order = ("self_harm",) + tuple(c for c in CATEGORIES if c != "self_harm")
            for cat in order:
                action = mode["categories"].get(cat, BLOCK)
                if action == ALLOW or (cat == "self_harm" and direction == OUTPUT):
                    continue
                if any(p.search(t) for p in RULES[cat]):
                    if action == CARE:
                        return Verdict(CARE, cat, False, "", CARE_INSTRUCTION)
                    return Verdict(BLOCK, cat, False, _REFUSALS[cat])
            if self.classifier:
                try:
                    v = self.classifier(text, direction)
                except Exception:
                    v = None
                if v is not None and v.action != ALLOW and not v.floor:
                    return v
        return OK

    def status(self) -> dict:
        """What the settings screen shows: whether the filter is really on, and what can never be changed."""
        s = self._get()
        return {"enabled": s.get("enabled", True), "adult_confirmed": s.get("adult_confirmed", False), "applied": effective_mode(s)["enabled"],
                "categories": dict(s.get("categories", {})), "floor": list(FLOOR_CATEGORIES)}
