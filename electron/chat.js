// The chat window: a small frameless window next to the avatar. It has no position of its own: every time it is shown, and every time the
// avatar window moves, its bounds are derived from the avatar window's bounds (placement.chatBounds), so there is ONE origin for both.
// Sandboxed and context-isolated, navigation pinned to its own page; the page talks to the desktop WebSocket itself (src/chat/).
const path = require('path')
const { pathToFileURL } = require('url')

const CONFIG_CHANNEL = 'chat-config'
const CLOSE_CHANNEL = 'chat-close'
const DRAG_CHANNEL = 'chat-drag'

// What the page needs. Speech is switched off by the page for its own connection.
function pageConfig({ wsUrl, backendSettings, avatarVisible, locked }) {
  return { wsUrl, backendSettings, avatarVisible: !!avatarVisible, locked: !!locked }
}

function allowNavigation(url, ownPrefix) {
  return String(url).startsWith(ownPrefix)
}

// deps: { ipcMain, BrowserWindow, screen, DEV, placement, getWsUrl, getBackendSettings, getOrigin() -> avatar window bounds,
//         getSide() -> 'auto'|'left'|'right', isAvatarVisible, onClosedByUser(), distDir, preload,
//         getOffset() -> {x,y} the user moved the chat window by, isLocked(), onMoved({x,y}) after a drag }
function registerChat(deps) {
  const { ipcMain, BrowserWindow, screen, DEV, placement, getWsUrl, getBackendSettings, getOrigin, getSide, isAvatarVisible, onClosedByUser, distDir, preload } = deps
  const getOffset = deps.getOffset || (() => ({ x: 0, y: 0 }))
  const isLocked = deps.isLocked || (() => false)
  const onMoved = deps.onMoved || (() => {})
  let win = null
  let dragFrom = null

  const alive = () => !!win && !win.isDestroyed()
  // Where the origin puts it, moved by whatever the user dragged it to (so it still follows the avatar), kept on screen.
  const boundsFor = (off) => {
    const b = placement.chatBounds(screen.getAllDisplays(), getOrigin(), placement.CHAT_SIZE, getSide())
    return placement.shifted(screen.getAllDisplays(), { x: b.x, y: b.y, width: b.width, height: b.height }, off)
  }
  const boundsNow = () => { const s = boundsFor(getOffset()); return { x: s.x, y: s.y, width: s.width, height: s.height } }

  ipcMain.handle(CONFIG_CHANNEL, (e) => {
    if (!alive() || e.sender !== win.webContents) return null
    return pageConfig({ wsUrl: getWsUrl(), backendSettings: getBackendSettings(), avatarVisible: isAvatarVisible(), locked: isLocked() })
  })
  // The header moves only this window: ('start') remember where it was, ('move', dx, dy) follow the pointer, ('end', dx, dy) save the spot.
  ipcMain.on(DRAG_CHANNEL, (e, phase, dx, dy) => {
    if (!alive() || e.sender !== win.webContents || isLocked()) return
    if (phase === 'start') { dragFrom = { ...getOffset() }; return }
    if (!dragFrom) return
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const s = boundsFor({ x: dragFrom.x + n(dx), y: dragFrom.y + n(dy) })
    win.setBounds({ x: s.x, y: s.y, width: s.width, height: s.height })
    if (phase === 'end') { dragFrom = null; onMoved(s.offset) }
  })
  ipcMain.on(CLOSE_CHANNEL, (e) => {
    if (!alive() || e.sender !== win.webContents) return
    close()
    if (onClosedByUser) onClosedByUser()
  })

  function open() {
    if (alive()) { follow(); win.show(); win.focus(); return win }
    win = new BrowserWindow({
      ...boundsNow(),
      frame: false, transparent: true, resizable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      title: 'Nova - Chat',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    const own = DEV ? 'http://localhost:5174/' : pathToFileURL(path.join(distDir, 'chat.html')).href.replace(/chat\.html$/, '')
    win.webContents.on('will-navigate', (ev, url) => { if (!allowNavigation(url, own)) ev.preventDefault() })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (DEV) win.loadURL('http://localhost:5174/chat.html')
    else win.loadFile(path.join(distDir, 'chat.html'))
    win.once('ready-to-show', () => { if (alive()) { win.setBounds(boundsNow()); win.show(); win.focus() } })      // bounds again: a window made on a monitor with another scale factor can come up resized
    win.on('closed', () => { win = null })
    return win
  }

  function close() { if (alive()) win.close(); win = null }
  function toggle() { if (alive()) { close(); return false } open(); return true }
  // Re-derive the bounds from the origin (the avatar moved, a display changed, the side setting changed). setBounds with the full size:
  // setPosition alone can resize a transparent window that crosses to a display with another scale factor.
  function follow() { if (alive()) win.setBounds(boundsNow()) }
  function locked(v) { if (alive() && !win.webContents.isDestroyed()) win.webContents.send('layout-locked', !!v) }
  function avatarVisible(v) { if (alive() && !win.webContents.isDestroyed()) win.webContents.send('avatar-visible', !!v) }

  return { open, close, toggle, follow, locked, avatarVisible, isOpen: alive, getWindow: () => win, boundsNow }
}

module.exports = { registerChat, pageConfig, allowNavigation, CONFIG_CHANNEL, CLOSE_CHANNEL, DRAG_CHANNEL }
