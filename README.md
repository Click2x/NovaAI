# Nova.Ai

Nova.Ai is a desktop companion: a small glowing orb that lives in the corner of your desktop (or your own VRM avatar), talks and listens, can look at your window when you ask, and sits beside a small chat window. This repository is the desktop app only (Electron, plain JavaScript).

![The guided, voiced setup](docs/screenshots/setup.png)

| The text box sits above the orb | The menu fans around the orb |
| --- | --- |
| ![The text box](docs/screenshots/overlay-text-box.png) | ![The radial menu](docs/screenshots/overlay-menu.png) |

## What it does

- Transparent always-on-top orb (or avatar) that swells with her voice and takes the colour of her mood; click-through except over her. Right-click her for a radial menu.
- The display is optional: hide it (Ctrl+Alt+N, tray, radial menu) and Nova keeps running. A chat window (Ctrl+Alt+C) opens beside her and is placed from the same origin as the avatar, so dragging either moves both.
- Everything can be moved and locked: drag the small grip above the speech bubble, the text box and the buttons, the chat window by its title, or the orb itself. Double-click a grip to put that element back. Lock the layout from the radial menu, the tray or Settings > Display and nothing moves; "Reset layout" in the tray puts it all back.
- Voice in (wake word, push-to-talk style commands) and voice out, speech bubble, history drawer, thumbs and reactions.
- Notification centre, tray menus, a Home window that hosts the Nova web app, a Code window for the agent, GPU and training status.
- Settings panel for voice, listening, screen looks, display, chat mode, notifications and the agent.

## What you need

Nova.Ai is a client. It talks to a backend over a local WebSocket (`ws://127.0.0.1:8000`, protocol v1: `/api/desktop/ws`). The backend lives in [`backend/`](backend/README.md) in this repository: a small Python server that uses [Ollama](https://ollama.com) for models, with Mistral NeMo as her voice, a model router for tool calling, a harm filter you can turn off, and a guided, voiced onboarding. The installer carries a frozen copy of it (`novaai-server.exe`, built by `npm run build:backend`), which the app starts on its own at launch when nothing answers at the backend address and stops when it quits; its log is `logs/backend.log` in the app's data folder. The bundled build leaves out Kokoro and faster-whisper (they pull in torch), so she uses your computer's voice until you run the backend from source with `requirements-voice.txt`. You still need [Ollama](https://ollama.com) for the models. From source, start it with `python -m novaai serve`; a backend you start yourself (or a start script) is never replaced by the bundled one.

## First run

On a fresh install the app opens a guided, voiced setup (`Set up Nova...` in the tray opens it again): she introduces herself, checks your machine, downloads her models with spoken progress, gets to know you in a real conversation (type, or use the microphone), lets you audition voices, explains the safety filter in plain words, and lets you keep the orb or choose your own `.vrm` avatar. On the desktop she is a small orb in the corner of the screen (about a tenth of the screen width, adjustable) that swells with her voice; the avatar is an option (Settings > Display > How I look). If no backend is running yet, the setup window says so and shows how to start it. If speech is not installed on the backend, she uses your computer's voice.

## Build and run

```
npm install
npm start          # builds with Vite, then launches Electron
npm test           # pure node tests, no Electron or backend needed
npm run dist       # Windows installer (electron-builder)
```

Settings live in `settings.json` under the Electron user-data folder; environment variables such as `NOVA_BACKEND`, `NOVA_TTS` and `NOVA_VOICE_IN` override them (see `electron/settings.js`).

## Avatar

No avatar model ships with Nova.Ai: she is an orb. To use an avatar of your own, choose a `.vrm` file in setup ("Use my own avatar...") or Settings > Display, then set "How I look" to the avatar. `NOVA_VRM=<path to a .vrm file>` does the same for development.

## License

GPL-3.0-only, see `LICENSE`. No avatar model is distributed with this repository.

## History

This repository was split from the private Nova project with its commit history kept (`git subtree split` of `desktop/`).
