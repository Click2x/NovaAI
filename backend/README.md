# NovaAI backend

The local server behind the Nova.Ai desktop app. It runs on your machine, talks to [Ollama](https://ollama.com) for language models, keeps memory in a SQLite file in `~/.novaai`, and speaks the desktop app's WebSocket protocol (`/api/desktop/ws`, protocol v1).

## Run it

```
cd backend
python -m venv .venv && .venv\Scripts\activate      # source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt                     # add requirements-voice.txt for her voice and speech recognition
python -m novaai doctor                             # checks Ollama, picks models for this machine, reports what is missing
python -m novaai serve                              # 127.0.0.1:8000
```

Set `NOVAAI_HOME` to keep the data somewhere else than `~/.novaai`. The server only answers the local machine (Host and Origin are checked).

## Models and the router

`novaai/models.json` is the model registry; add or replace entries in `~/.novaai/models.json`. Two roles:

* **voice** is her everyday speech. Mistral NeMo 12B (regular, or abliterated) is the first choice; small Llama and Qwen models are the fallback for weaker machines.
* **tools** does tool calling and structured extraction (profile extraction during onboarding, remember / recall / forget). US models (Llama, gpt-oss, Granite, Phi) and Chinese models (Qwen), each in a regular and an abliterated build.

The router picks by: your override tag, then what fits the GPU (VRAM minus 1.5 GB, or half the RAM with no GPU), then regular vs abliterated, then models already installed, then your origin preference (any / US / CN), then an editorial quality score. Abliterated builds are chosen only when you turned the harm filter off **and** confirmed you are an adult, or when you set `models.variant` yourself. Entries marked `known_good` were seen with tool support on a real install; the others are recommendations that the installer verifies with `ollama show` after pulling, falling back to the next candidate.

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
