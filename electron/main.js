// Nova desktop: transparent, always-on-top avatar window with per-pixel click-through.
//
// Click-through design: the OS only delivers mouse events to a window that is NOT ignoring them,
// and forwarded mouse-moves are unreliable on Windows. So the main process polls the global cursor,
// sends it (window-relative) to the renderer, and the renderer reads the alpha of the pixel under
// the cursor and answers with set-interactive. The window ignores the mouse except over the avatar.
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, screen, protocol, net, nativeImage, powerMonitor, session, desktopCapturer, shell } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const fs = require('fs')
const { createPrivacy } = require('./privacy')
const { createTracker, powershellProvider, getWindowsProvider } = require('./windowtrack')
const { captureActiveWindow } = require('./capture')
const settingsLib = require('./settings')
const placement = require('./placement')
const { SECTION, registerTraySection, buildTemplate } = require('./tray')
const { createHome } = require('./home')
const services = require('./services')
const { registerUpdates } = require('./updates')
const { registerVersionHandshake } = require('./version')
const { spawn } = require('child_process')

// NOVA_USER_DATA=<dir> keeps a test run's settings away from the real ones.
if (process.env.NOVA_USER_DATA) app.setPath('userData', path.resolve(process.env.NOVA_USER_DATA))

// Nova speaks without the user having clicked in this window first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const DEV = process.env.NOVA_DEV === '1'
const WIN_W = 420
const WIN_H = 680
const POLL_MS = 33
// Packaged builds carry the model in resources/ (electron-builder extraResources); from source it is the repo's vrm_models folder.
const DEFAULT_VRM = app.isPackaged
  ? path.join(process.resourcesPath, 'vrm', 'Nova_v1_grunge.vrm')
  : path.resolve(__dirname, '..', '..', 'vrm_models', 'Nova_v1_grunge.vrm')
const VRM_PATH = process.env.NOVA_VRM ? path.resolve(process.env.NOVA_VRM) : DEFAULT_VRM

// Only this one file is ever served through nova-asset://, no path is taken from the URL.
protocol.registerSchemesAsPrivileged([
  { scheme: 'nova-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let win = null
let tray = null
let pollTimer = null
let interactive = false
let drag = null // { cursor, origin } while the avatar is being dragged
let debug = process.env.NOVA_DEBUG === '1'
let tracker = null
let trackerStarting = false
const privacy = createPrivacy()

// ── settings: one JSON file under userData; env vars override while set (see settings.js) ──
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')
let stored = settingsLib.sanitize(null)
let netState = { status: 'connecting', retryMs: 0, attempt: 0 }
let settingsWin = null
let saveTimer = null
const effectiveState = () => settingsLib.effective(stored, process.env)
const eff = () => effectiveState().settings
function loadSettings() {
  const r = settingsLib.loadFrom(fs, SETTINGS_FILE())
  stored = r.settings
  smokeLogLine(`settings ${r.status} ${SETTINGS_FILE()}`)
}
function saveSettingsSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveSettingsNow, 300)
}
function saveSettingsNow() {
  clearTimeout(saveTimer)
  try { settingsLib.saveTo(fs, SETTINGS_FILE(), stored) } catch (err) { console.error('could not save settings', err) }
}
function settingsView() {
  const { settings, locked } = effectiveState()
  let loginItem = null
  try { loginItem = app.getLoginItemSettings().openAtLogin } catch {}
  return { stored, effective: settings, locked, meta: { packaged: app.isPackaged, loginItem, file: SETTINGS_FILE(), defaults: settingsLib.DEFAULTS } }
}
function updateSettings(patch) {
  const before = eff()
  stored = settingsLib.applyPatch(stored, patch)
  saveSettingsSoon()
  onSettingsChanged(before, eff())
  return settingsView()
}
function onSettingsChanged(before, now) {
  if (before.app.autostart !== now.app.autostart) {
    const r = settingsLib.applyAutostart(app, now.app.autostart, app.isPackaged)
    smokeLogLine(`autostart ${now.app.autostart} ${r.applied ? 'applied' : 'not applied (' + r.reason + ')'}`)
  }
  if (before.screen.trackWindow !== now.screen.trackWindow) {
    if (now.screen.trackWindow) startWindowTracking()
    else stopWindowTracking()
  }
  buildTrayMenu()
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents) w.webContents.send('settings-changed')
}
const smokeLogLine = (line) => { if (process.env.NOVA_SMOKE_LOG) fs.appendFileSync(process.env.NOVA_SMOKE_LOG, String(line) + '\n') }

