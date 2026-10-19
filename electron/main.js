// Nova desktop: transparent, always-on-top avatar window with per-pixel click-through.
//
// Click-through design: the OS only delivers mouse events to a window that is NOT ignoring them,
// and forwarded mouse-moves are unreliable on Windows. So the main process polls the global cursor,
// sends it (window-relative) to the renderer, and the renderer reads the alpha of the pixel under
// the cursor and answers with set-interactive. The window ignores the mouse except over the avatar.
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, protocol, net, nativeImage } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const fs = require('fs')

const DEV = process.env.NOVA_DEV === '1'
const WIN_W = 420
const WIN_H = 680
const POLL_MS = 33
const DEFAULT_VRM = path.resolve(__dirname, '..', '..', 'vrm_models', 'Nova_v1_grunge.vrm')
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

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const height = Math.min(WIN_H, workArea.height) // small displays: keep the whole window on screen
  win = new BrowserWindow({
    width: WIN_W,
    height,
    x: workArea.x + workArea.width - WIN_W - 24,
    y: workArea.y + workArea.height - height,
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
    }, 6000))
  }
  win.webContents.on('did-finish-load', () => win.webContents.send('debug', debug))
  win.on('closed', () => { win = null })
}

function startCursorPolling() {
  pollTimer = setInterval(() => {
    if (!win || !win.isVisible()) return
    const c = screen.getCursorScreenPoint()
    if (drag) {
      win.setPosition(drag.origin.x + (c.x - drag.cursor.x), drag.origin.y + (c.y - drag.cursor.y))
    }
    const b = win.getBounds()
    win.webContents.send('cursor', { x: c.x - b.x, y: c.y - b.y, w: b.width, h: b.height })
  }, POLL_MS)
}

function createTray() {
  // 16x16 solid purple square, placeholder until there is a real icon.
  const icon = nativeImage.createFromBuffer(solidPng(16, 16, [150, 90, 220, 255]))
  tray = new Tray(icon)
  tray.setToolTip('Nova')
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide Nova' : 'Show Nova', click: toggleVisible },
    { label: 'Code (placeholder)...', click: openCodeWindow },
    { label: 'Debug overlay (Ctrl+Alt+D)', type: 'checkbox', checked: debug, click: (i) => setDebug(i.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))
  rebuild()
  tray.on('click', () => { toggleVisible(); rebuild() })
  tray.on('right-click', rebuild)
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

// Regular framed window for the coding agent. Placeholder page for now.
let codeWin = null
function openCodeWindow() {
  if (codeWin) { codeWin.show(); codeWin.focus(); return }
  codeWin = new BrowserWindow({
    width: 720,
    height: 640,
    title: 'Nova - Code',
    backgroundColor: '#1f2937',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  if (DEV) codeWin.loadURL('http://localhost:5174/code.html')
  else codeWin.loadFile(path.join(__dirname, '..', 'dist', 'code.html'))
  codeWin.on('closed', () => { codeWin = null })
}

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
  protocol.handle('nova-asset', (req) => {
    if (new URL(req.url).hostname !== 'avatar.vrm' || !fs.existsSync(VRM_PATH)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(VRM_PATH).toString())
  })

  createWindow()
  createTray()
  startCursorPolling()

  globalShortcut.register('Control+Alt+N', toggleVisible)
  globalShortcut.register('Control+Alt+D', () => setDebug(!debug))
})

ipcMain.on('set-interactive', (_e, on) => {
  if (!win || on === interactive) return
  interactive = on
  win.setIgnoreMouseEvents(!on)
})

ipcMain.on('drag-start', () => {
  if (!win) return
  const b = win.getBounds()
  drag = { cursor: screen.getCursorScreenPoint(), origin: { x: b.x, y: b.y } }
})
ipcMain.on('drag-end', () => { drag = null })

app.on('will-quit', () => { globalShortcut.unregisterAll(); clearInterval(pollTimer) })
app.on('window-all-closed', () => app.quit())
