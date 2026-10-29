"""Text to speech with Kokoro. Two ways to run it: kokoro-onnx with the model files of the voice pack (no torch; what the installer ships), or the
`kokoro` package (torch) when that is installed instead. Audio is cached on disk by hash of (voice, speed, text), so scripted onboarding lines are
synthesized once. When neither works `available()` is False and callers fall back to the system voice (the desktop app's job)."""
from __future__ import annotations

import hashlib
import io
import wave
from pathlib import Path

SAMPLE_RATE = 24000
VOICES = [  # id, label, accent / feel
    ("af_heart", "Heart", "warm, American"), ("af_bella", "Bella", "bright, American"), ("af_nicole", "Nicole", "soft, American"),
    ("af_sarah", "Sarah", "clear, American"), ("af_sky", "Sky", "light, American"), ("am_adam", "Adam", "steady, American"),
    ("am_michael", "Michael", "easygoing, American"), ("bf_emma", "Emma", "calm, British"), ("bf_isabella", "Isabella", "gentle, British"),
    ("bm_george", "George", "deep, British"), ("bm_lewis", "Lewis", "relaxed, British"),
]
VOICE_IDS = {v[0] for v in VOICES}


class TTSUnavailable(RuntimeError):
    pass


def pcm16_to_wav(pcm: bytes, sr: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


class TTS:
    def __init__(self, cache_dir: Path | None = None, pack=None):
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.pack = pack                    # a voicepack.VoicePack, or None
        self._pipelines: dict = {}
        self._onnx = None
        self._probe: dict[str, bool] = {}

    def _can_import(self, name: str) -> bool:
        if name not in self._probe:
            try:
                __import__(name)
                import numpy  # noqa: F401
                self._probe[name] = True
            except ImportError:
                self._probe[name] = False
        return self._probe[name]

    def _use_onnx(self) -> bool:
        return bool(self.pack and self.pack.speech_ready() and self._can_import("kokoro_onnx"))

    def available(self) -> bool:
        return self._use_onnx() or self._can_import("kokoro")

    def _pipeline(self, voice: str):
        lang = "b" if voice.startswith("b") else "a"
        if lang not in self._pipelines:
            from kokoro import KPipeline
            self._pipelines[lang] = KPipeline(lang_code=lang)
        return self._pipelines[lang]

    def _key(self, text: str, voice: str, speed: float) -> str:
        return hashlib.sha1(f"{voice}|{speed:.2f}|{text}".encode("utf-8")).hexdigest()

    def synthesize_pcm(self, text: str, voice: str = "af_heart", speed: float = 1.0) -> tuple[bytes, int]:
        """16-bit mono PCM and its sample rate. Cached on disk when a cache folder was given."""
        text = (text or "").strip()[:1500]
        if not text:
            return b"", SAMPLE_RATE
        voice = voice if voice in VOICE_IDS else "af_heart"
        speed = min(2.0, max(0.5, float(speed)))
        path = self.cache_dir / (self._key(text, voice, speed) + ".pcm") if self.cache_dir else None
        if path and path.exists():
            return path.read_bytes(), SAMPLE_RATE
        if not self.available():
            raise TTSUnavailable("Kokoro is not installed")
        import numpy as np

        if self._use_onnx():
            if self._onnx is None:
                from kokoro_onnx import Kokoro
                self._onnx = Kokoro(str(self.pack.kokoro_model()), str(self.pack.kokoro_voices()))
            audio, _sr = self._onnx.create(text, voice=voice, speed=speed, lang="en-gb" if voice.startswith("b") else "en-us")
            pcm = (np.clip(np.asarray(audio, dtype="float32"), -1, 1) * 32767).astype("<i2").tobytes()
        else:
            chunks = []
            for _g, _p, audio in self._pipeline(voice)(text, voice=voice, speed=speed):
                a = np.asarray(audio, dtype="float32")
                chunks.append((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())
            pcm = b"".join(chunks)
        if path and pcm:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            path.write_bytes(pcm)
        return pcm, SAMPLE_RATE

    def synthesize_wav(self, text: str, voice: str = "af_heart", speed: float = 1.0) -> bytes:
        pcm, sr = self.synthesize_pcm(text, voice, speed)
        return pcm16_to_wav(pcm, sr)
