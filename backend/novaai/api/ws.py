"""The desktop WebSocket, protocol v1 (the same one the Nova.Ai overlay and chat window already speak).

client -> server: hello, settings{tts,voice,speed,...}, user_text{turn_id,text}, interrupt{turn_id}, history{before_id,limit}, ping, catchup,
                  feedback / react (acknowledged), presence / window / screen / playback (accepted and ignored)
                  and BINARY utterances: [u32 LE header_len][JSON {v,kind:"utterance",turn_id,purpose,sr:16000,fmt:"s16le"}][int16 PCM]
server -> client: hello_ack{server,protocol,features,backend_version}, turn_start, sentence{turn_id,sentence_id,text,emotion},
                  transcript{turn_id,purpose,text,keyword,command,ignored,stt_ms,audio_ms} for every utterance (see voicein.py); a command, or her
                  name followed by one, then starts a turn under that turn_id,
                  turn_end{turn_id,message_id,interrupted,metrics}, remembered{turn_id,facts:[{id,text,kind}]} when she saved something from what
                  the user said (learn.py; off with settings memory.auto_learn), history{messages,has_more,before_id}, catchup, pong, error{code,message}
                  and, when speech is on and available, BINARY frames: [u32 LE header_len][JSON header][int16 PCM] per sentence.
"""
from __future__ import annotations

import asyncio
import json
import struct
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import PROTOCOL, __version__, voicein
from ..core import Core
from ..engine import converse
from ..learn import learn

FEATURES = ["history", "feedback", "react", "catchup", "memory"]
router = APIRouter()


def allowed_origin(origin: str | None) -> bool:
    """No Origin (a native client), "null" or a file:// page (the packaged app), or a page on this machine."""
    if not origin or origin in ("null", "file://"):
        return True
    from urllib.parse import urlparse

    return (urlparse(origin).hostname or "") in ("localhost", "127.0.0.1", "::1")


LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1", "testserver"}


def host_ok(header: str | None) -> bool:
    """The Host header names this machine (stops a web page from reaching the server through a rebinding DNS name)."""
    h = (header or "").strip().lower()
    name = h.split("]")[0] + "]" if h.startswith("[") else h.rsplit(":", 1)[0] if ":" in h else h
    return name in LOCAL_HOSTS


