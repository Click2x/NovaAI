# Nova.Ai

Nova.Ai is a desktop companion: a VRM avatar that lives on your desktop, talks and listens, can look at your window when you ask, and sits beside a small chat window. This repository is the desktop app only (Electron, plain JavaScript).

## What it does

- Transparent always-on-top avatar with lip-sync and expressions; click-through except over her. Right-click her for a radial menu.
- The avatar is optional: hide it (Ctrl+Alt+N, tray, radial menu) and Nova keeps running. A chat window (Ctrl+Alt+C) opens beside her and is placed from the same origin as the avatar, so dragging either moves both.
- Voice in (wake word, push-to-talk style commands) and voice out, speech bubble, history drawer, thumbs and reactions.
- Notification centre, tray menus, a Home window that hosts the Nova web app, a Code window for the agent, GPU and training status.
- Settings panel for voice, listening, screen looks, display, chat mode, notifications and the agent.

## What you need

Nova.Ai is a client. It talks to a **Nova backend** over a local WebSocket (`ws://127.0.0.1:8000`, protocol v1: `/api/desktop/ws` and `/api/agent/ws`). The backend is not part of this repository and is not published yet, so the app does not do anything useful on its own. Point it at a compatible backend with `NOVA_BACKEND` or Settings > Backend.

## Build and run

```
npm install
npm start          # builds with Vite, then launches Electron
npm test           # pure node tests, no Electron or backend needed
npm run dist       # Windows installer (electron-builder)
```

Settings live in `settings.json` under the Electron user-data folder; environment variables such as `NOVA_BACKEND`, `NOVA_TTS` and `NOVA_VOICE_IN` override them (see `electron/settings.js`).

## Avatar

`assets/vrm/Nova_v1_grunge.vrm` is bundled and is the avatar the app loads. Set `NOVA_VRM=<path to a .vrm file>` to use your own. A picker in Settings is planned.

## License

GPL-3.0-only, see `LICENSE`. The bundled avatar is distributed with this repository; check it before reusing it elsewhere.

## History

This repository was split from the private Nova project with its commit history kept (`git subtree split` of `desktop/`).