function createWindow() {
  const { bounds } = placement.resolve(screen.getAllDisplays(), screen.getPrimaryDisplay(), stored.placement, { width: WIN_W, height: WIN_H })
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true) // click-through until the renderer says the cursor is on the avatar

  if (DEV) win.loadURL('http://localhost:5174')
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  win.once('ready-to-show', () => win.showInactive())
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg) })

  // NOVA_SMOKE=<png path>: wait for the avatar to render, save a capture of the window, then quit.
  if (process.env.NOVA_SMOKE) {
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(process.env.NOVA_SMOKE, img.toPNG())
      console.log('[smoke] saved', process.env.NOVA_SMOKE)
      app.quit()
    }, Number(process.env.NOVA_SMOKE_DELAY) || 6000))
  }
  win.webContents.on('did-finish-load', () => { win.webContents.send('debug', debug); if (tracker) win.webContents.send('window', tracker.view()) })
  win.on('closed', () => { win = null })
}

function startCursorPolling() {
  pollTimer = setInterval(() => {
    if (!win || !win.isVisible()) return
    const c = screen.getCursorScreenPoint()
    if (drag) {
      // setBounds with the fixed size: setPosition alone can resize a transparent window when it crosses to a display with another scale factor
      win.setBounds({ x: drag.origin.x + (c.x - drag.cursor.x), y: drag.origin.y + (c.y - drag.cursor.y), width: WIN_W, height: drag.height })
    }
    const b = win.getBounds()
    win.webContents.send('cursor', { x: c.x - b.x, y: c.y - b.y, w: b.width, h: b.height })
  }, POLL_MS)
}

function createTray() {
  // build/icon.png (tools/make-icon.js) ships in the package; the solid square is only the fallback if the file is missing.
  let icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
  icon = icon.isEmpty() ? nativeImage.createFromBuffer(solidPng(16, 16, [150, 90, 220, 255])) : icon.resize({ width: 16, height: 16, quality: 'best' })
  tray = new Tray(icon)
  tray.setToolTip('Nova')
  buildTrayMenu()
  tray.on('click', () => { toggleVisible(); buildTrayMenu() })
  tray.on('right-click', () => { buildTrayMenu(); healthPoller.refresh() })
}

function netLabel() {
  if (netState.status === 'online') return 'Backend: connected'
  if (netState.status === 'offline') return `Backend: offline - retry now${netState.retryMs ? ` (auto in ${Math.max(1, Math.round(netState.retryMs / 1000))}s)` : ''}`
  return 'Backend: connecting...'
}

// The menu is a registry of sections (tray.js); later phases register their own. Order numbers: see SECTION.
function buildTrayMenu() {
  if (!tray) return
  tray.setToolTip((netState.status === 'online' ? 'Nova' : netState.status === 'offline' ? `Nova - backend offline, retrying (attempt ${netState.attempt || 1})` : 'Nova - connecting') + versionCheck.tooltipSuffix())
  const ctx = { settings: eff(), locked: effectiveState().locked, visible: !!(win && win.isVisible()), net: netState }
  tray.setContextMenu(Menu.buildFromTemplate(buildTemplate(ctx, {
    quit: () => app.quit(),
    onError: (err, section) => console.error('tray section failed', section.order, err),
  })))
}

