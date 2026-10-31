# Nova.Ai roadmap

## Timeline

Dates come from the git history. Testing on real machines has been deferred on purpose, so "built" below means written and unit-tested, not yet watched live unless it says so.

**Done**

| When | Milestone |
| --- | --- |
| Oct 18-19 | Electron desktop app: transparent overlay, WebSocket chat, speech bubble, voice in and out, screen awareness, settings panel, Home window, notification centre, GPU arbiter, training review (phases 1-12 and 16 of the original plan) |
| Oct 25-26 | Code window and agent hooks (phases 13-15); optional avatar display, radial menu, chat window placed from one origin |
| Oct 27 | Split into this standalone public repo as Nova.Ai; the backend added to it (model router, harm filter, voiced onboarding); guided voiced setup; the orb replaces the avatar (no avatar model ships); movable, lockable layout |
| Oct 29 | Backend bundled as a PyInstaller sidecar the app starts and stops; installer built; failed-backend explanation and busy-port fallback; CI workflow written; speech to text over the WebSocket; torch-free voice pack (Kokoro and Whisper, 502 MB, downloaded in setup); README vision and banner |
| Oct 29-30 | **Memory:** automatic fact learning after each turn (`learn.py`, off switch `memory.auto_learn`), a "remembered" message to the app, and the "What Nova remembers" window (search, add, edit, delete with undo, export, forget everything) |

**We are here (Oct 30, 2026).** The desktop app and the backend live in one repository and both build. Desktop 359 tests and backend 115 tests pass. The newest piece, memory, has been exercised against a real backend in a browser (edit, delete, undo, search, the learning switch) but not yet through the Electron tray or with a real model extracting facts. Still unproven on a real machine: the rebuilt installer with the 273 MB sidecar, a clean-machine install, setup end to end, a real microphone, CI on GitHub, and code signing.

**Way forward**

1. **Make the differentiator real:** tool routing by the tools model (replacing the phrase list), more tools behind plain on/off switches, model routing by task, prompt routing, and the "How she thinks" page (Phase 2b).
2. **Zero setup for non-technical users:** setup installs Ollama silently and narrates it; a retry button for a failed voice-pack download.
3. **Prove it:** one testing pass: rebuild the installer, clean-machine install, setup end to end, microphone, CI on GitHub.
4. **Trust and release machinery:** code signing, CHANGELOG and version policy, auto-update from GitHub Releases, uninstall story (Phases 2-3).
5. **Public launch:** tagged release, install guide, issue templates (Phase 4).

Status marks: `[x]` done, `[ ]` open, `[?]` built but never verified live.

## Phase 1: Installable (next)

Goal: a clean Windows machine goes from installer to a talking orb.

- [x] Backend bundled as `novaai-server.exe` and started by the app
- [x] `npm run dist` produces `release/Nova.Ai Setup 0.1.0.exe` (106 MB) containing `resources/backend/novaai-server` (built Oct 29; the installer itself has not been run yet)
- [ ] Install on a clean Windows user or VM; run setup start to finish
- [x] Ollama: setup already detects it and shows a "Get Ollama" / "I installed it" card (no silent installs)
- [?] Real model download from setup (about 7 GB), with spoken progress, resume after a failed or cancelled download
- [?] Microphone "meet you" step, avatar picker, safety step clicks, finish
- [x] Sidecar failure path: if the exe exits or never answers, setup shows the reason and where `logs/backend.log` is (unit-tested; not seen live)
- [x] Port conflict: if 8000 is held by something else, the sidecar uses the next free port and remembers it in `backend.url` (unit-tested; not seen live)

Exit test: fresh VM, install, setup, a spoken reply, restart the app and it remembers you.

## Phase 2: Trust and polish

Goal: nothing about the first hour feels sketchy.

- [ ] Code-sign the installer and `novaai-server.exe` (unsigned means SmartScreen and Defender warnings)
- [x] Voice in the bundle: kokoro-onnx and faster-whisper (no torch) are in the sidecar (now 273 MB); setup downloads their models (the voice pack, 502 MB) after the language models and carries on if it fails. Verified with the frozen exe: the pack downloads in 20 s on this connection, she speaks a sentence and Whisper transcribes it back word for word. Not yet through setup in the Electron app
- [?] Speech-to-text over the desktop WebSocket: utterances are transcribed, wake/stop/sleep words and commands handled (backend/novaai/voicein.py, ws.py; 18 new backend tests). Not heard live. The bundled build hears once the voice pack is on disk
- [?] Orb while a real reply is spoken, drag, right-click radial, style switch at runtime
- [ ] Persona screen (traits, interests, boundaries, edited in plain words)
- [?] Memory screen: tray > "What Nova remembers..." lists what she knows grouped by kind; search, add, edit, delete with undo, export as text, forget everything, and the learning on/off switch. Exercised against a real backend in a browser; not yet opened from the tray in Electron
- [?] Automatic memory: after each turn `learn.py` reads what the user said (never her reply), saves lasting facts as plain sentences, skips near-duplicates and flagged messages, and the app says "I will remember that". Unit-tested with a fake model; not yet run with a real one. Still open: summarize old chats instead of losing them
- [ ] Uninstall story: what is kept in `~/.novaai` and the app data folder, and a way to delete it

