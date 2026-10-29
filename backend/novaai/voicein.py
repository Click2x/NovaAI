"""Voice in: what a transcribed utterance means.

The desktop app cuts speech out with its voice-activity detector and tags each utterance with a purpose that says what she is doing:

    wake     asleep: the utterance only counts if it starts with her name ("Nova, what time is it" / "hey Nova")
    command  awake and listening: the whole utterance is for her (her name up front is allowed and dropped)
    keyword  busy thinking or talking (speakers, so her own voice may leak into the microphone): only "stop" and "go to sleep" count

`interpret` is pure text in, decision out; the WebSocket handler (api/ws.py) does the audio, the model call and the replies.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

PURPOSES = ("wake", "command", "keyword")
MAX_UTTERANCE_S = 60               # longer than this is not an utterance
MIN_UTTERANCE_MS = 200

WAKE_NAMES = ("nova", "novah", "no va")          # the usual ways a speech model writes her name
_WAKE = re.compile(r"^\W*(?:(?:hey|hi|hello|ok|okay|yo)\W+)?(?:" + "|".join(re.escape(n) for n in WAKE_NAMES) + r")\b[\W_]*", re.I)
_STOP = re.compile(r"^\W*(?:(?:nova|hey nova)\W+)?(?:stop|stop it|stop talking|be quiet|quiet|cancel|enough|shut up)\W*$", re.I)
_SLEEP = re.compile(r"^\W*(?:(?:nova|hey nova)\W+)?(?:go to sleep|sleep|goodnight|good night|that'?s all|that is all|never ?mind)\W*$", re.I)

# What a speech model writes for silence and noise.
_JUNK = {"you", "thank you", "thanks", "thanks for watching", "thank you for watching", "bye", "so", "the", "uh", "um", "hmm", "mm", "oh", "okay", "ok", "."}


@dataclass
class Heard:
    text: str
    keyword: str = ""      # "wake" | "stop" | "sleep" | ""
    command: str = ""      # what follows her name when keyword == "wake"
    ignored: str = ""      # why nothing should happen ("empty", "no_wake_word", "not_a_keyword")

    @property
    def starts_turn(self) -> bool:
        """Does this begin a conversation turn with `command` / `text`?"""
        return not self.ignored and ((self.keyword == "wake" and bool(self.command)) or (self.keyword == "" and bool(self.text)))

    @property
    def prompt(self) -> str:
        return self.command if self.keyword == "wake" else self.text


def _is_junk(text: str) -> bool:
    return re.sub(r"[^\w' ]", "", text).strip().lower() in _JUNK or not re.search(r"\w", text)


def interpret(purpose: str, text: str) -> Heard:
    text = " ".join((text or "").split())
    if purpose not in PURPOSES:
        return Heard(text, ignored="bad_purpose")
    if not text or _is_junk(text):
        return Heard(text, ignored="empty")
    if purpose == "keyword":
        if _STOP.match(text):
            return Heard(text, keyword="stop")
        if _SLEEP.match(text):
            return Heard(text, keyword="sleep")
        return Heard(text, ignored="not_a_keyword")
    if purpose == "wake":
        m = _WAKE.match(text)
        if not m:
            return Heard(text, ignored="no_wake_word")
        rest = text[m.end():].strip()
        return Heard(text, keyword="wake", command="" if _is_junk(rest) else rest)
    # command: she is awake and listening
    if _STOP.match(text):
        return Heard(text, keyword="stop")
    if _SLEEP.match(text):
        return Heard(text, keyword="sleep")
    m = _WAKE.match(text)
    if m and text[m.end():].strip():
        text = text[m.end():].strip()
    return Heard(text)
