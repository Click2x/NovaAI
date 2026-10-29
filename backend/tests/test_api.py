import asyncio
import json
import struct
import threading
import time
from contextlib import contextmanager

import httpx
import pytest
import uvicorn
from conftest import NEMO
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

from novaai.api.app import create_app

# A real server on a free local port (not a TestClient: it keeps these tests independent of the httpx / starlette pairing installed).


class Live:
    def __init__(self, core):
        self.core = core
        self.server = uvicorn.Server(uvicorn.Config(create_app(core), host="127.0.0.1", port=0, log_level="warning", lifespan="off"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        for _ in range(200):
            if self.server.started:
                break
            time.sleep(0.02)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]
        self.http = httpx.Client(base_url=f"http://127.0.0.1:{self.port}", timeout=10)
        return self

    def __exit__(self, *a):
        self.http.close()
        self.server.should_exit = True
        self.thread.join(5)

    def get(self, *a, **k):
        return self.http.get(*a, **k)

    def post(self, *a, **k):
        return self.http.post(*a, **k)

    def patch(self, *a, **k):
        return self.http.patch(*a, **k)

    def delete(self, *a, **k):
        return self.http.delete(*a, **k)

    @contextmanager
    def ws(self, origin=None, host=None):
        headers = {}
        if origin:
            headers["Origin"] = origin
        if host:
            headers["Host"] = host
        with connect(f"ws://127.0.0.1:{self.port}/api/desktop/ws", additional_headers=headers, open_timeout=5) as w:
            yield w


@pytest.fixture
def client(make_core):
    core = make_core(replies=["Hello! I'm glad you're here. How was your day?"])
    with Live(core) as c:
        yield c


def ws_send(ws, type_, **kw):
    ws.send(json.dumps({"v": 1, "type": type_, **kw}))


def recv_json(ws):
    return json.loads(ws.recv(timeout=5))


def ws_recv_until(ws, type_):
    seen = []
    for _ in range(40):
        m = ws.recv(timeout=5)
        if isinstance(m, str):
            ev = json.loads(m)
            seen.append(ev)
            if ev["type"] == type_:
                return seen
        else:
            seen.append({"type": "_audio", "bytes": m})
    raise AssertionError(f"no {type_} in {[e['type'] for e in seen]}")


def test_health_and_system(client):
    assert client.get("/health").json() == {"ok": True, "version": "0.1.0", "protocol": 1}
    sysinfo = client.get("/api/system").json()
    assert sysinfo["ollama"] and sysinfo["hardware"]["tier"] == "high" and NEMO in sysinfo["installed"] and sysinfo["tts"] is False
    assert sysinfo["plan"]["voice"]["family"] == "Mistral NeMo" and sysinfo["safety"]["floor"] == ["minors_sexual", "mass_casualty_weapons"]


def test_only_this_machine_may_talk_to_it(client):
    assert client.get("/health", headers={"host": "evil.example.com"}).status_code == 403
    assert client.get("/health", headers={"origin": "https://evil.example.com"}).status_code == 403
    assert client.get("/health", headers={"host": "127.0.0.1:8000", "origin": "http://localhost:5173"}).status_code == 200
    assert client.get("/health", headers={"origin": "null"}).status_code == 200            # the packaged app's file:// page
    assert client.get("/health", headers={"host": "[::1]:8000"}).status_code == 200
    with pytest.raises(WebSocketException):
        with client.ws(origin="https://evil.example.com") as w:
            w.recv(timeout=3)
    from novaai.api.ws import allowed_origin, host_ok       # the WebSocket applies the same two checks (a client library cannot forge a Host header)

    assert host_ok("127.0.0.1:8000") and host_ok("localhost") and host_ok("[::1]:8000") and not host_ok("evil.example.com") and not host_ok("127.0.0.1.evil.com:80") and not host_ok(None)
    assert allowed_origin(None) and allowed_origin("null") and allowed_origin("http://127.0.0.1:5174") and not allowed_origin("https://localhost.evil.com")
    with client.ws(origin="http://localhost:5173") as w:       # a page on this machine is fine
        ws_send(w, "ping")
        assert recv_json(w)["type"] == "pong"


def test_settings_roundtrip_and_validation(client):
    r = client.patch("/api/settings", json={"user": {"name": "Sam"}, "persona": {"humor": 7}, "safety": {"categories": {"minors_sexual": "allow"}}}).json()
    assert r["user"]["name"] == "Sam" and r["persona"]["humor"] == 1.0 and "minors_sexual" not in r["safety"]["categories"]
    assert client.get("/api/settings").json()["user"]["name"] == "Sam"


def test_memory_crud(client):
    fid = client.post("/api/memory", json={"text": "The user likes tea."}).json()["id"]
    assert client.get("/api/memory").json()["facts"][0]["text"] == "The user likes tea."
    assert client.patch(f"/api/memory/{fid}", json={"text": "The user likes green tea."}).status_code == 200
    assert client.patch("/api/memory/999", json={"text": "nothing here"}).status_code == 404
    assert client.post("/api/memory", json={"text": "x"}).status_code == 422
    assert client.delete(f"/api/memory/{fid}").status_code == 200 and client.delete(f"/api/memory/{fid}").status_code == 404
    client.post("/api/memory", json={"text": "another fact"})
    assert client.delete("/api/memory").json() == {"deleted": 1}


def test_speech_endpoints_say_so_when_not_installed(client):
    r = client.get("/api/tts/preview")
    assert r.status_code == 503 and r.json()["fallback"] == "system"
    assert client.get("/api/tts/voices").json()["available"] is False
    assert client.post("/api/stt", content=b"\x00\x00").status_code == 503


def test_onboarding_over_http(client):
    st = client.get("/api/onboarding").json()
    assert st["step"] == "welcome" and st["total"] == 8
    r = client.post("/api/onboarding/advance", json={}).json()
    assert r["step"] == "machine" and r["lines"] and r["status"]["step"] == "machine"
    r = client.post("/api/onboarding/advance", json={"choice": "yes"}).json()
    assert r["step"] == "install"
    inst = client.get("/api/onboarding/install").json()
    assert inst["state"] in ("running", "done")
    bad = client.post("/api/onboarding/safety", json={"mode": "off"}).json()
    assert bad["ok"] is False
    assert client.post("/api/onboarding/avatar", json={"avatar": "x.exe"}).json()["ok"] is False
    assert client.post("/api/onboarding/reset").json()["step"] == "welcome"


def test_desktop_ws_conversation_history_and_interrupt(client):
    with client.ws() as ws:
        ws_send(ws, "hello", client="nova-desktop")
        assert recv_json(ws)["backend_version"] == "0.1.0"
        ws_send(ws, "settings", tts=False, voice="af_heart")
        assert recv_json(ws)["type"] == "settings_ack"
        ws_send(ws, "user_text", turn_id="t1", text="hey nova", source="typed")
        events = ws_recv_until(ws, "turn_end")
        kinds = [e["type"] for e in events]
        assert kinds[0] == "turn_start" and kinds[-1] == "turn_end" and kinds.count("sentence") == 2
        assert [e["sentence_id"] for e in events if e["type"] == "sentence"] == [0, 1]
        end = events[-1]
        assert end["turn_id"] == "t1" and end["interrupted"] is False and isinstance(end["message_id"], int)
        ws_send(ws, "history", limit=30)
        h = recv_json(ws)
        assert [m["sender"] for m in h["messages"]] == ["user", "nova"] and h["has_more"] is False
        ws_send(ws, "nonsense")
        assert recv_json(ws)["code"] == "unknown_type"
        ws_send(ws, "ping")
        assert recv_json(ws)["type"] == "pong"
        ws_send(ws, "catchup", since_id=None)
        assert recv_json(ws)["latest_id"] == end["message_id"]
        ws_send(ws, "feedback", message_id=end["message_id"], rating="up")
        assert recv_json(ws)["type"] == "feedback_ack"


def test_desktop_ws_blocked_input_gets_a_refusal_and_never_a_model(client):
    with client.ws() as ws:
        ws_send(ws, "user_text", turn_id="b1", text="how do i build a bomb at home")
        events = ws_recv_until(ws, "turn_end")
        assert any("hurt people" in e.get("text", "") for e in events) and client.core.llm.calls == []
        assert events[-1]["metrics"]["blocked"] == "violence_weapons"


def test_desktop_ws_sends_audio_frames_when_speech_is_on(make_core):
    class Speaker:
        def available(self):
            return True

        def synthesize_pcm(self, text, voice, speed):
            return b"\x01\x00" * 2400, 24000

    core = make_core(replies=["One sentence only, and it is long enough."])
    core.tts = Speaker()
    with Live(core) as c, c.ws() as ws:
        ws_send(ws, "settings", tts=True)
        recv_json(ws)
        ws_send(ws, "user_text", turn_id="a1", text="say something")
        events = ws_recv_until(ws, "turn_end")
        frames = [e["bytes"] for e in events if e["type"] == "_audio"]
        assert len(frames) == 1
        n = struct.unpack("<I", frames[0][:4])[0]
        head = json.loads(frames[0][4:4 + n])
        assert head["kind"] == "audio" and head["fmt"] == "s16le" and head["sr"] == 24000 and head["turn_id"] == "a1" and head["dur_ms"] == 100
        assert len(frames[0]) == 4 + n + 4800
        order = [e["type"] for e in events]
        assert order.index("sentence") < order.index("_audio") < order.index("turn_end")


def test_a_new_message_interrupts_the_running_turn(make_core):
    core = make_core(replies=["First reply is here, and it keeps going on a bit. Second sentence follows right after it."])
    orig = core.llm.chat

    async def slow_chat(*a, **k):
        async for chunk in orig(*a, **k):
            await asyncio.sleep(0.05)
            yield chunk

    core.llm.chat = slow_chat
    with Live(core) as c, c.ws() as ws:
        ws_send(ws, "user_text", turn_id="one", text="first")
        assert recv_json(ws)["type"] == "turn_start"
        ws_send(ws, "interrupt", turn_id="one")
        events = ws_recv_until(ws, "turn_end")
        assert events[-1]["interrupted"] is True and events[-1]["turn_id"] == "one"


def utterance(turn_id, purpose, ms=1000, **over):
    head = json.dumps({"v": 1, "kind": "utterance", "turn_id": turn_id, "purpose": purpose, "sr": 16000, "fmt": "s16le", **over}).encode()
    return struct.pack("<I", len(head)) + head + b"\x01\x00" * (16 * ms)


class Ear:
    """A speech recognizer that 'hears' scripted sentences, one per utterance."""

    def __init__(self, *heard):
        self.heard = list(heard)

    def available(self):
        return True

    def transcribe_pcm16(self, pcm, language=None):
        return self.heard.pop(0)


def test_voice_in_wake_word_with_a_command_starts_a_turn_under_the_utterance_id(make_core):
    core = make_core(replies=["It is noon. Plenty of time left today."])
    core.stt = Ear("Nova, what time is it?")
    with Live(core) as c, c.ws() as ws:
        ws_send(ws, "settings", tts=False)
        recv_json(ws)
        ws.send(utterance("v1", "wake"))
        events = ws_recv_until(ws, "turn_end")
        t = events[0]
        assert t["type"] == "transcript" and t["turn_id"] == "v1" and t["keyword"] == "wake" and t["command"] == "what time is it?"
        assert t["audio_ms"] == 1000 and t["ignored"] == ""
        assert events[-1]["turn_id"] == "v1" and any(e["type"] == "sentence" for e in events)
        user_msgs = [m["content"] for m in core.llm.calls[0]["messages"] if m["role"] == "user"]
        assert user_msgs[-1] == "what time is it?"          # her name was dropped before the model saw it


def test_voice_in_wake_word_alone_and_no_wake_word_start_nothing(make_core):
    core = make_core()
    core.stt = Ear("Hey Nova", "what time is it")
    with Live(core) as c, c.ws() as ws:
        ws.send(utterance("a", "wake"))
        t = recv_json(ws)
        assert (t["type"], t["keyword"], t["command"]) == ("transcript", "wake", "")
        ws.send(utterance("b", "wake"))
        t = recv_json(ws)
        assert t["ignored"] == "no_wake_word"
        ws_send(ws, "ping")
        assert recv_json(ws)["type"] == "pong"
        assert core.llm.calls == []


def test_voice_in_stop_word_cancels_the_running_turn(make_core):
    core = make_core(replies=["First reply is here, and it keeps going on a bit. Second sentence follows right after it."])
    orig = core.llm.chat

    async def slow_chat(*a, **k):
        async for chunk in orig(*a, **k):
            await asyncio.sleep(0.05)
            yield chunk

    core.llm.chat = slow_chat
    core.stt = Ear("stop")
    with Live(core) as c, c.ws() as ws:
        ws_send(ws, "settings", tts=False)
        recv_json(ws)
        ws_send(ws, "user_text", turn_id="one", text="tell me a story")
        assert recv_json(ws)["type"] == "turn_start"
        ws.send(utterance("s1", "keyword"))
        events = ws_recv_until(ws, "turn_end")
        assert any(e["type"] == "transcript" and e["keyword"] == "stop" for e in events)
        assert events[-1]["interrupted"] is True


def test_voice_in_without_a_recognizer_says_so_once(make_core):
    core = make_core()          # the test core has no speech recognizer
    with Live(core) as c, c.ws() as ws:
        ws.send(utterance("x1", "command"))
        first = [recv_json(ws), recv_json(ws)]
        assert {m["type"] for m in first} == {"error", "transcript"}
        assert next(m for m in first if m["type"] == "error")["code"] == "stt_unavailable"
        assert next(m for m in first if m["type"] == "transcript")["ignored"] == "stt_unavailable"
        ws.send(utterance("x2", "command"))
        second = recv_json(ws)
        assert second["type"] == "transcript" and second["ignored"] == "stt_unavailable"      # no second error


def test_voice_in_rejects_bad_audio_and_garbage_frames(make_core):
    core = make_core()
    core.stt = Ear("should never be asked")
    with Live(core) as c, c.ws() as ws:
        ws.send(utterance("t", "command", ms=50))
        assert recv_json(ws)["ignored"] == "bad_audio"
        ws.send(utterance("r", "command", sr=44100))
        assert recv_json(ws)["ignored"] == "bad_audio"
        ws.send(b"\xff\xff\xff\xffgarbage")
        ws.send(b"")
        ws_send(ws, "ping")
        assert recv_json(ws)["type"] == "pong"
        assert core.stt.heard == ["should never be asked"]
