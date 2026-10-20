// Preload for the Home window (the React web app). The page is a web origin, so it gets no IPC at all: only a read-only marker
// that tells the app it runs inside Nova Desktop (frontend/src/utils/desktop.js). A sandboxed preload cannot require files, so the
// version arrives as a command-line argument set by home.js (additionalArguments).
const { contextBridge } = require('electron')

const arg = process.argv.find((a) => a.startsWith('--nova-version='))
contextBridge.exposeInMainWorld('novaDesktop', Object.freeze({ isDesktop: true, version: arg ? arg.slice('--nova-version='.length) : 'unknown' }))