registerTraySection(SECTION.NOVA, (ctx) => [
  { label: ctx.visible ? 'Hide Nova' : 'Show Nova', click: () => { toggleVisible(); buildTrayMenu() } },
  { label: netLabel(), enabled: ctx.net.status !== 'online', click: () => { if (win) win.webContents.send('retry-connect') } },
])
registerTraySection(SECTION.NOVA + 1, () => [
  { label: 'Open Nova Home (Ctrl+Alt+H)', click: () => openHome() },
  { label: 'Settings...', click: openSettingsWindow },
  { label: 'Start with Windows', type: 'checkbox', checked: eff().app.autostart, click: (i) => updateSettings({ app: { autostart: i.checked } }) },
])
registerTraySection(SECTION.VOICE, (ctx) => [
  { label: 'Microphone', type: 'checkbox', checked: ctx.settings.listen.micOn, enabled: !ctx.locked.includes('listen.micOn'), click: (i) => updateSettings({ listen: { micOn: i.checked } }) },
])
registerTraySection(SECTION.SCREEN, (ctx) => [
  { label: 'Screen looks', type: 'checkbox', checked: ctx.settings.screen.looks, enabled: !ctx.locked.includes('screen.looks'), click: (i) => updateSettings({ screen: { looks: i.checked } }) },
])
registerTraySection(SECTION.CODE, () => [{ label: 'Code...', click: () => openCodeWindow() }])
registerTraySection(SECTION.DEBUG, () => [{ label: 'Debug overlay (Ctrl+Alt+D)', type: 'checkbox', checked: debug, click: (i) => setDebug(i.checked) }])

// ── Nova Home (the React web app in a framed window) and backend lifecycle ──
const home = createHome({
  BrowserWindow, shell, session,
  getSettings: eff,
  getBackendUrl: () => settingsLib.backendHttpUrl(eff(), process.env),
  version: app.getVersion(),
  smokeLog: (line) => smokeLogLine(line),
})
const openHome = (panel) => home.openHome(panel)

let health = null
const healthPoller = services.createHealthPoller({
  getBase: () => settingsLib.backendHttpUrl(eff(), process.env),
  onChange: (h) => { health = h; smokeLogLine(`health ${services.healthLabel(h)}`); buildTrayMenu() },
})
services.registerServices({
  registerTraySection, SECTION, spawn, fs, shell,
  getSettings: eff,
  getLogFile: () => path.join(app.getPath('userData'), 'logs', 'start.log'),
  getHealth: () => health,
  isSocketOnline: () => netState.status === 'online',
  poller: healthPoller,
  rebuildTray: buildTrayMenu,
  smokeLog: (line) => smokeLogLine(line),
})

// P9 tray GPU submenu (what is loaded, what holds the card, Free GPU / Load chat model); loopback backend only
const gpuTray = require('./gpu').registerGpu({ registerTraySection, getBase: () => settingsLib.backendHttpUrl(eff(), process.env), isBackendOnline: () => !!(health && health.online) || netState.status === 'online', rebuildTray: buildTrayMenu })

require('./today').registerToday({ registerTraySection, SECTION, getBase: () => settingsLib.backendHttpUrl(eff(), process.env), openHome, rebuildTray: buildTrayMenu }).start()  // P10 tray "Today"

require('./training').registerTraining({ registerTraySection, getBase: () => settingsLib.backendHttpUrl(eff(), process.env), openHome, rebuildTray: buildTrayMenu }).start()  // P11 tray "Review N training pairs"

// P8 notification centre: the overlay holds the cards and reports the list; the tray shows a count and "Clear notifications".
const notes = require('./notifications').registerNotifications({
  registerTraySection, rebuildTray: buildTrayMenu,
  clear: () => { if (win && !win.isDestroyed()) win.webContents.send('notes-clear') },
})
ipcMain.on('notes-state', (_e, list) => notes.setItems(list))
// What the speak rule needs to know right now: is her window showing, and is a fullscreen app in front (null = unknown, e.g. window tracking is off).
ipcMain.handle('foreground-state', () => {
  const visible = !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
  const w = tracker && tracker.latest()
  let fullscreen = null
  if (w && w.bounds && tracker.ageMs() < 15000) fullscreen = require('./notifications').isFullscreenWindow(w, screen.getDisplayNearestPoint({ x: Math.round(w.bounds.x + w.bounds.width / 2), y: Math.round(w.bounds.y + w.bounds.height / 2) }))
  return { visible, fullscreen }
})

