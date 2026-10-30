# Nova.Ai roadmap

Where we are (Oct 29, 2026): the desktop app, the guided voiced setup and the backend are built, tested (345 desktop tests, 79 backend) and pushed. The backend now ships inside the installer as a sidecar. What stands between this and a public release is proof that a stranger can install it and have it work.

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
- [ ] Memory screen: list what she knows grouped by kind (identity, preference, boundary, picked up in chat); edit, delete, add, export, clear. The backend already has `/api/memory`; this is app-side work
- [ ] Automatic memory: after each turn a cheap background pass extracts durable facts and merges duplicates; she says when she saved something; old chats are summarized instead of lost
- [ ] Uninstall story: what is kept in `~/.novaai` and the app data folder, and a way to delete it

## Phase 2b: The routing and memory story

Goal: the part that makes Nova.Ai different works with no setup by the user, and the user can look at all of it.

- [ ] Tool routing by the tools model instead of the phrase list in `router.route_turn`; more tools (timers and reminders, notes, screen look) behind one permission model with plain on/off switches
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
