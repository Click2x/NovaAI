"""python -m novaai [serve|doctor|prerender]"""
from __future__ import annotations

import argparse
import asyncio
import sys


def serve(host: str, port: int) -> None:
    import uvicorn

    from .api.app import create_app

    uvicorn.run(create_app(), host=host, port=port, log_level="info")


async def doctor() -> int:
    from .core import Core

    core = Core.create()
    ok = True
    hw = core.hardware
    print(f"hardware : {hw.gpu_name or 'no GPU'}  {hw.vram_gb:g} GB VRAM  {hw.ram_gb:g} GB RAM  tier={hw.tier}")
    alive = await core.llm.alive()
    print(f"ollama   : {'running' if alive else 'NOT running (install from ollama.com and start it)'}")
    ok &= alive
    r = await core.router()
    plan = r.plan(core.s())
    for role in ("voice", "tools"):
        e = plan[role]
        if not e:
            print(f"{role:9}: nothing fits this machine")
            ok = False
            continue
        info = await core.llm.show(e["tag"]) if alive else None
        state = "installed" if info else "not installed (will download)"
        tools = " tools=yes" if info and "tools" in (info.get("capabilities") or []) else (" tools=NO" if info and role == "tools" else "")
        print(f"{role:9}: {e['tag']}  [{e['origin']} {e['variant']}] {state}{tools}")
    print(f"speech   : tts={'yes' if core.tts.available() else 'no (pip install kokoro soundfile)'}  stt={'yes' if core.stt.available() else 'no (pip install faster-whisper)'}")
    print(f"safety   : {'on' if core.harm.status()['applied'] else 'OFF (adult confirmed)'}; hard limits always on")
    return 0 if ok else 1


async def prerender() -> int:
    from .core import Core
    from .onboarding.script import all_static_lines

    core = Core.create()
    if not core.tts.available():
        print("Kokoro is not installed: pip install kokoro soundfile")
        return 1
    s = core.s()["nova"]
    texts = all_static_lines()
    for i, t in enumerate(texts, 1):
        await asyncio.to_thread(core.tts.synthesize_pcm, t, s["voice"], s["speed"])
        print(f"[{i}/{len(texts)}] {t[:60]}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="novaai")
    sub = p.add_subparsers(dest="cmd")
    sv = sub.add_parser("serve", help="run the backend (default)")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)
    sub.add_parser("doctor", help="check Ollama, models and speech")
    sub.add_parser("prerender", help="render the setup voice lines to the audio cache")
    args = p.parse_args()
    if args.cmd == "doctor":
        return asyncio.run(doctor())
    if args.cmd == "prerender":
        return asyncio.run(prerender())
    serve(getattr(args, "host", "127.0.0.1"), getattr(args, "port", 8000))
    return 0


if __name__ == "__main__":
    sys.exit(main())
