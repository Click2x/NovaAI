"""Speech to text with faster-whisper (ctranslate2, no torch). The desktop app already cuts speech out with its voice-activity detector and
sends 16 kHz mono 16-bit PCM; this turns that into text. The model loads on first use: the voice pack's Whisper "base" when it is
installed (on the CPU, which is plenty for short utterances and leaves the graphics card to the language model), otherwise, when running
from source, whatever faster-whisper downloads for `model_size`."""
from __future__ import annotations

import sys


class STTUnavailable(RuntimeError):
    pass


class STT:
    def __init__(self, model_size: str = "small", device: str = "auto", pack=None):
        self.model_size, self.device = model_size, device
        self.pack = pack                    # a voicepack.VoicePack, or None
        self._model = None
        self._probe: bool | None = None

    def _importable(self) -> bool:
        if self._probe is None:
            try:
                import faster_whisper  # noqa: F401
                import numpy  # noqa: F401
                self._probe = True
            except ImportError:
                self._probe = False
        return self._probe

    def available(self) -> bool:
        if not self._importable():
            return False
        if self.pack and self.pack.hearing_ready():
            return True
        return not getattr(sys, "frozen", False)      # installed app: no silent multi-hundred-MB download in the middle of a sentence

    def transcribe_pcm16(self, pcm: bytes, language: str | None = None) -> str:
        if not self.available():
            raise STTUnavailable("faster-whisper is not installed")
        import numpy as np

        if self._model is None:
            from faster_whisper import WhisperModel
            if self.pack and self.pack.hearing_ready():
                self._model = WhisperModel(str(self.pack.whisper_dir()), device="cpu", compute_type="int8")
            else:
                self._model = WhisperModel(self.model_size, device=self.device, compute_type="auto")
        audio = np.frombuffer(pcm[: len(pcm) - (len(pcm) % 2)], dtype="<i2").astype("float32") / 32768.0
        segments, _info = self._model.transcribe(audio, language=language, vad_filter=True, beam_size=1)
        return " ".join(s.text.strip() for s in segments).strip()
