// Nova Home: a regular framed window that hosts the existing React web app (roadmap v2, D1/D2), so the screens are not rebuilt natively.
//
// The page is a web origin and is treated as less trusted than the overlay: its own session partition, no IPC (home-preload.js exposes only
// a marker), every permission denied (the overlay owns the microphone), navigation pinned to the Home origin, everything else goes to the
// user's browser. The decisions are pure functions so they are tested without Electron.
const path = require('path')

const DEV_URL = 'http://127.0.0.1:5173/'      // the Vite dev server, the fallback when the backend does not serve /app
const PARTITION = 'persist:nova-home'         // keeps the web app's localStorage (theme, workshop state) between runs
const PROBE_MS = 1500
const PANEL_RE = /^[a-z]{1,24}$/

// Protocols that may be handed to the user's own browser / mail client.
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function parseUrl(url) { try { return new URL(String(url)) } catch { return null } }

// Is `url` a page the Home window may navigate to? Only http(s) on exactly the Home origin; file:, javascript:, data:, about: and every
// other origin (including another port or a look-alike host) are refused.
function isAllowedNavigation(url, homeUrl) {
  const u = parseUrl(url)
  const h = parseUrl(homeUrl)
  if (!u || !h) return false
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return u.origin === h.origin
}

// May this URL be opened outside the app (shell.openExternal)? Never file:, javascript:, data: or app-internal schemes.
function isExternalOpenable(url) {
  const u = parseUrl(url)
  return !!u && EXTERNAL_PROTOCOLS.has(u.protocol)
}

// Where a navigation or window.open from Home goes: 'allow' (same origin, only for navigation), 'external' or 'deny'.
function routeNavigation(url, homeUrl, { popup = false } = {}) {
  if (!popup && isAllowedNavigation(url, homeUrl)) return 'allow'
  return isExternalOpenable(url) ? 'external' : 'deny'
}

// Home hosts web content: it never gets the microphone, camera, notifications or anything else.
function homePermission() { return false }

// `#panel=memory` for a panel id the web app knows how to open (frontend/src/utils/desktop.js); '' for anything else.
function panelHash(panel) {
  return typeof panel === 'string' && PANEL_RE.test(panel) ? `#panel=${panel}` : ''
}

// The URL to load. `setting` is home.url ('auto' or a URL), `backendUrl` the backend's HTTP origin, `probe(url)` -> Promise<boolean>.
async function resolveHomeUrl(setting, backendUrl, probe) {
  const wanted = String(setting || 'auto').trim()
  if (wanted.toLowerCase() !== 'auto') return { url: wanted, source: 'setting' }
  const served = String(backendUrl || '').replace(/\/+$/, '') + '/app/'
  try { if (await probe(served)) return { url: served, source: 'backend' } } catch { /* fall through */ }
  return { url: DEV_URL, source: 'dev-server' }
}

// Does the page answer with 200? `fetchFn` is fetch (injectable).
function makeProbe(fetchFn = globalThis.fetch, timeoutMs = PROBE_MS) {
  return async (url) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetchFn(url, { signal: ctl.signal, redirect: 'manual' })
      return r.status === 200
    } catch { return false } finally { clearTimeout(t) }
  }
}

// deps: { BrowserWindow, shell, session, getSettings() -> effective settings, getBackendUrl(), version, smokeLog, dev }
function createHome(deps) {
  const { BrowserWindow, shell, session, getSettings, getBackendUrl, version = 'unknown', smokeLog = () => {} } = deps
  let win = null
  let currentUrl = null
  let wiredSession = false

  function wireSession() {
    if (wiredSession) return
    wiredSession = true
    const ses = session.fromPartition(PARTITION)
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(homePermission()))
    ses.setPermissionCheckHandler(() => homePermission())
  }

  function external(url) {
    smokeLog(`home external ${url}`)
    shell.openExternal(url).catch(() => {})
  }

  function create(url) {
    wireSession()
    win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      title: 'Nova',
      backgroundColor: '#111827',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'home-preload.js'),
        additionalArguments: [`--nova-version=${version}`],
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    const wc = win.webContents
    wc.setWindowOpenHandler(({ url: target }) => {
      if (routeNavigation(target, currentUrl, { popup: true }) === 'external') external(target)
      return { action: 'deny' }
    })
    const guard = (event, target) => {
      const route = routeNavigation(target, currentUrl)
      if (route === 'allow') return
      event.preventDefault()
      if (route === 'external') external(target)
      else smokeLog(`home blocked ${String(target).slice(0, 80)}`)
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.on('will-attach-webview', (e) => e.preventDefault())
    wc.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[home]', msg) })
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => { win = null; currentUrl = null })
  }

  // Show Home (creating it if needed), optionally on a panel. Resolves to { url, source, hash }.
  async function openHome(panel) {
    const hash = panelHash(panel)
    if (win && currentUrl) {
      // Already open: same page, only the hash changes (the web app listens for hashchange).
      const base = currentUrl.replace(/#.*$/, '')
      if (hash) await win.loadURL(base + hash).catch(() => {})
      if (win.isMinimized()) win.restore()
      win.show(); win.focus()
      return { url: currentUrl, source: 'open', hash }
    }
    const eff = getSettings()
    const r = await resolveHomeUrl(eff.home.url, getBackendUrl(), makeProbe())
    currentUrl = r.url
    create(r.url)
    try { await win.loadURL(r.url + hash) } catch (err) { smokeLog(`home load failed ${err && err.message}`) }
    smokeLog(`home ${r.source} ${r.url}${hash}`)
    return { ...r, hash }
  }

  return { openHome, getWindow: () => win, isOpen: () => !!win }
}

module.exports = {
  DEV_URL, PARTITION, isAllowedNavigation, isExternalOpenable, routeNavigation, homePermission, panelHash, resolveHomeUrl, makeProbe, createHome,
}
