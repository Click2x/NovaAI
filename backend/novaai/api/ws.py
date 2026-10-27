"""The desktop WebSocket, protocol v1 (the same one the Nova.Ai overlay and chat window already speak).

client -> server: hello, settings{tts,voice,speed,...}, user_text{turn_id,text}, interrupt{turn_id}, history{before_id,limit}, ping, catchup,
                  feedback / react (acknowledged), presence / window / screen / playback (accepted and ignored)
server -> client: hello_ack{server,protocol,features,backend_version}, turn_start, sentence{turn_id,sentence_id,text,emotion},
                  turn_end{turn_id,message_id,interrupted,metrics}, history{messages,has_more,before_id}, catchup, pong, error{code,message}
                  and, when speech is on and available, BINARY frames: [u32 LE header_len][JSON header][int16 PCM] per sentence.
"""
from __future__ import annotations

import asyncio
import json
import struct
import time
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import PROTOCOL, __version__
from ..core import Core
from ..engine import converse

FEATURES = ["history", "feedback", "react", "catchup"]
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
                await self.cancel()
                self.turn_id = str(data.get("turn_id") or f"t{int(time.time() * 1000)}")[:40]
                self.task = asyncio.create_task(self.run_turn(self.turn_id, text))
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
            if msg.get("text") is None:        # binary utterances: speech-to-text over this socket is not part of this server yet
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
        await conn.cancel()
