# NovaAI backend

The local server behind the Nova.Ai desktop app. It runs on your machine, talks to [Ollama](https://ollama.com) for language models, keeps memory in a SQLite file in `~/.novaai`, and speaks the desktop app's WebSocket protocol (`/api/desktop/ws`, protocol v1).

## Run it

```
cd backend
python -m venv .venv && .venv\Scripts\activate      # source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt                     # includes her voice and ears (no torch)
python -m novaai voicepack                          # downloads their model files, about 500 MB (setup does this for you)
python -m novaai doctor                             # checks Ollama, picks models for this machine, reports what is missing
python -m novaai serve                              # 127.0.0.1:8000
```

Set `NOVAAI_HOME` to keep the data somewhere else than `~/.novaai`. The server only answers the local machine (Host and Origin are checked).

## Models and the router

`novaai/models.json` is the model registry; add or replace entries in `~/.novaai/models.json`. Two roles:

* **voice** is her everyday speech. Mistral NeMo 12B (regular, or abliterated) is the first choice; small Llama and Qwen models are the fallback for weaker machines.
* **tools** does tool calling and structured extraction (profile extraction during onboarding, remember / recall / forget). US models (Llama, gpt-oss, Granite, Phi) and Chinese models (Qwen), each in a regular and an abliterated build.

The router picks by: your override tag, then what fits the GPU (VRAM minus 1.5 GB, or half the RAM with no GPU), then regular vs abliterated, then models already installed, then your origin preference (any / US / CN), then an editorial quality score. Abliterated builds are chosen only when you turned the harm filter off **and** confirmed you are an adult, or when you set `models.variant` yourself. Entries marked `known_good` were seen with tool support on a real install; the others are recommendations that the installer verifies with `ollama show` after pulling, falling back to the next candidate.

## Tool routing

Every Ollama call asks for an 8192-token context (`llm.DEFAULT_NUM_CTX`). Without it Ollama loads Mistral NeMo at its own 131072-token default: a 29 GB load that spills onto the CPU and takes seconds per message.

Before each reply `engine.route_message` asks a model one question and gets a constrained JSON answer (`{"tool": "remember"}`, or `"none"`): which tool, if any, the message needs. Words like *remember* or *forget* in ordinary talk ("I forgot my keys") are meant to come back `none`. The tools phase then runs with only the chosen tool and the voice model words the result. The voice model asks first when it can do tools too (it is already loaded, so there is no model swap; Mistral NeMo scored 94% against 97% for a dedicated tools model on the four built tools), then the tools model. If no model can answer, the old phrase list (`router.route_turn`) takes over so the obvious requests still work. `novaai/decide.py` holds the `Decider` interface and the catalog (the four built tools plus planned ones); `python tools/eval-routing.py --decider json --model <tag>` (from the repo root, with the backend's Python) scores a model on `tests/routing_cases.json`.

## Memory

Everything she knows about the user is a plain sentence in `nova.db` (table `facts`), each marked with who wrote it (`user`, `onboarding`, `tool`, `learned`) and a kind (`identity`, `preference`, `boundary`, `plan`, `fact`). `GET/POST/PATCH/DELETE /api/memory` read and change it; the desktop app's "What Nova remembers" window uses exactly these.

After each turn `novaai/learn.py` reads only what the USER said, never her reply, and saves lasting facts: it skips small talk with a cheap pattern test, messages the harm filter flags, and near-duplicates of what she already knows. It asks the voice model first (already loaded) and falls back to the tools model. New facts are announced to the app with a `remembered` WebSocket message. Turn it off with `{"memory": {"auto_learn": false}}` in settings; she then remembers only what the user asks her to.

## Voice pack

Her voice is Kokoro run by `kokoro-onnx`; her ears are Whisper "base" run by `faster-whisper` (CPU, int8). Neither needs torch, so both libraries ship in the installer. Their model files are the voice pack (`novaai/voicepack.py`, about 500 MB), stored in `~/.novaai/voice`. Setup downloads it after the language models and carries on if that fails (she then uses the computer's voice and the app says it cannot hear yet); `python -m novaai voicepack`, or `POST /api/voicepack/install` with progress on `GET /api/voicepack`, tries again. Downloads resume after an interruption and each file is checked against its exact size. The older torch build of Kokoro (`requirements-voice.txt`) still works when the pack is not installed.

## Harm filter

A heuristic filter on what you say and what she says. Each category (self-harm, violence and weapons, illegal activity, hate and harassment, explicit sexual content, dangerous instructions) is set to `block`, `care` (self-harm only: she responds with warmth and never gives methods) or `allow`, or the whole filter is switched off. Switching it off only counts for a user who confirmed they are 18 or older. **Two limits cannot be changed:** sexual content involving minors, and help with chemical, biological or nuclear weapons. It is a seatbelt made of regular expressions, not a guarantee: it misses things and sometimes flags harmless text. A model-based classifier can be plugged in (`HarmFilter(classifier=...)`).

## Onboarding

`/api/onboarding` drives a voiced, guided setup: welcome, machine check and model plan, install with spoken progress, then a real conversation where she gets to know you while the tools model quietly fills in your profile, then voice audition, safety choice, avatar, done. Every step returns `lines` (id, text, emotion) for the app to speak and show. `python -m novaai prerender` caches the fixed lines as audio. Progress is saved after every step.

## Tests

```
pip install -r requirements-dev.txt
python -m pytest tests
```

The tests use a scripted fake LLM; nothing needs Ollama running.