## Phase 2b: The routing and memory story

Goal: the part that makes Nova.Ai different works with no setup by the user, and the user can look at all of it.

- [x] Tool routing by the tools model (Oct 30): `engine.route_message` asks the tools model one JSON question per message (Ollama structured output, a few worked examples in the prompt) and `decide.PhraseDecider` is only the fallback when no model can answer; the tools phase then sees just the chosen tool; the `done` event carries `route` {tool, ms, ran} for the future "How she thinks" page. Scored by `tools/eval-routing.py` on `backend/tests/routing_cases.json` (106 hand-labelled messages incl. traps, other languages, no-keyword requests; RTX 3090): phrase list 44% on whether a tool is needed (25% recall); `qwen2.5:7b` 94% gate / 91.5% exact tool, p50 281 ms; `qwen3:14b` 95% / 94.3%, p50 381 ms. Against the four tools that exist today both reach 97% and 100% recall; the misses are two traps ("I want to remember this feeling forever"). Kev-0.8B (open decision model) scored untuned 81% / 66% at 415 ms, needs PyTorch and a custom head Ollama cannot serve: not used. Live check through the real engine with Mistral NeMo as the router: remember, recall, plain chat and the time all routed correctly at about 400 ms once loaded. That run also found two bugs, both fixed: Ollama loaded NeMo at its 131072-token default context (29 GB, 77% on the CPU) because no `num_ctx` was ever sent (now 8192 on every call), and a recall the tools model never called left the voice model to invent a memory (recall and the time now run directly when the router chose them; recall with no word match offers everything remembered). Not yet seen live in the app window.
- [ ] Real tools behind the router: reminders and timers, notes and lists, screen look, each with a tier (read / ask first / confirm) and a plain on/off switch; a tool activity log; grow the test set
- [ ] Model routing by task, not only by role: a larger model for hard questions when the hardware allows, fallback driven by observed failures and speed
- [ ] Prompt routing: pick the prompt pieces and context size per kind of turn (chat, tool result, recall-heavy, care) and keep a log of what was sent
- [ ] "How she thinks" page: which model answered and why, which tools ran, which memories were used, in plain words
- [ ] Setup installs Ollama for the user instead of requiring it (see open decisions)

## Phase 3: Release machinery

Goal: shipping a version is boring.

- [?] CI on GitHub: `.github/workflows/ci.yml` runs desktop tests, backend tests and builds the installer on main (never run yet). Still open: attach it to a tagged release
- [ ] CHANGELOG and a version bump rule (version is still 0.1.0 and `private: true`)
- [ ] Auto-update: the updater today looks in a local folder (`app.updateFolder`); decide on GitHub Releases as the source
- [ ] Crash and error reporting that stays local unless the user sends it
- [ ] Public README pass: screenshots of the orb speaking, honest hardware requirements (GPU and VRAM tiers from the model router)
- [ ] Remove the duplicate `Documents\NovaAI-Backend` folder (delete was denied earlier)

## Phase 4: Public launch

- [ ] Invite 3 to 5 people with different machines (no GPU, 8 GB, 24 GB) and watch them install
- [ ] Fix what they hit; publish release 0.2.0 on GitHub
- [ ] Short demo video and a plain-language page on the safety filter, including the two limits that cannot be changed

## Later

- macOS and Linux builds (the sidecar spec is portable; the installer, tray, window tracking and autostart are Windows-first)
- A model-based classifier for the harm filter (the hook exists: `HarmFilter(classifier=...)`)
- Image and video generation surfaces, training review, and the Code agent as first-class parts of the public app

## Open decisions

1. ~~Voice pack~~ Decided Oct 29: bundle the torch-free engines, download the model files in setup. Still open: a way to retry the download from the app's settings or tray (the backend endpoints exist).
2. ~~Ollama~~ Decided Oct 29: setup installs it silently, and tells the user in plain words what is happening (what is being downloaded, how big, why, and that it can be removed later). Detecting an existing install comes first, so nobody gets a second copy.
3. Updates: GitHub Releases, or keep the folder-based updater?
4. Signing: which certificate, and who holds it?
5. Roadmap decision 9 ("the app never starts anything on its own") was changed for the bundled backend only; confirm that is the intended boundary.
6. ~~Cloud models~~ Decided Oct 29: strictly local by default, nothing leaves the machine. Cloud models are an opt-in the user can switch on in settings (their own key, off until they do), and model routing treats them as one more candidate with a plain-language label saying the question leaves the computer.
