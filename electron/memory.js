// The "What I remember" window. The page talks to the backend's /api/memory itself; this file owns the window (sandboxed, navigation pinned)
// and the one thing a page cannot do: save a text export where the user chooses. Pure helpers are exported for tests.
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { centeredBounds } = require('./onboarding')

const CONFIG = 'memory-config'
const EXPORT = 'memory-export'
const WINDOW_SIZE = { width: 600, height: 780 }

// Same wording and grouping as src/memory/model.js exportText, repeated here because this is CommonJS and that is an ES module.
const GROUPS = [['identity', 'About you'], ['preference', 'Likes and dislikes'], ['boundary', 'Things to avoid'], ['plan', 'Plans'], ['fact', 'Other things I know']]
function exportText(facts, now = new Date()) {
  const list = Array.isArray(facts) ? facts.filter((f) => f && typeof f.text === 'string') : []
  const lines = [`What Nova remembers about you (exported ${now.toISOString().slice(0, 10)})`, '']
  for (const [id, label] of GROUPS) {
    const mine = list.filter((f) => (GROUPS.some((g) => g[0] === f.kind) ? f.kind : 'fact') === id)
    if (mine.length) lines.push(label, ...mine.map((f) => `- ${f.text}`), '')
  }
  if (lines.length === 2) lines.push('Nothing yet.', '')
  return lines.join('\n')
}
const exportName = (now = new Date()) => `nova-memory-${now.toISOString().slice(0, 10)}.txt`

const pageConfig = ({ httpBase }) => ({ httpBase: String(httpBase).replace(/\/+$/, '') })

// deps: { ipcMain, BrowserWindow, dialog, screen, DEV, getBase(), distDir, preload, fetchFn?, fsApi? }
function registerMemory(deps) {
  const { ipcMain, BrowserWindow, dialog, screen, DEV, getBase, distDir, preload, fetchFn = globalThis.fetch, fsApi = fs } = deps
  let win = null
  const alive = () => !!win && !win.isDestroyed()
  const mine = (e) => alive() && e.sender === win.webContents

  ipcMain.handle(CONFIG, (e) => (mine(e) ? pageConfig({ httpBase: getBase() }) : null))
  ipcMain.handle(EXPORT, async (e) => {
    if (!mine(e)) return { ok: false, error: 'Not allowed.' }
    let facts
    try {
      const r = await fetchFn(String(getBase()).replace(/\/+$/, '') + '/api/memory')
      if (!r.ok) return { ok: false, error: 'I could not read my memory.' }
      facts = (await r.json()).facts
    } catch { return { ok: false, error: 'I cannot reach my backend.' } }
    const pick = await dialog.showSaveDialog(win, { title: 'Export what Nova remembers', defaultPath: exportName(), filters: [{ name: 'Text', extensions: ['txt'] }] })
    if (pick.canceled || !pick.filePath) return { ok: false, canceled: true }
    try { fsApi.writeFileSync(pick.filePath, exportText(facts), 'utf8') } catch { return { ok: false, error: 'I could not save that file.' } }
    return { ok: true, name: path.basename(pick.filePath) }
  })

  function open() {
    if (alive()) { win.show(); win.focus(); return win }
    const place = () => centeredBounds(screen.getPrimaryDisplay().workArea, WINDOW_SIZE)
    win = new BrowserWindow({
      ...place(), minWidth: 380, minHeight: 460, show: false, title: 'Nova - What I remember', backgroundColor: '#14121f', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
    })
    win.setBounds(place())          // see onboarding.js: mixed-DPI monitors need the bounds applied again on the real display
    win.once('ready-to-show', () => { if (alive()) { win.setBounds(place()); win.show() } })
    const own = DEV ? 'http://localhost:5174/' : pathToFileURL(path.join(distDir, 'memory.html')).href.replace(/memory\.html$/, '')
    win.webContents.on('will-navigate', (ev, url) => { if (!String(url).startsWith(own)) ev.preventDefault() })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (DEV) win.loadURL('http://localhost:5174/memory.html')
    else win.loadFile(path.join(distDir, 'memory.html'))
    win.on('closed', () => { win = null })
    return win
  }
  return { open, close: () => { if (alive()) win.close() }, isOpen: alive, getWindow: () => win }
}

module.exports = { registerMemory, exportText, exportName, pageConfig, WINDOW_SIZE, CONFIG, EXPORT }
