// Manual "check for update" from a local folder (roadmap decision 15): no network, no signing, nothing is ever run or installed by the app.
// The user keeps newer installers ("Nova Setup x.y.z.exe", what `npm run dist` writes) in a folder chosen in settings (app.updateFolder).
// The tray item scans it, says whether a newer one than this build is there, and a click reveals that file in Explorer.
// Pure logic with injected fs/shell, so it is tested with `node --test`.
const path = require('path')

const INSTALLER_RE = /^Nova Setup (\d+\.\d+\.\d+)\.exe$/i

// "1.2.3" (or "v1.2.3", "1.2.3-beta") -> [1,2,3]; anything else -> null. A pre-release suffix is ignored.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v == null ? '' : v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// -1 / 0 / 1; null when either side is not a version.
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

// Scan `dir` for installers. Returns
//   { ok: true, current, found: [{version,file,path,size}] newest first, newest, newer }   or   { ok: false, reason }
// `newer` is true when the newest installer is above `current`. Files that do not match the name exactly are ignored.
function scanFolder(fs, dir, current) {
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, reason: 'no update folder is set (Settings > App)' }
  let names
  try { names = fs.readdirSync(dir) } catch (err) { return { ok: false, reason: `cannot read ${dir}: ${err && err.code ? err.code : err.message}` } }
  const found = []
  for (const name of names) {
    const m = INSTALLER_RE.exec(name)
    if (!m) continue
    const full = path.join(dir, name)
    let size = 0
    try { const st = fs.statSync(full); if (!st.isFile()) continue; size = st.size } catch { continue }
    found.push({ version: m[1], file: name, path: full, size })
  }
  found.sort((a, b) => compareVersions(b.version, a.version))
  const newest = found[0] || null
  return { ok: true, current, found, newest, newer: !!newest && compareVersions(newest.version, current) === 1 }
}

// One line for the tray.
function describe(r) {
  if (!r) return null
  if (!r.ok) return `Update check: ${r.reason}`
  if (!r.newest) return 'Update check: no installers in the folder'
  const mb = (r.newest.size / 1048576).toFixed(0)
  return r.newer ? `Update available: ${r.newest.version} (${mb} MB), you have ${r.current}` : `Up to date (${r.current}; newest in folder ${r.newest.version})`
}

// deps: { registerTraySection, SECTION, fs, shell, getSettings, getVersion, rebuildTray, log }
function registerUpdates(deps) {
  const { registerTraySection, SECTION, fs, shell, getSettings, getVersion, rebuildTray, log = () => {} } = deps
  let last = null

  function check() {
    last = scanFolder(fs, getSettings().app.updateFolder, getVersion())
    log(`update check: ${describe(last)}`)
    rebuildTray()
    return last
  }
  // Reveals the installer in Explorer (does not run it); with no newer file, opens the folder itself.
  function reveal() {
    if (last && last.ok && last.newer) { shell.showItemInFolder(last.newest.path); return }
    const dir = getSettings().app.updateFolder
    if (dir) shell.openPath(dir).catch(() => {})
  }

  registerTraySection(SECTION.NOVA + 2, () => {
    const items = [{ label: 'Check for update...', click: check }]
    const line = describe(last)
    if (line) items.push({ label: line, enabled: !!(last && last.ok), click: reveal })
    return items
  })
  return { check, reveal, last: () => last }
}

module.exports = { INSTALLER_RE, parseVersion, compareVersions, scanFolder, describe, registerUpdates }