// Version handshake (backend_version from hello_ack, forwarded by the renderer) and the manual update check from a local folder.
const versionCheck = registerVersionHandshake({
  registerTraySection, SECTION, getAppVersion: () => app.getVersion(), rebuildTray: buildTrayMenu, log: (line) => smokeLogLine(line),
})
ipcMain.on('backend-version', (_e, v) => versionCheck.setBackendVersion(v))
registerUpdates({
  registerTraySection, SECTION, fs, shell, getSettings: eff, getVersion: () => app.getVersion(), rebuildTray: buildTrayMenu, log: (line) => smokeLogLine(line),
})

// Regular framed window for the settings panel (the overlay is click-through, so it cannot host form controls).
function openSettingsWindow() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Nova - Settings',
    backgroundColor: '#1b1830',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  if (DEV) settingsWin.loadURL('http://localhost:5174/settings.html')
  else settingsWin.loadFile(path.join(__dirname, '..', 'dist', 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
  settingsWin.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[settings]', msg) })
}

// Minimal uncompressed-deflate PNG encoder so the tray needs no binary asset.
function solidPng(w, h, rgba) {
  const zlib = require('zlib')
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgba).flat())])
  const raw = Buffer.concat(Array(h).fill(row))
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// P13 Code window: the desktop client of the backend agent (electron/code.js; the page is src/code/).
const codeWindow = require('./code').registerCode({
  ipcMain, BrowserWindow, dialog, DEV,
  getBase: () => settingsLib.backendHttpUrl(eff(), process.env),
  getEff: eff,
  saveWorkspace: (folder) => updateSettings({ agent: { workspace: folder } }),
  distDir: path.join(__dirname, '..', 'dist'),
  preload: path.join(__dirname, 'code-preload.js'),
})
const openCodeWindow = () => codeWindow.open()

function toggleVisible() {
  if (!win) return
  if (win.isVisible()) win.hide()
  else win.showInactive()
}

function setDebug(on) {
  debug = on
  if (win) win.webContents.send('debug', debug)
}

app.whenReady().then(() => {
  // The microphone, for this app's own pages only (file:// build, or the Vite dev server). Nothing else may ask for it.
  // The Home window (web content) lives in its own session partition with every permission denied (home.js), so these handlers never see it.
  const ownPage = (url) => /^(file:\/\/|http:\/\/(localhost|127\.0\.0\.1):5174\/)/.test(url || '')
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && ownPage(wc.getURL())))
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && ownPage(wc ? wc.getURL() : ''))

  protocol.handle('nova-asset', (req) => {
    if (new URL(req.url).hostname !== 'avatar.vrm' || !fs.existsSync(VRM_PATH)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(VRM_PATH).toString())
  })

  loadSettings()
  const initial = eff()
  if (app.isPackaged && initial.app.autostart !== (settingsView().meta.loginItem === true)) settingsLib.applyAutostart(app, initial.app.autostart, true)
  createWindow()
  createTray()
  healthPoller.start()
  gpuTray.start()
  startCursorPolling()
  if (initial.screen.trackWindow) startWindowTracking()
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, replaceWindow)
  if (process.env.NOVA_OPEN_SETTINGS || process.env.NOVA_SMOKE_SETTINGS) smokeSettings()
  if (process.env.NOVA_SMOKE_HOME) smokeHome()
  if (process.env.NOVA_SMOKE_CODE) openCodeWindow()        // test hook: open the Code window, capture it after NOVA_SMOKE_CODE_DELAY ms (code.js)

  globalShortcut.register('Control+Alt+Space', openInput)
  globalShortcut.register('Control+Alt+N', toggleVisible)
  globalShortcut.register('Control+Alt+D', () => setDebug(!debug))
  globalShortcut.register('Control+Alt+H', () => openHome())
  globalShortcut.register('Control+Alt+S', () => { if (win) win.webContents.send('interrupt') })   // stop talking
})

