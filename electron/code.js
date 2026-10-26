// Phase 13: the Code window - the desktop client of the backend agent (WS /api/agent/ws, protocol v1).
// This file owns the window, its IPC and the two backend calls the page cannot make itself. The page (src/code/) talks to the agent
// WebSocket directly. Sandboxed, context-isolated, navigation pinned to the app's own page; no Node in the page.
const fs = require('fs')
const path = require('path')

const CONFIG_CHANNEL = 'code-config'
const PICK_CHANNEL = 'code-pick-folder'
const SET_WS_CHANNEL = 'code-set-workspace'

const trimSlash = (s) => String(s).replace(/\/+$/, '')

function agentWsUrl(httpBase) {
  return trimSlash(httpBase).replace(/^http/, 'ws') + '/api/agent/ws'
}

// PUT /api/agent/config {workspace}: the backend validates the folder (a drive root, the home folder or the Nova repo are refused) and
// writes it to ~/.nova/settings.json. Returns { ok, workspace } or { ok:false, error }; never throws.
async function setWorkspaceOnBackend(httpBase, workspace, fetchFn = globalThis.fetch, timeoutMs = 5000) {
  if (typeof workspace !== 'string' || !workspace.trim() || workspace.length > 260) return { ok: false, error: 'Not a folder path.' }
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchFn(trimSlash(httpBase) + '/api/agent/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: workspace.trim() }), signal: ctl.signal,
    })
    let body = null
    try { body = await r.json() } catch { /* not JSON */ }
    if (r.ok && body && typeof body.workspace === 'string') return { ok: true, workspace: body.workspace }
    const detail = body && typeof body.detail === 'string' ? body.detail : `the backend answered ${r.status}`
    return { ok: false, error: detail.slice(0, 300) }
  } catch {
    return { ok: false, error: 'Could not reach the backend.' }
  } finally { clearTimeout(t) }
}

// What the page needs, from the effective settings. `smoke` is the test-hook script text (NOVA_SMOKE_CODE_JS), empty in normal use.
function pageConfig({ httpBase, eff, smoke = '' }) {
  return { wsUrl: agentWsUrl(httpBase), defaultMode: eff.agent.defaultMode, workspace: eff.agent.workspace || '', smoke }
}

// A navigation inside the Code window is only allowed to its own page (the built file, or the dev server in dev).
function allowNavigation(url, ownPrefixes) {
  return ownPrefixes.some((p) => String(url).startsWith(p))
}

// deps: { ipcMain, BrowserWindow, dialog, shell, DEV, getBase, getEff, saveWorkspace(path), distDir, preload, fetchFn?, env? }
function registerCode(deps) {
  const { ipcMain, BrowserWindow, dialog, DEV, getBase, getEff, saveWorkspace, distDir, preload, fetchFn, env = process.env } = deps
  let win = null

  ipcMain.handle(CONFIG_CHANNEL, () => {
    let smoke = ''
    if (env.NOVA_SMOKE_CODE_JS) { try { smoke = fs.readFileSync(env.NOVA_SMOKE_CODE_JS, 'utf8') } catch { /* no script */ } }
    return pageConfig({ httpBase: getBase(), eff: getEff(), smoke })
  })
  ipcMain.handle(PICK_CHANNEL, async (e) => {
    if (!win || e.sender !== win.webContents) return null
    const r = await dialog.showOpenDialog(win, { title: 'Choose the agent workspace', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
  ipcMain.handle(SET_WS_CHANNEL, async (e, folder) => {
    if (!win || e.sender !== win.webContents) return { ok: false, error: 'Not allowed.' }
    const res = await setWorkspaceOnBackend(getBase(), folder, fetchFn)
    if (res.ok) { try { saveWorkspace(res.workspace) } catch { /* the backend has it; the setting is a convenience */ } }
    return res
  })

  function open() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return win }
    win = new BrowserWindow({
      width: 1100, height: 760, minWidth: 640, minHeight: 420, title: 'Nova - Code', backgroundColor: '#111827', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
    })
    const own = DEV ? ['http://localhost:5174/'] : [require('url').pathToFileURL(path.join(distDir, 'code.html')).href.replace(/code\.html$/, '')]
    win.webContents.on('will-navigate', (ev, url) => { if (!allowNavigation(url, own)) ev.preventDefault() })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (DEV) win.loadURL('http://localhost:5174/code.html')
    else win.loadFile(path.join(distDir, 'code.html'))
    win.on('closed', () => { win = null })
    if (env.NOVA_SMOKE_CODE) {
      if (env.NOVA_SMOKE_CODE_JS) {            // run the driver once a session has started (the page exposes window.__novaCodeSmoke only when it was given the script)
        const script = fs.readFileSync(env.NOVA_SMOKE_CODE_JS, 'utf8')
        const t0 = Date.now()
        const poll = setInterval(async () => {
          try {
            if (!win || Date.now() - t0 > 20000) return clearInterval(poll)
            if (await win.webContents.executeJavaScript('!!(window.__novaCodeSmoke && window.__novaCodeSmoke.ready())')) {
              clearInterval(poll)
              win.webContents.executeJavaScript('(function (handlers, view) {' + script + '\n})(window.__novaCodeSmoke.handlers, window.__novaCodeSmoke.view)')
            }
          } catch { /* the window is going away */ }
        }, 200)
      }
      setTimeout(async () => {
        try {
          if (env.NOVA_SMOKE_LOG) fs.appendFileSync(env.NOVA_SMOKE_LOG, 'code smoke result ' + (await win.webContents.executeJavaScript('JSON.stringify(window.__smoke || null)')) + '\n')
          fs.writeFileSync(env.NOVA_SMOKE_CODE, (await win.webContents.capturePage()).toPNG()); console.log('[smoke] code window saved', env.NOVA_SMOKE_CODE)
        } catch (err) { console.error('[smoke]', err) }
        if (env.NOVA_SMOKE_CODE_QUIT !== '0') require('electron').app.quit()
      }, Number(env.NOVA_SMOKE_CODE_DELAY) || 3000)
    }
    return win
  }
  return { open, window: () => win }
}

module.exports = { agentWsUrl, setWorkspaceOnBackend, pageConfig, allowNavigation, registerCode, CONFIG_CHANNEL, PICK_CHANNEL, SET_WS_CHANNEL }
