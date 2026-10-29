import asyncio

import pytest

from novaai.core import Core
from novaai.hardware import Hardware
from novaai.llm import FakeLLM

NEMO = "mistral-nemo:12b"
QWEN = "qwen3:8b"


@pytest.fixture
def make_core(tmp_path):
    cores = []

    def make(replies=None, installed=(NEMO, QWEN), hardware=None, **llm_kw):
        llm = FakeLLM(replies=replies or ["Okay."], installed=set(installed), **llm_kw)
        core = Core.create(home=tmp_path / f"home{len(cores)}", llm=llm, hardware=hardware or Hardware("RTX 3090", 24.0, 64.0), tts=_NoTTS(), stt=_NoTTS(), voicepack=False)
        cores.append(core)
        return core

    yield make
    for c in cores:
        c.memory.close()


class _NoTTS:
    def available(self):
        return False


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


async def collect(agen):
    return [e async for e in agen]