ipcMain.on('set-interactive', (_e, on) => {
  if (!win || on === interactive) return
  interactive = on
  win.setIgnoreMouseEvents(!on)
})

// The overlay never takes focus on its own; typing is the one case where it must.
function openInput() {
  if (!win) return
  if (!win.isVisible()) win.showInactive()
  win.focus()
  win.webContents.send('open-input')
}
ipcMain.on('input-closed', () => { if (win) win.blur() })

// ── active window (local only) and screen looks (on demand only) ───────────────
// Window tracking is the setting screen.trackWindow (env NOVA_WINDOW_TRACK=0 overrides); off means screen looks always refuse. NOVA_FAKE_WINDOW='{"app":"Code.exe","title":"x"}' is a test hook.
async function startWindowTracking() {
  if (tracker || trackerStarting) return
  trackerStarting = true
  let provider
  const fake = parseJson(process.env.NOVA_FAKE_WINDOW)
  if (fake) {
    provider = { name: 'fake', start: (cb) => { cb({ app: fake.app, title: fake.title || '', pid: 1, bounds: null }) }, stop() {} }
  } else {
    provider = (await getWindowsProvider({ intervalMs: 2000 })) || powershellProvider({ intervalMs: 1000 })
  }
  tracker = createTracker({
    provider, privacy,
    onChange: (view) => { if (win) win.webContents.send('window', view) },
  })
  trackerStarting = false
  tracker.start()
  smokeLogLine('window tracking: ' + provider.name)
}
function stopWindowTracking() {
  if (!tracker) return
  tracker.stop()
  tracker = null
  smokeLogLine('window tracking: off')
  if (win) win.webContents.send('window', null)
}

// A brief border around what was captured, so a screen look is never silent.
function flashCapture(rect) {
  try {
    const f = new BrowserWindow({
      x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      transparent: true, frame: false, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    })
    f.setIgnoreMouseEvents(true)
    f.setAlwaysOnTop(true, 'screen-saver')
    const html = '<style>html,body{margin:0;height:100%;background:transparent}div{position:fixed;inset:0;box-sizing:border-box;border:6px solid #a78bfa;'
      + 'box-shadow:inset 0 0 40px rgba(167,139,250,.6);animation:f .7s ease-out forwards}@keyframes f{from{opacity:1}to{opacity:0}}</style><div></div>'
    f.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    f.once('ready-to-show', () => f.showInactive())
    setTimeout(() => { if (!f.isDestroyed()) f.close() }, 900)
    smokeLogLine(`capture flash ${Math.round(rect.width)}x${Math.round(rect.height)}`)
  } catch {}
}

ipcMain.handle('capture-screen', async () => {
  if (!tracker) return { ok: false, reason: 'off' }
  const r = await captureActiveWindow({
    desktopCapturer, screen, tracker, privacy,
    scope: eff().screen.scope,
    hideOverlay: () => { if (win) win.setOpacity(0) },
    showOverlay: () => { if (win) win.setOpacity(1) },
  })
  if (r.ok) {
    flashCapture(r.flashBounds)
    smokeLogLine(`capture ok app=${r.app} ${r.width}x${r.height} jpeg=${r.bytes}B cropped=${r.cropped} in ${r.ms} ms`)
    delete r.flashBounds
  } else {
    smokeLogLine(`capture refused reason=${r.reason}${r.error ? ' ' + r.error : ''}`)
  }
  return r
})
ipcMain.handle('get-window', () => (tracker ? tracker.view() : null))

// Seconds since the user last touched keyboard or mouse; lets the backend decide between a desktop bubble and a phone push.
ipcMain.handle('idle-seconds', () => powerMonitor.getSystemIdleTime())