@dataclass
class Conn:
    core: Core
    ws: WebSocket
    tts: bool = True
    voice: str = ""
    speed: float = 0.0
    task: asyncio.Task | None = None
    turn_id: str = ""
    stt_warned: bool = False
    stt_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    utterances: set = field(default_factory=set)      # running utterance tasks, so none is garbage-collected mid-flight
    learner: asyncio.Task | None = None               # background "what is worth remembering" pass (learn.py); dropped when a new turn starts
    unlearned: list = field(default_factory=list)     # user messages not yet looked at, so a cancelled pass loses nothing

    async def send(self, type_: str, **fields: Any) -> None:
        await self.ws.send_text(json.dumps({"v": PROTOCOL, "type": type_, **fields}))

    async def send_audio(self, turn_id: str, sentence_id: int, text: str, t0: float) -> None:
        s = self.core.s()
        tts = self.core.tts
        if not (self.tts and tts and tts.available()):
            return
        started = time.monotonic()
        try:
            pcm, sr = await asyncio.to_thread(tts.synthesize_pcm, text, self.voice or s["nova"]["voice"], self.speed or s["nova"]["speed"])
        except Exception as e:             # speech failing must never kill the turn: say so once and carry on as text
            await self.send("error", turn_id=turn_id, code="tts_failed", message=str(e)[:160])
            self.tts = False
            return
        if not pcm:
            return
        head = json.dumps({"v": PROTOCOL, "kind": "audio", "fmt": "s16le", "sr": sr, "turn_id": turn_id, "sentence_id": sentence_id,
                           "dur_ms": int(len(pcm) / 2 / sr * 1000), "tts_ms": int((time.monotonic() - started) * 1000), "t_ms": int((time.monotonic() - t0) * 1000)}).encode()
        await self.ws.send_bytes(struct.pack("<I", len(head)) + head + pcm)

    async def run_turn(self, turn_id: str, text: str) -> None:
        core, t0, interrupted, reply, n, blocked = self.core, time.monotonic(), False, [], 0, ""
        user_id = core.memory.add_message("user", text, turn_id)
        try:
            await self.send("turn_start", turn_id=turn_id)
            async for ev in converse(core, text):
                if ev["type"] == "sentence":
                    reply.append(ev["text"])
                    await self.send("sentence", turn_id=turn_id, sentence_id=n, text=ev["text"], emotion=ev["emotion"])
                    await self.send_audio(turn_id, n, ev["text"], t0)
                    n += 1
                else:
                    blocked = ev.get("blocked", "")
        except asyncio.CancelledError:
            interrupted = True
            raise
        except Exception as e:
            await self.send("error", turn_id=turn_id, code="turn_failed", message=f"{type(e).__name__}: {e}"[:200])
        finally:
            said = " ".join(reply).strip()
            mid = core.memory.add_message("nova", said, turn_id) if said else user_id
            try:
                await self.send("turn_end", turn_id=turn_id, message_id=mid, interrupted=interrupted, metrics={"total_ms": int((time.monotonic() - t0) * 1000), "blocked": blocked})
            except Exception:
                pass
            if said and not blocked and not interrupted:
                self.unlearned = (self.unlearned + [text])[-6:]
                self.learner = asyncio.create_task(self.run_learn(turn_id))

    async def run_learn(self, turn_id: str) -> None:
        """After a turn: save lasting facts from what the user said, then tell the app so it can say "I'll remember that"."""
        texts = list(self.unlearned)
        saved = await learn(self.core, "\n".join(texts))
        self.unlearned = self.unlearned[len(texts):]
        if saved:
            try:
                await self.send("remembered", turn_id=turn_id, facts=saved)
            except Exception:
                pass

    async def cancel_learning(self) -> None:
        if self.learner and not self.learner.done():
            self.learner.cancel()
            try:
                await self.learner
            except (asyncio.CancelledError, Exception):
                pass

    async def start_turn(self, turn_id: str, text: str) -> None:
        await self.cancel_learning()          # a new message comes first; the model is needed for her answer
        await self.cancel()
        self.turn_id = turn_id
        self.task = asyncio.create_task(self.run_turn(turn_id, text))

    async def utterance(self, frame: bytes) -> None:
        """A binary frame from the app's voice-activity detector: [u32 LE header_len][JSON header][int16 PCM, 16 kHz mono].
        Answers with a `transcript` message; when it was a command (or her name followed by one) the turn starts under the same turn_id."""
        try:
            n = struct.unpack("<I", frame[:4])[0]
            head = json.loads(frame[4:4 + n])
            pcm = frame[4 + n:]
        except (struct.error, ValueError):
            return
        if not isinstance(head, dict) or head.get("kind") != "utterance" or head.get("v") != PROTOCOL:
            return
        turn_id = str(head.get("turn_id") or f"v{int(time.time() * 1000)}")[:40]
        purpose = head.get("purpose") if head.get("purpose") in voicein.PURPOSES else "command"
        audio_ms = int(len(pcm) / 2 / 16000 * 1000)
        reply = {"turn_id": turn_id, "purpose": purpose, "audio_ms": audio_ms}
        if head.get("fmt") != "s16le" or head.get("sr") != 16000 or audio_ms < voicein.MIN_UTTERANCE_MS or audio_ms > voicein.MAX_UTTERANCE_S * 1000:
            await self.send("transcript", text="", ignored="bad_audio", stt_ms=0, **reply)
            return
        stt = self.core.stt
        if not (stt and stt.available()):
            if not self.stt_warned:      # once per connection: the app keeps cutting speech out whether or not anything can read it
                self.stt_warned = True
                await self.send("error", code="stt_unavailable", message="Speech recognition is not installed on this backend (pip install faster-whisper).")
            await self.send("transcript", text="", ignored="stt_unavailable", stt_ms=0, **reply)
            return
        started = time.monotonic()
        try:
            async with self.stt_lock:        # one at a time, in the order they were spoken
                text = await asyncio.to_thread(stt.transcribe_pcm16, pcm)
        except Exception as e:
            await self.send("error", turn_id=turn_id, code="stt_failed", message=str(e)[:160])
            await self.send("transcript", text="", ignored="stt_failed", stt_ms=int((time.monotonic() - started) * 1000), **reply)
            return
        heard = voicein.interpret(purpose, text)
        await self.send("transcript", text=heard.text, keyword=heard.keyword, command=heard.command, ignored=heard.ignored,
                        stt_ms=int((time.monotonic() - started) * 1000), **reply)
        if heard.keyword in ("stop", "sleep"):
            await self.cancel()
        elif heard.starts_turn:
            await self.start_turn(turn_id, heard.prompt[:4000])

    async def cancel(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass

    async def handle(self, data: dict) -> None:
        t = data.get("type")
        if t == "hello":
            await self.send("hello_ack", server="novaai", protocol=PROTOCOL, features=FEATURES, backend_version=__version__)
        elif t == "ping":
            await self.send("pong")
        elif t == "settings":
            if isinstance(data.get("tts"), bool):
                self.tts = data["tts"]
            if isinstance(data.get("voice"), str) and 3 <= len(data["voice"]) <= 30:
                self.voice = data["voice"]
            if isinstance(data.get("speed"), (int, float)) and not isinstance(data["speed"], bool):
                self.speed = float(data["speed"])
            await self.send("settings_ack")
        elif t == "user_text":
            text = str(data.get("text", "")).strip()[:4000]
            if text:
                await self.start_turn(str(data.get("turn_id") or f"t{int(time.time() * 1000)}")[:40], text)
        elif t == "interrupt":
            if not data.get("turn_id") or data.get("turn_id") == self.turn_id:
                await self.cancel()
        elif t == "history":
            limit = data.get("limit") if isinstance(data.get("limit"), int) else 30
            before = data.get("before_id") if isinstance(data.get("before_id"), int) else None
            rows, more = self.core.memory.history(max(1, min(limit, 100)), before)
            await self.send("history", before_id=before, has_more=more,
                            messages=[{"id": r["id"], "sender": "user" if r["role"] == "user" else "nova", "text": r["text"], "timestamp": r["created"]} for r in rows])
        elif t == "catchup":
            rows, _ = self.core.memory.history(1)
            await self.send("catchup", latest_id=rows[-1]["id"] if rows else None, messages=[], reviews=[])
        elif t == "feedback":
            await self.send("feedback_ack", message_id=data.get("message_id"), rating=data.get("rating"))
        elif t == "react":
            await self.send("react_ack", message_id=data.get("message_id"), reactions=[data["emoji"]] if isinstance(data.get("emoji"), str) else [])
        elif t in ("presence", "window", "screen", "screen_denied", "playback", "speak"):
            return
        else:
            await self.send("error", code="unknown_type", message=f"unknown message type: {str(t)[:40]}")


@router.websocket("/api/desktop/ws")
async def desktop_ws(ws: WebSocket) -> None:
    core: Core = ws.app.state.core
    if not allowed_origin(ws.headers.get("origin")) or not host_ok(ws.headers.get("host")):
        await ws.close(code=1008)
        return
    await ws.accept()
    conn = Conn(core=core, ws=ws)
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("text") is None:        # a binary utterance: transcribed in its own task so the socket keeps answering (stop, ping, ...)
                if msg.get("bytes"):
                    task = asyncio.create_task(conn.utterance(msg["bytes"]))
                    conn.utterances.add(task)
                    task.add_done_callback(conn.utterances.discard)
                continue
            try:
                data = json.loads(msg["text"])
            except ValueError:
                continue
            if isinstance(data, dict) and data.get("v") == PROTOCOL:
                await conn.handle(data)
    except WebSocketDisconnect:
        pass
    finally:
        for t in list(conn.utterances):
            t.cancel()
        await conn.cancel_learning()
        await conn.cancel()
