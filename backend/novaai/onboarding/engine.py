"""Guided, voiced onboarding as a small state machine.

welcome -> machine -> install -> meet -> voice -> safety -> avatar -> done

The first three steps are scripted (no model exists yet). `meet` is a real conversation: the voice model talks, and after every user
message the tools model fills a profile (name, what to call her, tone, interests, boundaries) through a function call, with plain
rules as a fallback, so the person never fills a form and she never interrogates them. Every step returns `lines` (id, text, emotion): the
desktop app speaks them with the cached TTS (or the system voice) and shows them as her bubble. State is saved after every change, so
closing the app mid-way resumes where it stopped.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import time
from typing import Any

from ..core import Core
from ..engine import converse
from ..llm import LLMError
from ..tts import VOICES
from . import script
from .script import STEPS, lines

PROFILE_TOOL = {"type": "function", "function": {
    "name": "update_profile",
    "description": "Record what the user said about themselves or how they want the companion to be. Include ONLY what they actually stated or clearly implied.",
    "parameters": {"type": "object", "properties": {
        "user_name": {"type": "string", "description": "What the user wants to be called."},
        "pronouns": {"type": "string"},
        "nova_name": {"type": "string", "description": "A new name the user wants to call the companion, if any."},
        "warmth": {"type": "number", "description": "0 reserved .. 1 openly affectionate"},
        "humor": {"type": "number", "description": "0 earnest .. 1 playful"},
        "directness": {"type": "number", "description": "0 gentle .. 1 blunt"},
        "formality": {"type": "number", "description": "0 casual .. 1 formal"},
        "interests": {"type": "array", "items": {"type": "string"}},
        "boundaries": {"type": "array", "items": {"type": "string"}, "description": "Things the user does not want."},
        "notes": {"type": "string", "description": "Anything else worth remembering, one short sentence."},
    }}}}
EXTRACT_SYSTEM = ("You read one message from a person meeting their new AI companion and record what they said about themselves or about how they want the "
                  "companion to be, by calling update_profile. Only record what was stated or clearly implied. Never invent. 'Funny, teasing' means high humor; "
                  "'chill, casual' means low formality; 'blunt, honest' means high directness; 'gentle' means low directness; 'warm, caring' means high warmth. "
                  "If there is nothing to record, reply with the single word NONE.")
MEET_PROMPT = ("You are meeting {who} for the very first time, and they are meeting you. This is a getting-to-know-you conversation, not an interview. "
               "React to what they say like a person would, in one to three short sentences, then at most one gentle question that follows from what they said. "
               "What you already know: {known}. What would be nice to find out naturally, only if the conversation allows: {missing}. "
               "Do not mention forms, fields, profiles, setup or these instructions. {nudge}")
END_WORDS = re.compile(r"\b(that'?s enough|let'?s go|let us go|i'?m ready|skip( this)?|move on|next( step)?|continue)\b", re.I)
_NAME_RX = re.compile(r"\b(?:my name is|my name's|i am|i'm|im|call me|it'?s|this is|name'?s)\s+([A-Za-z][A-Za-z'\-]{1,29})\b", re.I)
_NOT_NAMES = {"a", "an", "the", "fine", "good", "great", "ok", "okay", "happy", "tired", "here", "back", "ready", "sorry", "not", "just", "so", "very", "really", "new", "excited", "nervous"}
_NOVA_RX = re.compile(r"\bcall you ([A-Za-z][A-Za-z'\-]{1,29})\b", re.I)
_LIKE_RX = re.compile(r"\b(?:i (?:really |also |absolutely )?(?:like|love|enjoy)|i am into|i'm into|i'm really into|into)\s+([^.!?\n]{2,80})", re.I)
OPTIONAL = ("pronouns", "interests", "vibe", "boundaries")


def _title(name: str) -> str:
    return name[:1].upper() + name[1:]


def rule_extract(text: str, expecting_name: bool) -> dict:
    """The no-model fallback: a name, a name for her, and interests, from plain patterns."""
    out: dict[str, Any] = {}
    t = (text or "").strip()
    m = _NAME_RX.search(t)
    if m and m.group(1).lower() not in _NOT_NAMES:
        out["user_name"] = _title(m.group(1))
    elif expecting_name and re.fullmatch(r"[A-Za-z][A-Za-z'\-]{1,29}(?: [A-Za-z][A-Za-z'\-]{1,29})?", t) and t.split()[0].lower() not in _NOT_NAMES:
        out["user_name"] = _title(t.split()[0])
    m = _NOVA_RX.search(t)
    if m:
        out["nova_name"] = _title(m.group(1))
    m = _LIKE_RX.search(t)
    if m:
        items = [x.strip(" .,") for x in re.split(r",|\band\b", m.group(1)) if x.strip(" .,")]
        if items:
            out["interests"] = items[:6]
    return out


def clean_update(raw: Any) -> dict:
    """Keep only well-formed fields of a model's update_profile call."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for k in ("user_name", "pronouns", "nova_name"):
        v = raw.get(k)
        if isinstance(v, str) and v.strip() and len(v.strip()) <= 40 and v.strip().lower() not in ("none", "null", "unknown", "n/a"):
            out[k] = v.strip()
    for k in ("warmth", "humor", "directness", "formality"):
        v = raw.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1:
            out[k] = float(v)
    for k in ("interests", "boundaries"):
        v = raw.get(k)
        if isinstance(v, list):
            items = [x.strip() for x in v if isinstance(x, str) and x.strip()][:8]
            if items:
                out[k] = items
    v = raw.get("notes")
    if isinstance(v, str) and v.strip():
        out["notes"] = v.strip()[:300]
    return out


