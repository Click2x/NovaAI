// The bundled backend ("sidecar"): novaai-server.exe, built by tools/build-backend.ps1 and shipped in the installer's resources.
// Unlike the tray's "Start Nova services" (services.js, the user's own start script), this starts on its own at launch, but only when
// the installer carries the exe, the backend address is this machine, no start script is set and nothing already answers there.
// Electron and node modules are injected so the logic can be tested with `node --test`.
const path = require('path')

const EXE = process.platform === 'win32' ? 'novaai-server.exe' : 'novaai-server'
const READY_TIMEOUT_MS = 90000   // a frozen Python app unpacks and imports slowly on the first start
const READY_POLL_MS = 500

// Where the exe lives: <resources>/backend/novaai-server/ when installed; backend/dist/novaai-server/ in a dev checkout after a build.
function sidecarPath({ resourcesPath, appRoot, fs }) {
  const candidates = [
    resourcesPath && path.join(resourcesPath, 'backend', 'novaai-server', EXE),
    appRoot && path.join(appRoot, 'backend', 'dist', 'novaai-server', EXE),
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || null
}

// http://127.0.0.1:8000 -> { host, port } for a loopback address, else null (a remote backend is never started from here).
function loopbackTarget(httpUrl) {
  let u
  try { u = new URL(httpUrl) } catch { return null }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/[[\]]/g, ''), port } : null
}

// deps: { exe, httpUrl, startScript, online }  -> { start: true, target } | { start: false, reason }
function decide({ exe, httpUrl, startScript, online }) {
  if (!exe) return { start: false, reason: 'no bundled backend' }
  if (startScript) return { start: false, reason: 'a start script is set' }
  if (online) return { start: false, reason: 'a backend already answers' }
  const target = loopbackTarget(httpUrl)
  if (!target) return { start: false, reason: 'backend address is not this machine' }
  return { start: true, target }
}

// Spawn the exe hidden with output appended to `logFile`. deps: { spawn, fs }. Returns { ok, child } or { ok: false, reason }.
function startSidecar(exe, target, logFile, { spawn, fs, now = () => new Date() }) {
  let fd
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fd = fs.openSync(logFile, 'a')
    fs.writeSync(fd, `\n--- ${now().toISOString()} start ${exe} --host ${target.host} --port ${target.port}\n`)
  } catch (err) { return { ok: false, reason: `cannot write ${logFile}: ${err.message}` } }
  try {
    const child = spawn(exe, ['serve', '--host', target.host, '--port', String(target.port)], { windowsHide: true, stdio: ['ignore', fd, fd], cwd: path.dirname(exe) })
    child.on('error', (err) => { try { fs.writeSync(fd, `spawn error: ${err.message}\n`) } catch {} })
    child.on('exit', (code) => { try { fs.writeSync(fd, `--- exited with code ${code}\n`); fs.closeSync(fd) } catch {} })
    return { ok: true, child }
  } catch (err) {
    try { fs.closeSync(fd) } catch {}
    return { ok: false, reason: err.message }
  }
}

// Resolve true once `check()` says online, false after `timeoutMs` or when `stopped()`. deps: { check, sleep, now }
async function waitUntilOnline({ check, stopped = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = READY_TIMEOUT_MS }) {
  const until = now() + timeoutMs
  while (now() < until && !stopped()) {
    if (await check()) return true
    await sleep(READY_POLL_MS)
  }
  return false
}

// Own the child for the life of the app. deps: { spawn, fs, check (async -> bool), logFile, smokeLog }
function createSidecar({ spawn, fs, check, logFile, smokeLog = () => {} }) {
  let child = null
  let quitting = false
  return {
    // Returns true when a backend answers (ours or not) once this settles; false when none could be started or it never came up.
    async ensure({ resourcesPath, appRoot, httpUrl, startScript }) {
      const exe = sidecarPath({ resourcesPath, appRoot, fs })
      const d = decide({ exe, httpUrl, startScript, online: await check() })
      if (!d.start) { smokeLog(`sidecar not started: ${d.reason}`); return d.reason === 'a backend already answers' }
      const r = startSidecar(exe, d.target, logFile, { spawn, fs })
      if (!r.ok) { smokeLog(`sidecar failed: ${r.reason}`); return false }
      child = r.child
      child.on('exit', () => { child = null })
      smokeLog(`sidecar started pid=${child.pid}`)
      const up = await waitUntilOnline({ check, stopped: () => quitting || !child })
      smokeLog(`sidecar ${up ? 'online' : 'did not come up'}`)
      return up
    },
    stop() {
      quitting = true
      if (child) { try { child.kill() } catch {} child = null }
    },
    running: () => !!child,
  }
}

module.exports = { sidecarPath, loopbackTarget, decide, startSidecar, waitUntilOnline, createSidecar, EXE }
