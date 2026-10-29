"""The FastAPI app: REST for setup, settings, memory and speech; the desktop WebSocket for conversation.
Loopback only: the Host header must be this machine and a browser Origin must be this machine (or the packaged app's file:// page)."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import PROTOCOL, __version__
from ..core import Core
from ..onboarding import Onboarding
from ..tts import VOICES, TTSUnavailable
from . import ws

class Say(BaseModel):
    text: str = Field(max_length=2000)


class Advance(BaseModel):
    choice: Optional[str] = Field(default=None, max_length=40)


class VoicePick(BaseModel):
    voice: str = Field(max_length=30)
    speed: Optional[float] = None


class SafetyPick(BaseModel):
    mode: str = Field(max_length=12)
    adult_confirmed: bool = False
    confirm: bool = False


class AvatarPick(BaseModel):
    avatar: str = Field(max_length=260)


class FactIn(BaseModel):
    text: str = Field(max_length=400)


def create_app(core: Core | None = None) -> FastAPI:
    core = core or Core.create()
    app = FastAPI(title="NovaAI backend", version=__version__)
    app.state.core = core
    app.state.onboarding = Onboarding(core)

    @app.middleware("http")
    async def loopback_only(request: Request, call_next):
        if not ws.host_ok(request.headers.get("host")) or not ws.allowed_origin(request.headers.get("origin")):
            return JSONResponse({"detail": "this server only answers the local machine"}, status_code=403)
        resp = await call_next(request)
        origin = request.headers.get("origin")
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Headers"] = "content-type"
            resp.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,PUT,DELETE,OPTIONS"
        return resp

    @app.options("/{path:path}")
    async def preflight(path: str) -> Response:
        return Response(status_code=204)

    app.include_router(ws.router)
    ob = lambda: app.state.onboarding  # noqa: E731

    # ── system ──
    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "version": __version__, "protocol": PROTOCOL}

    @app.get("/api/system")
    async def system() -> dict:
        return {"version": __version__, "hardware": core.hardware.to_dict(), "ollama": await core.llm.alive(), "installed": sorted(await core.installed(0)),
                "plan": (await core.router()).plan(core.s()), "tts": bool(core.tts and core.tts.available()), "stt": bool(core.stt and core.stt.available()),
                "safety": core.harm.status()}

    @app.get("/api/settings")
    async def get_settings() -> dict:
        return core.s()

    @app.patch("/api/settings")
    async def patch_settings(patch: dict[str, Any]) -> dict:
        return core.settings.patch(patch)

    @app.get("/api/safety")
    async def safety() -> dict:
        return core.harm.status()

    # ── onboarding ──
    @app.get("/api/onboarding")
    async def onboarding_status() -> dict:
        return ob().status()

    @app.post("/api/onboarding/advance")
    async def onboarding_advance(body: Advance) -> dict:
        return {**await ob().advance(body.choice), "status": ob().status()}

    @app.post("/api/onboarding/say")
    async def onboarding_say(body: Say) -> dict:
        return {**await ob().say(body.text), "status": ob().status()}

    @app.get("/api/onboarding/install")
    async def onboarding_install() -> dict:
        return ob().install_status()

    @app.post("/api/onboarding/install")
    async def onboarding_install_start() -> dict:
        ob().start_install()
        return ob().install_status()

    @app.get("/api/onboarding/voices")
    async def onboarding_voices() -> dict:
        return {"voices": ob().voices(), "available": bool(core.tts and core.tts.available())}

    @app.post("/api/onboarding/voice")
    async def onboarding_voice(body: VoicePick) -> dict:
        return {**ob().set_voice(body.voice, body.speed), "status": ob().status()}

    @app.post("/api/onboarding/safety")
    async def onboarding_safety(body: SafetyPick) -> dict:
        return {**await ob().set_safety(body.mode, body.adult_confirmed, body.confirm), "status": ob().status()}

    @app.post("/api/onboarding/avatar")
    async def onboarding_avatar(body: AvatarPick) -> dict:
        return {**ob().set_avatar(body.avatar), "status": ob().status()}

    @app.post("/api/onboarding/reset")
    async def onboarding_reset() -> dict:
        ob().reset()
        core.settings.patch({"onboarding": {"done": False}})
        return ob().status()

    # ── memory (everything she remembers, readable and editable) ──
    @app.get("/api/memory")
    async def memory_list() -> dict:
        return {"facts": core.memory.list_facts()}

    @app.post("/api/memory")
    async def memory_add(body: FactIn) -> dict:
        fid = core.memory.add_fact(body.text, source="user")
        if not fid:
            raise HTTPException(422, "text is too short")
        return {"id": fid}

    @app.patch("/api/memory/{fact_id}")
    async def memory_update(fact_id: int, body: FactIn) -> dict:
        if not core.memory.update_fact(fact_id, body.text):
            raise HTTPException(404, "no such memory, or text too short")
        return {"ok": True}

    @app.delete("/api/memory/{fact_id}")
    async def memory_delete(fact_id: int) -> dict:
        if not core.memory.delete_fact(fact_id):
            raise HTTPException(404, "no such memory")
        return {"ok": True}

    @app.delete("/api/memory")
    async def memory_clear() -> dict:
        return {"deleted": core.memory.clear_facts()}

    # ── speech ──
    @app.get("/api/tts/voices")
    async def tts_voices() -> dict:
        return {"available": bool(core.tts and core.tts.available()), "voices": [{"id": i, "label": l, "feel": f} for i, l, f in VOICES]}

    @app.get("/api/tts/preview")
    async def tts_preview(voice: str = "af_heart", text: str = "Hi. This is how I sound.", speed: float = 1.0) -> Response:
        if not (core.tts and core.tts.available()):
            return JSONResponse({"detail": "speech is not installed", "fallback": "system"}, status_code=503)
        try:
            import asyncio

            wav = await asyncio.to_thread(core.tts.synthesize_wav, text[:300], voice, speed)
        except TTSUnavailable:
            return JSONResponse({"detail": "speech is not installed", "fallback": "system"}, status_code=503)
        return Response(wav, media_type="audio/wav")

    vp: dict = {"task": None, "percent": 0, "error": ""}

    @app.get("/api/voicepack")
    async def voicepack_status() -> dict:
        """Her voice and ears: whether the engines are here, whether the model files are, and how far a running download is."""
        pack = core.voicepack
        if not pack:
            return {"supported": False, "installed": False, "running": False}
        return {**pack.status(), "running": bool(vp["task"] and not vp["task"].done()), "percent": vp["percent"], "error": vp["error"]}

    @app.post("/api/voicepack/install")
    async def voicepack_install() -> dict:
        import asyncio

        from ..voicepack import VoicePackError, libraries_present

        pack = core.voicepack
        if not pack or not libraries_present():
            raise HTTPException(409, "this backend has no speech engines to download files for")
        if vp["task"] and not vp["task"].done():
            return {"started": False, "running": True}

        def progress(done: int, total: int) -> None:
            vp["percent"] = int(100 * done / total) if total else 100

        async def run() -> None:
            vp.update(percent=0, error="")
            try:
                await pack.install(progress)
            except VoicePackError as e:
                vp["error"] = str(e)[:200]
            except Exception as e:
                vp["error"] = f"{type(e).__name__}: {e}"[:200]

        vp["task"] = asyncio.ensure_future(run())
        return {"started": True, "running": True}

    @app.post("/api/stt")
    async def stt(request: Request) -> dict:
        """Body: raw 16 kHz mono 16-bit little-endian PCM. Returns the text."""
        if not (core.stt and core.stt.available()):
            return JSONResponse({"detail": "speech recognition is not installed"}, status_code=503)  # type: ignore[return-value]
        import asyncio

        pcm = await request.body()
        if len(pcm) > 16000 * 2 * 60:
            raise HTTPException(413, "audio is longer than a minute")
        return {"text": await asyncio.to_thread(core.stt.transcribe_pcm16, pcm)}

    return app