ipcMain.handle('get-config', () => {
  const e = eff()
  return {
    backend: settingsLib.backendWsUrl(e, process.env),   // NOVA_BACKEND (ws://...) still wins
    smokeUi: process.env.NOVA_SMOKE_UI || '',   // test hook: comma list of rate, react, drawer; the overlay clicks those controls itself
    backendHttp: settingsLib.backendHttpUrl(e, process.env),   // where the overlay loads pictures and video from
    autoSay: process.env.NOVA_SMOKE_SAY || null, // test hook: send this text once connected
    // Everything below comes from the settings file with env overrides on top (settings.js); the renderer re-reads it on 'settings-changed'.
    backendSettings: settingsLib.toBackend(e),   // the `settings` message for the backend
    proactive: e.proactive,                      // P8 speak rule + quiet hours (decided in the overlay, src/ui/speakrule.js)
    screen: e.screen.looks && e.screen.trackWindow,
    voiceIn: e.listen.micOn,
    micDeviceId: e.listen.micDeviceId,
    echoMode: e.listen.echoMode,
    smokeWavs: smokeWavs().length, // test hook: NOVA_SMOKE_WAV=a.wav,b.wav plays these through the VAD instead of the microphone
    smokeWavGapMs: Number(process.env.NOVA_SMOKE_WAV_GAP) || 3500,
  }
})
function parseJson(text) { try { return text ? JSON.parse(text) : null } catch { return null } }
function smokeWavs() { return (process.env.NOVA_SMOKE_WAV || '').split(',').map((p) => p.trim()).filter(Boolean) }
ipcMain.handle('smoke-wav', (_e, i) => {
  const file = smokeWavs()[i]
  if (!file) throw new Error('no such smoke wav')
  const b = fs.readFileSync(file)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
})

ipcMain.handle('settings-get', () => settingsView())
ipcMain.handle('settings-set', (_e, patch) => updateSettings(patch))
ipcMain.handle('settings-reset', () => {
  // Back to defaults, but she keeps her screen positions.
  const before = eff()
  stored = settingsLib.sanitize({ placement: stored.placement })
  saveSettingsSoon()
  onSettingsChanged(before, eff())
  return settingsView()
})
ipcMain.on('open-settings', openSettingsWindow)
ipcMain.on('net-status', (_e, info) => {
  netState = { status: String(info && info.status), retryMs: Number(info && info.retryMs) || 0, attempt: Number(info && info.attempt) || 0 }
  smokeLogLine(`net ${netState.status} attempt=${netState.attempt} retryMs=${netState.retryMs}`)
  buildTrayMenu()
})

// Test hooks: NOVA_OPEN_SETTINGS=1 opens the panel at start; NOVA_SMOKE_SETTINGS=<png> also captures it; NOVA_SMOKE_SETTINGS_JS=<file> runs that script
// in the panel first (it drives the real controls), then the capture follows. NOVA_SMOKE_SETTINGS_DELAY=<ms> waits before the capture.
function smokeSettings() {
  openSettingsWindow()
  settingsWin.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500))
    if (process.env.NOVA_SMOKE_SETTINGS_JS) {
      try {
        const out = await settingsWin.webContents.executeJavaScript(fs.readFileSync(process.env.NOVA_SMOKE_SETTINGS_JS, 'utf8'))
        smokeLogLine('settings script: ' + JSON.stringify(out))
      } catch (err) { smokeLogLine('settings script failed: ' + err.message) }
    }
    if (process.env.NOVA_SMOKE_SETTINGS) {
      await new Promise((r) => setTimeout(r, Number(process.env.NOVA_SMOKE_SETTINGS_DELAY) || 800))
      fs.writeFileSync(process.env.NOVA_SMOKE_SETTINGS, (await settingsWin.webContents.capturePage()).toPNG())
      await settingsWin.webContents.executeJavaScript('window.scrollTo(0, 99999)')   // the panel is taller than the window: second capture of the bottom
      await new Promise((r) => setTimeout(r, 300))
      fs.writeFileSync(process.env.NOVA_SMOKE_SETTINGS.replace(/\.png$/, '-bottom.png'), (await settingsWin.webContents.capturePage()).toPNG())
      smokeLogLine('settings panel saved ' + process.env.NOVA_SMOKE_SETTINGS)
    }
  })
}

