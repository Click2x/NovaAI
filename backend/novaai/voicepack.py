"""The voice pack: the model files for her voice (Kokoro, run with onnxruntime) and for hearing you (Whisper "base", run with ctranslate2).

Neither engine needs torch, so the libraries ship inside the installer; the weights (about 500 MB) are downloaded once into
<home>/voice during setup (or with `python -m novaai voicepack`). Downloads resume after an interruption and every file is checked
against its exact size before it is used.
"""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx

KOKORO = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
WHISPER = "https://huggingface.co/Systran/faster-whisper-base/resolve/main/"
WHISPER_DIR = "whisper-base"


@dataclass(frozen=True)
class PackFile:
    name: str          # path under the voice folder
    url: str
    size: int          # exact bytes; a download of any other size is thrown away


FILES: tuple[PackFile, ...] = (
    PackFile("kokoro-v1.0.onnx", KOKORO + "kokoro-v1.0.onnx", 325_532_387),
    PackFile("voices-v1.0.bin", KOKORO + "voices-v1.0.bin", 28_214_398),
    PackFile(f"{WHISPER_DIR}/config.json", WHISPER + "config.json", 2_309),
    PackFile(f"{WHISPER_DIR}/tokenizer.json", WHISPER + "tokenizer.json", 2_203_239),
    PackFile(f"{WHISPER_DIR}/vocabulary.txt", WHISPER + "vocabulary.txt", 459_861),
    PackFile(f"{WHISPER_DIR}/model.bin", WHISPER + "model.bin", 145_217_532),
)
SPEECH = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
HEARING = tuple(f.name for f in FILES if f.name.startswith(WHISPER_DIR))

Progress = Callable[[int, int], None]


class VoicePackError(RuntimeError):
    pass


def libraries_present() -> bool:
    """Are the two engines importable (they are in the installer, and with requirements-voice.txt from source)?"""
    return all(importlib.util.find_spec(m) is not None for m in ("kokoro_onnx", "faster_whisper"))


class VoicePack:
    def __init__(self, folder: Path, files: tuple[PackFile, ...] = FILES, client_factory: Callable[[], httpx.AsyncClient] | None = None):
        self.dir = Path(folder)
        self.files = files
        self._client = client_factory or (lambda: httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30.0, read=60.0)))

    def _ok(self, f: PackFile) -> bool:
        p = self.dir / f.name
        return p.is_file() and p.stat().st_size == f.size

    def missing(self) -> list[PackFile]:
        return [f for f in self.files if not self._ok(f)]

    def installed(self) -> bool:
        return not self.missing()

    def speech_ready(self) -> bool:
        return all(self._ok(f) for f in self.files if f.name in SPEECH)

    def hearing_ready(self) -> bool:
        return all(self._ok(f) for f in self.files if f.name in HEARING)

    def kokoro_model(self) -> Path:
        return self.dir / "kokoro-v1.0.onnx"

    def kokoro_voices(self) -> Path:
        return self.dir / "voices-v1.0.bin"

    def whisper_dir(self) -> Path:
        return self.dir / WHISPER_DIR

    def missing_bytes(self) -> int:
        total = 0
        for f in self.missing():
            part = self.dir / (f.name + ".part")
            total += f.size - (min(part.stat().st_size, f.size) if part.is_file() else 0)
        return total

    def status(self) -> dict:
        miss = self.missing()
        return {"supported": libraries_present(), "installed": not miss, "speech": self.speech_ready(), "hearing": self.hearing_ready(),
                "missing_mb": round(self.missing_bytes() / 1e6), "total_mb": round(sum(f.size for f in self.files) / 1e6)}

    async def install(self, progress: Progress | None = None) -> None:
        """Fetch every missing file. `progress(done_bytes, total_bytes)` covers the whole pack, counting what was already on disk."""
        total = sum(f.size for f in self.files)
        done = total - sum(f.size for f in self.missing())
        if progress:
            progress(done, total)
        async with self._client() as client:
            for f in self.missing():
                done = await self._fetch(client, f, done, total, progress)

    async def _fetch(self, client: httpx.AsyncClient, f: PackFile, done: int, total: int, progress: Progress | None) -> int:
        dest = self.dir / f.name
        part = dest.with_name(dest.name + ".part")
        part.parent.mkdir(parents=True, exist_ok=True)
        have = part.stat().st_size if part.is_file() else 0
        if have > f.size:
            part.unlink()
            have = 0
        try:
            headers = {"Range": f"bytes={have}-"} if have else {}
            async with client.stream("GET", f.url, headers=headers) as r:
                if r.status_code == 416 and have == f.size:      # the whole file was already there, only the rename is missing
                    pass
                elif r.status_code not in (200, 206):
                    raise VoicePackError(f"{f.name}: the server answered {r.status_code}")
                else:
                    if r.status_code == 200:                    # it ignored the range: start the file over
                        have = 0
                    with part.open("ab" if have else "wb") as out:
                        async for chunk in r.aiter_bytes(256 * 1024):
                            out.write(chunk)
                            have += len(chunk)
                            if progress:
                                progress(min(done + have, total), total)
        except httpx.HTTPError as e:
            raise VoicePackError(f"{f.name}: {type(e).__name__}: {e}"[:200]) from e
        got = part.stat().st_size
        if got != f.size:
            if got > f.size:                    # too big is corrupt and starts over; too small is kept and resumes next time
                part.unlink()
            raise VoicePackError(f"{f.name}: got {got} of {f.size} bytes")
        part.replace(dest)
        return done + f.size
