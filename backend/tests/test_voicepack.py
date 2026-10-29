import sys
from types import SimpleNamespace

import httpx
import pytest
from conftest import NEMO, run

from novaai import voicepack as vp
from novaai.onboarding import Onboarding
from novaai.stt import STT
from novaai.tts import TTS
from novaai.voicepack import PackFile, VoicePack, VoicePackError

A, B = b"a" * 1000, b"b" * 3000
FILES = (PackFile("kokoro-v1.0.onnx", "http://x/a", len(A)), PackFile("voices-v1.0.bin", "http://x/b", len(B)),
         PackFile("whisper-base/config.json", "http://x/c", 10), PackFile("whisper-base/tokenizer.json", "http://x/d", 10),
         PackFile("whisper-base/vocabulary.txt", "http://x/e", 10), PackFile("whisper-base/model.bin", "http://x/f", 20))
BODY = {"http://x/a": A, "http://x/b": B, "http://x/c": b"c" * 10, "http://x/d": b"d" * 10, "http://x/e": b"e" * 10, "http://x/f": b"f" * 20}


def server(bodies=BODY, honour_range=True, hits=None):
    def handle(request: httpx.Request) -> httpx.Response:
        if hits is not None:
            hits.append((str(request.url), request.headers.get("range")))
        body = bodies.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        rng = request.headers.get("range")
        if rng and honour_range:
            start = int(rng.split("=")[1].rstrip("-"))
            return httpx.Response(206 if start < len(body) else 416, content=body[start:])
        return httpx.Response(200, content=body)

    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle))


def pack(tmp_path, **kw):
    return VoicePack(tmp_path / "voice", FILES, client_factory=server(**kw))


def test_the_real_file_list_names_what_the_engines_load():
    assert {f.name for f in vp.FILES} >= {"kokoro-v1.0.onnx", "voices-v1.0.bin", "whisper-base/model.bin", "whisper-base/config.json"}
    assert 400e6 < sum(f.size for f in vp.FILES) < 600e6


def test_install_downloads_everything_reports_progress_and_checks_sizes(tmp_path):
    p = pack(tmp_path)
    assert not p.installed() and not p.speech_ready() and not p.hearing_ready() and p.status()["missing_mb"] == 0   # tiny files round to 0 MB
    seen = []
    run(p.install(lambda d, t: seen.append((d, t))))
    assert p.installed() and p.speech_ready() and p.hearing_ready()
    assert seen[0][0] == 0 and seen[-1] == (4050, 4050) and all(a[0] <= b[0] for a, b in zip(seen, seen[1:]))
    assert (p.dir / "voices-v1.0.bin").read_bytes() == B and not list(p.dir.rglob("*.part"))
    run(p.install())                                       # nothing left to fetch


def test_an_interrupted_download_resumes_with_a_range_request(tmp_path):
    hits = []
    p = pack(tmp_path, hits=hits)
    p.dir.mkdir(parents=True)
    (p.dir / "voices-v1.0.bin.part").write_bytes(B[:1200])
    assert p.missing_bytes() == 4050 - 1200
    run(p.install())
    assert (p.dir / "voices-v1.0.bin").read_bytes() == B
    assert ("http://x/b", "bytes=1200-") in hits


def test_a_server_that_ignores_ranges_restarts_the_file(tmp_path):
    p = pack(tmp_path, honour_range=False)
    p.dir.mkdir(parents=True)
    (p.dir / "voices-v1.0.bin.part").write_bytes(b"junk" * 100)
    run(p.install())
    assert (p.dir / "voices-v1.0.bin").read_bytes() == B


def test_wrong_sizes_and_http_errors_fail_without_leaving_a_bad_file(tmp_path):
    short = dict(BODY, **{"http://x/b": B[:100]})
    p = pack(tmp_path, bodies=short)
    with pytest.raises(VoicePackError, match="got 100 of 3000"):
        run(p.install())
    assert not (p.dir / "voices-v1.0.bin").exists() and (p.dir / "voices-v1.0.bin.part").stat().st_size == 100   # kept: resumes next time
    long = dict(BODY, **{"http://x/b": B + b"x"})
    p2 = pack(tmp_path / "two", bodies=long)
    with pytest.raises(VoicePackError):
        run(p2.install())
    assert not list(p2.dir.rglob("voices-v1.0.bin*"))                                                              # too big: thrown away
    p3 = pack(tmp_path / "three", bodies={})
    with pytest.raises(VoicePackError, match="404"):
        run(p3.install())


def test_a_file_of_the_wrong_size_on_disk_counts_as_missing(tmp_path):
    p = pack(tmp_path)
    run(p.install())
    (p.dir / "whisper-base" / "model.bin").write_bytes(b"x")
    assert [f.name for f in p.missing()] == ["whisper-base/model.bin"] and p.speech_ready() and not p.hearing_ready()


def test_tts_uses_the_onnx_engine_only_when_the_speech_files_are_there(tmp_path):
    ready = SimpleNamespace(speech_ready=lambda: True)
    assert TTS(pack=ready)._use_onnx() is True            # kokoro_onnx is installed in the test environment
    assert TTS(pack=SimpleNamespace(speech_ready=lambda: False))._use_onnx() is False
    assert TTS(pack=None)._use_onnx() is False
    t = TTS(pack=ready)
    t._probe.update({"kokoro_onnx": False, "kokoro": False})
    assert t.available() is False                          # neither engine importable: the app falls back to the system voice


def test_stt_in_the_installed_app_needs_the_downloaded_model(monkeypatch):
    have = SimpleNamespace(hearing_ready=lambda: True)
    none = SimpleNamespace(hearing_ready=lambda: False)
    assert STT(pack=have).available() is True
    assert STT(pack=none).available() is True              # from source it may fetch its own model
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert STT(pack=none).available() is False
    assert STT(pack=have).available() is True


def test_setup_installs_the_voice_pack_after_the_models(make_core, tmp_path, monkeypatch):
    monkeypatch.setattr(vp, "libraries_present", lambda: True)
    core = make_core(installed=())
    core.voicepack = pack(tmp_path)
    ob = Onboarding(core)
    run(ob.advance()); run(ob.advance())
    run(ob.wait_install())
    inst = ob.install_status()
    assert inst["state"] == "done" and core.voicepack.installed()
    said = " ".join(l["text"] for l in inst["lines"])
    assert "voice and my ears" in said or "speaking and listening" in said


def test_setup_carries_on_when_the_voice_pack_cannot_be_downloaded(make_core, tmp_path, monkeypatch):
    monkeypatch.setattr(vp, "libraries_present", lambda: True)
    core = make_core(installed=())
    core.voicepack = pack(tmp_path, bodies={})
    ob = Onboarding(core)
    run(ob.advance()); run(ob.advance())
    run(ob.wait_install())
    inst = ob.install_status()
    assert inst["state"] == "done" and not core.voicepack.installed()
    assert "computer's voice" in " ".join(l["text"] for l in inst["lines"])