// Test hook: NOVA_SMOKE_HOME=<png> opens Home on #panel=<NOVA_SMOKE_HOME_PANEL, default memory>, waits, reports what the page sees, saves a capture and quits.
// NOVA_SMOKE_HOME_DELAY=<ms> waits before the capture (default 3000); NOVA_SMOKE_HOME_JS=<file> runs that script in the page first.
async function smokeHome() {
  const panel = process.env.NOVA_SMOKE_HOME_PANEL || 'memory'
  const r = await openHome(panel)
  const wc = home.getWindow().webContents
  if (wc.isLoading()) await Promise.race([new Promise((res) => wc.once('did-finish-load', res)), new Promise((res) => setTimeout(res, 10000))])
  smokeLogLine('home loading=' + wc.isLoading())
  await new Promise((res) => setTimeout(res, Number(process.env.NOVA_SMOKE_HOME_DELAY) || 3000))
  try {
    const info = await wc.executeJavaScript(`JSON.stringify({ href: location.href, title: document.title, isDesktop: !!(window.novaDesktop && window.novaDesktop.isDesktop), version: window.novaDesktop && window.novaDesktop.version,
      nodeLeak: typeof require + '/' + typeof process, nova: typeof window.nova, serviceWorker: navigator.serviceWorker ? 'present' : 'none', text: document.body.innerText.slice(0, 160) })`)
    smokeLogLine('home page ' + info)
    if (process.env.NOVA_SMOKE_HOME_JS) smokeLogLine('home script ' + JSON.stringify(await wc.executeJavaScript(fs.readFileSync(process.env.NOVA_SMOKE_HOME_JS, 'utf8'))))
  } catch (err) { smokeLogLine('home page script failed: ' + err.message) }
  fs.writeFileSync(process.env.NOVA_SMOKE_HOME, (await wc.capturePage()).toPNG())
  smokeLogLine(`home saved ${process.env.NOVA_SMOKE_HOME} source=${r.source}`)
  app.quit()
}

// Test hook: NOVA_SMOKE_LOG=<file> collects lines the renderer reports (audio frames, playback, mouth movement).
ipcMain.on('smoke-log', (_e, line) => {
  if (process.env.NOVA_SMOKE_LOG) fs.appendFileSync(process.env.NOVA_SMOKE_LOG, String(line) + '\n')
})

ipcMain.on('drag-start', () => {
  if (!win) return
  const b = win.getBounds()
  drag = { cursor: screen.getCursorScreenPoint(), origin: { x: b.x, y: b.y }, height: b.height }
})
ipcMain.on('drag-end', () => { drag = null; rememberPosition() })

// ── placement per display ──────────────────────────────────────────────────────
// After a drag the position is remembered as an offset from the bottom-right of the display she is on (placement.js). When displays are
// added, removed or change resolution/scale she goes back to the remembered spot on her display (or the primary) and is clamped on screen.
function rememberPosition() {
  if (!win) return
  stored.placement = placement.remember(screen.getAllDisplays(), stored.placement, win.getBounds())
  saveSettingsSoon()
  smokeLogLine(`position display=${stored.placement.lastDisplay} offset=${JSON.stringify(stored.placement.byDisplay[stored.placement.lastDisplay])}`)
}
function replaceWindow() {
  if (!win || drag) return
  const { bounds, display } = placement.resolve(screen.getAllDisplays(), screen.getPrimaryDisplay(), stored.placement, { width: WIN_W, height: WIN_H })
  win.setBounds(bounds)
  smokeLogLine(`placed on display ${display.id} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} (scale ${display.scaleFactor})`)
}

app.on('will-quit', () => { saveSettingsNow(); healthPoller.stop(); gpuTray.stop(); globalShortcut.unregisterAll(); clearInterval(pollTimer); if (tracker) tracker.stop() })
app.on('window-all-closed', () => app.quit())
