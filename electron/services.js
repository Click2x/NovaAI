// Backend lifecycle from the tray: start the Nova services with the user's start script, open the control page, show the backend's health.
// The app never starts anything on its own (roadmap decision 9); this runs only when the tray item is clicked. Electron is injected so the
// logic can be tested with `node --test`.
const path = require('path')

const POLL_MS = 30000          // health poll while idle
const FAST_POLL_MS = 3000      // right after a start, until the backend answers
const FAST_POLL_FOR_MS = 120000
const HEALTH_TIMEOUT_MS = 4000

// Run the start script hidden, output appended to `logFile`. Not `detached`: on Windows a detached, hidden powershell.exe exits 0 without
// running the script (measured). A Windows child is not killed when its parent exits, and unref() lets this app quit without waiting.
// deps: { spawn, fs, now }. Returns { ok, pid?, child? } or { ok: false, reason }.
function startScript(script, logFile, { spawn, fs, now = () => new Date() }) {
  if (typeof script !== 'string' || !script) return { ok: false, reason: 'no start script is set' }
  if (!fs.existsSync(script)) return { ok: false, reason: `start script not found: ${script}` }
  let fd
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fd = fs.openSync(logFile, 'a')
    fs.writeSync(fd, `\n--- ${now().toISOString()} start ${script}\n`)
  } catch (err) { return { ok: false, reason: `cannot write ${logFile}: ${err.message}` } }
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, stdio: ['ignore', fd, fd],
    })
    child.on('error', (err) => { try { fs.writeSync(fd, `spawn error: ${err.message}\n`) } catch {} })
    child.on('exit', (code) => { try { fs.writeSync(fd, `--- exited with code ${code}\n`); fs.closeSync(fd) } catch {} })
    if (child.unref) child.unref()
    return { ok: true, pid: child.pid, child }
  } catch (err) {
    try { fs.closeSync(fd) } catch {}
    return { ok: false, reason: err.message }
  }
}

// GET <base>/health -> { online, status, services } ; never throws. `status` is the backend's own word (healthy/degraded).
async function fetchHealth(base, fetchFn = globalThis.fetch, timeoutMs = HEALTH_TIMEOUT_MS) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchFn(String(base).replace(/\/+$/, '') + '/health', { signal: ctl.signal })
    if (!r.ok) return { online: false, reason: `HTTP ${r.status}` }
    const j = await r.json().catch(() => ({}))
    return { online: true, status: typeof j.status === 'string' ? j.status : 'unknown', services: j.services && typeof j.services === 'object' ? j.services : {} }
  } catch (err) {
    return { online: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'unreachable' }
  } finally { clearTimeout(t) }
}

// One line for the tray: "Backend: healthy" or "Backend: degraded (llm not_loaded)"; offline reads "Backend: offline".
function healthLabel(h) {
  if (!h) return 'Backend: checking...'
  if (!h.online) return 'Backend: offline'
  const bad = Object.entries(h.services || {})
    .filter(([k, v]) => k !== 'image_generation' && k !== 'gpu_state' && typeof v === 'string' && !['ready', 'connected', 'disabled', 'enabled'].includes(v))
    .map(([k, v]) => `${k} ${v}`)
  if (h.status === 'healthy' || (!bad.length && h.status !== 'degraded')) return 'Backend: healthy'
  return bad.length ? `Backend: degraded (${bad.slice(0, 3).join(', ')})` : 'Backend: degraded'
}

// Start is offered only when nothing is online and no start is already running.
function canStart({ online, starting }) { return !online && !starting }

// The poller: asks /health now and then, calls onChange(health) when the result changes. deps: { getBase, fetchFn, setTimer, clearTimer }
function createHealthPoller({ getBase, fetchFn, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null
  let last = null
  let fastUntil = 0
  let stopped = true

  async function poll() {
    const h = await fetchHealth(getBase(), fetchFn)
    const key = JSON.stringify([h.online, h.status, h.services])
    if (key !== last) { last = key; onChange(h) }
    return h
  }
  function schedule() {
    clearTimer(timer)
    if (stopped) return
    const fast = Date.now() < fastUntil
    timer = setTimer(async () => { await poll(); schedule() }, fast ? FAST_POLL_MS : POLL_MS)
  }
  return {
    start() { stopped = false; poll().then(schedule) },
    stop() { stopped = true; clearTimer(timer) },
    refresh: poll,
    boost() { fastUntil = Date.now() + FAST_POLL_FOR_MS; if (!stopped) { clearTimer(timer); schedule() } },
  }
}

// deps: { registerTraySection, SECTION, spawn, fs, shell, getSettings, getLocked, logFile, getHealth, isSocketOnline, poller, rebuildTray, smokeLog }
function registerServices(deps) {
  const { registerTraySection, SECTION, spawn, fs, shell, getSettings, getLogFile, getHealth, isSocketOnline, poller, rebuildTray, smokeLog = () => {} } = deps
  let starting = false

  function start() {
    if (!canStart({ online: isBackendOnline(), starting })) return { ok: false, reason: 'already running or online' }
    const r = startScript(getSettings().backend.startScript, getLogFile(), { spawn, fs })
    smokeLog(r.ok ? `services start pid=${r.pid}` : `services start failed: ${r.reason}`)
    if (!r.ok) return r
    starting = true
    r.child.on('exit', () => { starting = false; rebuildTray() })
    poller.boost()
    rebuildTray()
    return r
  }
  function isBackendOnline() { const h = getHealth(); return isSocketOnline() || !!(h && h.online) }

  registerTraySection(SECTION.SERVICES, () => {
    const online = isBackendOnline()
    return [
      { label: starting ? 'Starting Nova services...' : 'Start Nova services', enabled: canStart({ online, starting }), click: start },
      { label: healthLabel(getHealth()), enabled: false },
      { label: 'Open control page', click: () => { const u = getSettings().backend.controlUrl; smokeLog(`control page ${u}`); shell.openExternal(u).catch(() => {}) } },
    ]
  })
  return { start, isStarting: () => starting }
}

module.exports = { startScript, fetchHealth, healthLabel, canStart, createHealthPoller, registerServices, POLL_MS }
