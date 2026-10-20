// Version handshake: the backend reports its version in hello_ack (backend_version); the app compares it with its own. A mismatch is logged
// and shown in the tray tooltip and menu. It never blocks anything: the wire protocol has its own number, this only flags a stale install.
// 0.x versions treat the minor number as breaking, so 0.1.x and 0.2.x differ; from 1.0 on only the major number does.
const { parseVersion } = require('./updates')

// -> { state: 'ok' | 'mismatch' | 'unknown', text }
function compat(appVersion, backendVersion) {
  const a = parseVersion(appVersion), b = parseVersion(backendVersion)
  if (!b) return { state: 'unknown', text: 'backend version unknown' }
  if (!a) return { state: 'unknown', text: `app version ${appVersion} unreadable` }
  const same = a[0] === b[0] && (a[0] > 0 || a[1] === b[1])
  return same
    ? { state: 'ok', text: `app ${appVersion}, backend ${backendVersion}` }
    : { state: 'mismatch', text: `version mismatch: app ${appVersion}, backend ${backendVersion}` }
}

// deps: { registerTraySection, SECTION, getAppVersion, rebuildTray, log }
function registerVersionHandshake(deps) {
  const { registerTraySection, SECTION, getAppVersion, rebuildTray, log = () => {} } = deps
  let backend = null
  let last = { state: 'unknown', text: '' }

  function setBackendVersion(v) {
    backend = typeof v === 'string' && v.length <= 40 ? v : null
    const before = last
    last = compat(getAppVersion(), backend)
    if (before.text !== last.text) log(`version handshake: ${last.text}`)
    rebuildTray()
    return last
  }
  registerTraySection(SECTION.NOVA + 3, () => (last.state === 'mismatch' ? [{ label: last.text, enabled: false }] : []))
  return { setBackendVersion, state: () => last, tooltipSuffix: () => (last.state === 'mismatch' ? ` - ${last.text}` : '') }
}

module.exports = { compat, registerVersionHandshake }