class Onboarding:
    def __init__(self, core: Core):
        self.core = core
        self.path = core.home / "onboarding.json"
        self.state = self._load()
        self._install_task: asyncio.Task | None = None

    # ── persistence ──
    def _fresh(self) -> dict:
        return {"step": "welcome", "seed": int(time.time()) % 9973, "turns": 0, "transcript": [], "learned": {}, "install": {"state": "idle", "percent": 0, "lines": [], "chosen": {}, "error": ""}}

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            base = self._fresh()
            if isinstance(data, dict) and data.get("step") in STEPS:
                base.update({k: data[k] for k in base if k in data})
                if base["install"].get("state") == "running":      # the app closed mid-download: let it start again
                    base["install"]["state"] = "idle"
                return base
        except (OSError, ValueError):
            pass
        return self._fresh()

    def _save(self) -> None:
        self.state["transcript"] = self.state["transcript"][-30:]
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.state, f)
        os.replace(tmp, self.path)

    def reset(self) -> None:
        self.state = self._fresh()
        self._save()

    @property
    def step(self) -> str:
        return self.state["step"]

    def _L(self, line_id: str, **fmt) -> list[dict]:
        s = self.core.s()
        return lines(line_id, self.state["seed"], name=s["user"]["name"] or "friend", **fmt)

    def _go(self, step: str) -> None:
        self.state["step"] = step
        self._save()

    # ── status ──
    def known(self) -> dict:
        s = self.core.s()
        return {"user_name": s["user"]["name"], "pronouns": s["user"]["pronouns"], "nova_name": s["nova"]["name"], **s["persona"]}

    def missing(self) -> list[str]:
        s, learned = self.core.s(), self.state["learned"]
        miss = [] if s["user"]["name"] else ["their name"]
        if not s["user"]["pronouns"] and "pronouns" not in learned:
            miss.append("pronouns")
        if not s["persona"]["interests"]:
            miss.append("what they are into")
        if not any(k in learned for k in ("warmth", "humor", "directness", "formality")):
            miss.append("what kind of companion they'd like (warm, funny, blunt, calm)")
        if not s["persona"]["boundaries"]:
            miss.append("anything they would rather I never do")
        return miss

    def status(self) -> dict:
        s = self.core.s()
        return {
            "step": self.step, "index": STEPS.index(self.step), "total": len(STEPS), "done": s["onboarding"]["done"],
            "name": s["user"]["name"], "missing": self.missing(), "install": self.install_status(),
            "tts_available": bool(self.core.tts and self.core.tts.available()), "voice": s["nova"]["voice"],
            "safety": self.core.harm.status(), "avatar": s["nova"]["avatar"], "hardware": self.core.hardware.to_dict(),
        }

    def install_status(self) -> dict:
        i = self.state["install"]
        return {"state": i["state"], "percent": i["percent"], "lines": list(i["lines"]), "chosen": dict(i["chosen"]), "error": i["error"]}

    # ── plan ──
    async def plan(self) -> dict:
        return (await self.core.router()).plan(self.core.s())

    def _plan_lines(self, plan: dict) -> list[dict]:
        hw = self.core.hardware
        out = self._L("machine_" + hw.tier, gpu=hw.gpu_name or "no graphics card", vram=f"{hw.vram_gb:g}")
        todo = [d for d in plan["download"] if not d["installed"]]
        v, t = plan["voice"], plan["tools"]
        if not v:
            return out + self._L("install_none")
        if not todo:
            out += self._L("plan_ready")
        else:
            key = "plan_one" if len(plan["download"]) == 1 or not t or t["tag"] == v["tag"] else "plan_two"
            out += self._L(key, voice=f"{v['family']} {v['variant'] if v['variant'] != 'regular' else ''}".strip(), tools=f"{t['family']} from {t['origin'] or 'the community'}" if t else "", gb=f"{plan['download_gb']:g}")
        return out + self._L("plan_ask")

    # ── moving through the steps ──
    async def advance(self, choice: str | None = None) -> dict:
        step, lns = self.step, []
        if step == "welcome":
            self._go("machine")
            plan = await self.plan()
            lns = self._plan_lines(plan)
            return {"step": self.step, "lines": lns, "plan": plan}
        if step == "machine":
            plan = await self.plan()
            if not plan["voice"]:
                return {"step": "machine", "lines": self._L("install_none"), "plan": plan}
            self._go("install")
            todo = [d for d in plan["download"] if not d["installed"]]
            if todo and not await self.core.llm.alive():
                self.state["install"].update(state="needs_ollama", error="Ollama is not running")
                self._save()
                return {"step": "install", "lines": self._L("needs_ollama"), "plan": plan}
            lns = self._L("install_start") if todo else []
            self.start_install()
            return {"step": "install", "lines": lns, "plan": plan}
        if step == "install":
            st = self.state["install"]
            if st["state"] == "needs_ollama":                     # the person says they installed it: check again
                if await self.core.llm.alive():
                    self.state["install"].update(state="idle", error="")
                    self.start_install()
                    return {"step": "install", "lines": self._L("install_start")}
                return {"step": "install", "lines": self._L("needs_ollama")}
            if st["state"] != "done":
                return {"step": "install", "lines": [], "waiting": True}
            self._go("meet")
            return {"step": "meet", "lines": await self._meet_open()}
        if step == "meet":
            return await self._leave_meet()
        if step == "voice":
            self._go("safety")
            return {"step": "safety", "lines": self._L("safety_intro")}
        if step == "safety":
            self._go("avatar")
            return {"step": "avatar", "lines": self._L("avatar_intro")}
        if step == "avatar":
            return await self.finish()
        return {"step": step, "lines": []}

    # ── install ──
    def start_install(self) -> None:
        if self._install_task and not self._install_task.done():
            return
        self.state["install"].update(state="running", percent=0, lines=[], error="")
        self._save()
        self._install_task = asyncio.ensure_future(self._run_install())

    async def wait_install(self) -> None:
        if self._install_task:
            await self._install_task

    def _narrate(self, line_id: str, **fmt) -> None:
        self.state["install"]["lines"].extend(self._L(line_id, **fmt))

    async def _ensure_role(self, role: str, base: float, span: float, first: str = "") -> dict | None:
        """Make the best usable model for `role` available: installed, or pulled; verified for tool support when the role needs it.
        `first` is the tag the plan promised the person; it is tried before the router's current ranking (which, once the voice model is
        installed, would otherwise prefer that same installed model for tools)."""
        core = self.core
        router = await core.router()
        pick = router.pick(role, core.s())
        ordered = sorted(pick.candidates, key=lambda c: c.tag != first)
        for cand in ordered:
            try:
                if not router.is_installed(cand):
                    last = -1
                    async for ev in core.llm.pull(cand.tag):
                        tot, done = ev.get("total") or 0, ev.get("completed") or 0
                        if tot:
                            pct = base + span * min(done / tot, 1.0)
                            self.state["install"]["percent"] = int(pct)
                            for mark in (25, 50, 75):
                                if last < mark <= pct:
                                    self._narrate(f"install_{mark}")
                            last = int(pct)
                    core.forget_installed()
                info = await core.llm.show(cand.tag)
                if info is None:
                    raise LLMError(f"{cand.tag} did not install")
                if role == "tools" and "tools" not in (info.get("capabilities") or []):
                    raise LLMError(f"{cand.tag} cannot call tools")
                return cand.to_dict()
            except LLMError as e:
                self._narrate("install_failed", tag=cand.tag, reason=str(e)[:120] + ".")
        return None

    async def _run_install(self) -> None:
        st = self.state["install"]
        try:
            plan = await self.plan()
            roles = ["voice"] if len(plan["download"]) == 1 else ["voice", "tools"]
            chosen: dict[str, dict] = {}
            for i, role in enumerate(roles):
                got = await self._ensure_role(role, 100.0 * i / len(roles), 100.0 / len(roles), (plan.get(role) or {}).get("tag", ""))
                if got:
                    chosen[role] = got
                self._save()
            if "voice" not in chosen:
                st.update(state="error", error="no voice model could be installed")
                self._narrate("install_none")
            else:
                if len(roles) == 1 or "tools" not in chosen:      # one model does both jobs: do not let the router go and fetch a second one later
                    self.core.settings.patch({"models": {"tools_override": chosen["voice"]["tag"]}})
                    chosen.setdefault("tools", chosen["voice"])
                st.update(state="done", percent=100, chosen=chosen)
                self._narrate("install_done")
                self._save()
                await self.core.llm.warm(chosen["voice"]["tag"])      # load her voice now, while the install lines are still being spoken
        except Exception as e:            # the app must never be left waiting on a dead task
            st.update(state="error", error=f"{type(e).__name__}: {e}"[:200])
        finally:
            self._save()

    # ── meet: the conversation ──
    async def _meet_open(self) -> list[dict]:
        return self._L("meet_open")

    def _meet_extra(self, nudge: str = "") -> str:
        s = self.core.s()
        known = ", ".join(f"{k}: {v}" for k, v in (("name", s["user"]["name"]), ("interests", ", ".join(s["persona"]["interests"]))) if v) or "nothing yet"
        return MEET_PROMPT.format(who=s["user"]["name"] or "someone", known=known, missing="; ".join(self.missing()) or "nothing more", nudge=nudge)

    async def _extract(self, text: str, last_question: str) -> dict:
        upd: dict[str, Any] = {}
        r = await self.core.router()
        pick = r.pick("tools", self.core.s())
        for cand in [c for c in pick.candidates if r.is_installed(c)][:2]:
            try:
                msgs = [{"role": "system", "content": EXTRACT_SYSTEM}, {"role": "user", "content": f"Companion asked: {last_question or '(opening)'}\nUser said: {text}"}]
                reply = await self.core.llm.complete(cand.tag, msgs, tools=[PROFILE_TOOL], think=False)
                for call in reply.get("tool_calls") or []:
                    fn = call.get("function") or {}
                    if fn.get("name") == "update_profile":
                        args = fn.get("arguments")
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except ValueError:
                                args = {}
                        upd.update(clean_update(args))
                break
            except LLMError:
                continue
        fallback = rule_extract(text, expecting_name=not self.core.s()["user"]["name"])
        for k, v in fallback.items():          # rules only fill what the model did not
            upd.setdefault(k, v)
        return upd

    def _apply(self, upd: dict) -> dict:
        s = self.core.s()
        patch: dict[str, dict] = {"user": {}, "nova": {}, "persona": {}}
        if "user_name" in upd:
            patch["user"]["name"] = upd["user_name"]
        if "pronouns" in upd:
            patch["user"]["pronouns"] = upd["pronouns"]
        if "nova_name" in upd:
            patch["nova"]["name"] = upd["nova_name"]
        for k in ("warmth", "humor", "directness", "formality"):
            if k in upd:
                patch["persona"][k] = upd[k]
                self.state["learned"][k] = True
        for k in ("interests", "boundaries"):
            if k in upd:
                merged = s["persona"][k] + [x for x in upd[k] if x.lower() not in [y.lower() for y in s["persona"][k]]]
                patch["persona"][k] = merged
        if "pronouns" in upd:
            self.state["learned"]["pronouns"] = True
        if "notes" in upd:
            patch["persona"]["notes"] = (s["persona"]["notes"] + " " + upd["notes"]).strip()[-1000:]
        self.core.settings.patch({k: v for k, v in patch.items() if v})
        for x in upd.get("interests", []):
            self.core.memory.add_fact(f"The user is into {x}.", kind="preference", source="onboarding")
        for x in upd.get("boundaries", []):
            self.core.memory.add_fact(f"The user does not want: {x}.", kind="boundary", source="onboarding")
        return upd

    def _ready(self, text: str) -> bool:
        s, turns = self.core.s(), self.state["turns"]
        if not s["user"]["name"]:
            return False
        filled = 4 - len([m for m in self.missing() if m != "their name"])
        return bool(END_WORDS.search(text)) or turns >= 7 or turns >= 4 or (turns >= 3 and filled >= 3)

    async def say(self, text: str) -> dict:
        """One user message during `meet` (typed or transcribed). Returns her reply as lines, plus whether setup moved on."""
        if self.step != "meet":
            return {"step": self.step, "lines": []}
        text = (text or "").strip()[:2000]
        if not text:
            return {"step": "meet", "lines": []}
        st = self.state
        st["turns"] += 1
        last_q = next((m["content"] for m in reversed(st["transcript"]) if m["role"] == "assistant"), "")
        applied = self._apply(await self._extract(text, last_q))
        nudge = "" if self.core.s()["user"]["name"] or st["turns"] < 2 else "You still do not know their name: work it in warmly."
        out: list[dict] = []
        reply_text, i = [], 0
        async for ev in converse(self.core, text, extra_system=self._meet_extra(nudge), use_tools=False, history=list(st["transcript"][-10:])):
            if ev["type"] == "sentence":
                out.append({"id": f"meet.{st['turns']}.{i}", "text": ev["text"], "emotion": ev["emotion"]})
                reply_text.append(ev["text"])
                i += 1
        st["transcript"] += [{"role": "user", "content": text}, {"role": "assistant", "content": " ".join(reply_text)}]
        self._save()
        res = {"step": "meet", "lines": out, "learned": applied, "missing": self.missing()}
        if self._ready(text):
            nxt = await self._leave_meet()
            res.update(step=nxt["step"], lines=out + nxt["lines"])
        elif not self.core.s()["user"]["name"] and st["turns"] >= 3:
            res["lines"] = out + self._L("meet_name_again")
        return res

    async def _leave_meet(self) -> dict:
        s = self.core.s()
        if not s["user"]["name"]:
            return {"step": "meet", "lines": self._L("meet_name_again")}
        self.core.memory.add_fact(f"The user's name is {s['user']['name']}.", kind="identity", source="onboarding")
        bridge = self._L("meet_bridge")
        self._go("voice")
        if self.core.tts and self.core.tts.available():
            return {"step": "voice", "lines": bridge + self._L("voice_intro"), "voices": self.voices()}
        self._go("safety")
        return {"step": "safety", "lines": bridge + self._L("voice_skip") + self._L("safety_intro")}

    # ── voice / safety / avatar ──
    def voices(self) -> list[dict]:
        name = self.core.s()["user"]["name"] or "there"
        return [{"id": v, "label": label, "feel": feel, "sample": f"Hi {name}. I'm {self.core.s()['nova']['name']}. This is how I'd sound."} for v, label, feel in VOICES]

    def set_voice(self, voice: str, speed: float | None = None) -> dict:
        patch: dict[str, Any] = {"voice": voice}
        if speed is not None:
            patch["speed"] = speed
        got = self.core.settings.patch({"nova": patch})["nova"]
        if got["voice"] != voice:
            return {"ok": False, "error": "unknown voice", "lines": []}
        if self.step == "voice":
            self._go("safety")
            return {"ok": True, "step": "safety", "lines": self._L("voice_picked") + self._L("safety_intro")}
        return {"ok": True, "step": self.step, "lines": []}

    async def set_safety(self, mode: str, adult_confirmed: bool = False, confirm: bool = False) -> dict:
        """mode: standard (filter on), relaxed (adult content allowed, the rest on), off. relaxed and off need the adult confirmation."""
        if mode not in ("standard", "relaxed", "off"):
            return {"ok": False, "error": "unknown mode", "lines": []}
        if mode != "standard" and not (adult_confirmed and confirm):
            return {"ok": False, "error": "adult confirmation required", "lines": self._L("safety_need_adult")}
        base = {"categories": {c: v for c, v in self.core.settings.get()["safety"]["categories"].items()}}
        if mode == "standard":
            patch = {"enabled": True, **base}
            say = "safety_standard"
        elif mode == "relaxed":
            base["categories"]["sexual_explicit"] = "allow"
            patch = {"enabled": True, "adult_confirmed": True, **base}
            say = "safety_relaxed"
        else:
            patch = {"enabled": False, "adult_confirmed": True}
            say = "safety_off"
        self.core.settings.patch({"safety": patch})
        out = {"ok": True, "lines": self._L(say), "safety": self.core.harm.status()}
        if mode == "off":                         # the router now prefers the abliterated models: tell the app if a download is needed
            plan = await self.plan()
            out["plan"] = plan
            out["needs_download"] = any(not d["installed"] for d in plan["download"])
        if self.step == "safety":
            self._go("avatar")
            out.update(step="avatar", lines=out["lines"] + self._L("avatar_intro"))
        return out

    def set_avatar(self, avatar: str) -> dict:
        got = self.core.settings.patch({"nova": {"avatar": avatar}})["nova"]["avatar"]
        if got != avatar:
            return {"ok": False, "error": "avatar must be 'default' or a .vrm file path", "lines": []}
        return {"ok": True, "avatar": got, "lines": []}

    async def finish(self) -> dict:
        self.core.settings.patch({"onboarding": {"done": True}})
        self._go("done")
        return {"step": "done", "lines": self._L("done"), "done": True}
