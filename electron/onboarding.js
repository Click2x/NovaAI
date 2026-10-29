// The guided setup window. It owns three things the page cannot do for itself: the window (sandboxed, navigation pinned), a native file
// picker for a custom avatar (checked here before it is trusted), and opening the Ollama download page in the browser. The page talks to the
// backend's /api/onboarding itself. Pure helpers are exported for tests.
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const CONFIG = 'onboarding-config'
const PICK = 'onboarding-pick-avatar'
const OPEN_EXTERNAL = 'onboarding-open-external'
const FINISH = 'onboarding-finish'
const LATER = 'onboarding-later'

const MAX_VRM_BYTES = 120 * 1024 * 1024
const EXTERNAL_OK = new Set(['https://ollama.com/download', 'https://ollama.com/'])

// An avatar must be a .vrm file that exists, is a regular file of a sane size, and starts with the glTF binary magic ("glTF"), since a
// VRM is a GLB. Anything else is refused with a message the page can show.
function validateVrm(file, fsApi = fs) {
  if (typeof file !== 'string' || !/\.vrm$/i.test(file) || file.length > 260) return { ok: false, error: 'Please choose a .vrm file.' }
  try {
    const st = fsApi.statSync(file)
    if (!st.isFile()) return { ok: false, error: 'That is not a file.' }
    if (st.size < 1024) return { ok: false, error: 'That file is too small to be an avatar.' }
    if (st.size > MAX_VRM_BYTES) return { ok: false, error: 'That avatar is larger than 120 MB.' }
    const fd = fsApi.openSync(file, 'r')
    try {
      const head = Buffer.alloc(4)
      fsApi.readSync(fd, head, 0, 4, 0)
      if (head.toString('latin1') !== 'glTF') return { ok: false, error: 'That does not look like a VRM avatar.' }
    } finally { fsApi.closeSync(fd) }
    return { ok: true, path: file, name: path.basename(file) }
  } catch {
    return { ok: false, error: 'I could not read that file.' }
  }
}

function allowExternal(url) {
  return EXTERNAL_OK.has(String(url))
}

// Should the setup window open by itself when the app starts?
//   backend: { reachable, supported, done } from GET /api/onboarding (supported = it answered with a setup state)
//   app: the saved app.onboardingDone / onboardingDismissed
// An older backend that has no setup endpoint is left alone; a missing backend on a fresh install gets the "start my backend" screen.
function shouldAutoOpen(backend, app) {
  if (app.onboardingDone || app.onboardingDismissed) return false
  if (!backend.reachable) return true
  if (!backend.supported) return false
  return !backend.done
}

async function probeBackend(httpBase, fetchFn = globalThis.fetch, timeoutMs = 3000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchFn(String(httpBase).replace(/\/+$/, '') + '/api/onboarding', { signal: ctl.signal })
    if (!r.ok) return { reachable: true, supported: false, done: false }
    const body = await r.json().catch(() => null)
    const supported = !!body && typeof body.step === 'string'
    return { reachable: true, supported, done: supported && body.done === true }
  } catch {
    return { reachable: false, supported: false, done: false }
  } finally { clearTimeout(t) }
}

// Where the window goes: its size (never larger than the work area minus a margin), centred on the work area of the display it opens on.
// The window is created without a position and then given these bounds again once it exists: with monitors of different scale factors a window
// created at one size can come up scaled by the ratio between them (seen as a 281x336 window instead of 560x800), and only an explicit
// setBounds on the real display fixes it. Same reason the avatar window uses setBounds.
function centeredBounds(workArea, size, margin = 24) {
  const width = Math.max(320, Math.min(size.width, workArea.width - margin * 2))
  const height = Math.max(420, Math.min(size.height, workArea.height - margin * 2))
  return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + (workArea.height - height) / 2), width, height }
}

// `backend` is the bundled backend's status ({ state, reason, logFile }); the page uses it to say why it cannot reach one.
function pageConfig({ httpBase, vrmName, backend }) {
  const b = backend && typeof backend === 'object' ? backend : {}
  return {
    httpBase: String(httpBase).replace(/\/+$/, ''), vrmName: vrmName || '',
    backend: { state: ['starting', 'online', 'failed'].includes(b.state) ? b.state : 'none', reason: String(b.reason || '').slice(0, 300), logFile: String(b.logFile || '') },
  }
}

function allowNavigation(url, ownPrefix) {
  return String(url).startsWith(ownPrefix)
}

const WINDOW_SIZE = { width: 560, height: 800 }

// deps: { ipcMain, BrowserWindow, dialog, shell, screen, DEV, getBase(), getVrmName(), setAvatar(file) -> void, onFinish(), onLater(), distDir, preload }
function registerOnboarding(deps) {
  const { ipcMain, BrowserWindow, dialog, shell, screen, DEV, getBase, getVrmName, getBackend = () => null, setAvatar, onFinish, onLater, distDir, preload } = deps
  let win = null
  const alive = () => !!win && !win.isDestroyed()
  const mine = (e) => alive() && e.sender === win.webContents

  ipcMain.handle(CONFIG, (e) => (mine(e) ? pageConfig({ httpBase: getBase(), vrmName: getVrmName(), backend: getBackend() }) : null))
  ipcMain.handle(PICK, async (e) => {
    if (!mine(e)) return { ok: false, error: 'Not allowed.' }
    const r = await dialog.showOpenDialog(win, { title: 'Choose an avatar', properties: ['openFile'], filters: [{ name: 'VRM avatar', extensions: ['vrm'] }] })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    const v = validateVrm(r.filePaths[0])
    if (!v.ok) return v
    setAvatar(v.path)
    return { ok: true, name: v.name, path: v.path }
  })
  ipcMain.handle(OPEN_EXTERNAL, (e, url) => {
    if (!mine(e) || !allowExternal(url)) return false
    shell.openExternal(String(url))
    return true
  })
  ipcMain.on(FINISH, (e) => { if (mine(e)) { close(); onFinish() } })
  ipcMain.on(LATER, (e) => { if (mine(e)) { close(); onLater() } })

  function open() {
    if (alive()) { win.show(); win.focus(); return win }
    const place = () => {
      const d = screen.getPrimaryDisplay()
      return centeredBounds(d.workArea, WINDOW_SIZE)
    }
    win = new BrowserWindow({
      ...place(), minWidth: 320, minHeight: 420, show: false, title: 'Nova - Setup', backgroundColor: '#14121f', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload, backgroundThrottling: false },
    })
    win.setBounds(place())
    win.once('ready-to-show', () => { if (alive()) { win.setBounds(place()); win.show() } })
    const own = DEV ? 'http://localhost:5174/' : pathToFileURL(path.join(distDir, 'onboarding.html')).href.replace(/onboarding\.html$/, '')
    win.webContents.on('will-navigate', (ev, url) => { if (!allowNavigation(url, own)) ev.preventDefault() })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (DEV) win.loadURL('http://localhost:5174/onboarding.html')
    else win.loadFile(path.join(distDir, 'onboarding.html'))
    win.on('closed', () => { win = null })
    return win
  }
  function close() { if (alive()) win.close(); win = null }
  return { open, close, isOpen: alive, getWindow: () => win }
}

module.exports = { registerOnboarding, centeredBounds, WINDOW_SIZE, validateVrm, allowExternal, shouldAutoOpen, probeBackend, pageConfig, allowNavigation, MAX_VRM_BYTES, CONFIG, PICK, OPEN_EXTERNAL, FINISH, LATER }
