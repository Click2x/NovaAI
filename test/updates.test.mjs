import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const U = require('../electron/updates')
const V = require('../electron/version')
const S = require('../electron/settings')
const { createTrayRegistry, SECTION } = require('../electron/tray')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// ── version compare ─────────────────────────────────────────────────────────────
test('parseVersion accepts x.y.z with an optional v and suffix, nothing else', () => {
  assert.deepEqual(U.parseVersion('1.2.3'), [1, 2, 3])
  assert.deepEqual(U.parseVersion(' v0.10.0-beta.1 '), [0, 10, 0])
  for (const bad of ['1.2', '1.2.3.4', 'a.b.c', '', null, undefined, 7]) assert.equal(U.parseVersion(bad), null, String(bad))
})

test('compareVersions orders numerically, not as text', () => {
  assert.equal(U.compareVersions('0.10.0', '0.9.0'), 1)
  assert.equal(U.compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(U.compareVersions('0.0.1', '0.1.0'), -1)
  assert.equal(U.compareVersions('2.0.0', '1.99.99'), 1)
  assert.equal(U.compareVersions('x', '1.0.0'), null)
})

// ── folder scan ─────────────────────────────────────────────────────────────────
function folderWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-upd-'))
  for (const [name, size] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size))
  return dir
}

test('scanFolder finds the newest installer and says whether it is newer than this build', () => {
  const dir = folderWith({ 'Nova Setup 0.1.0.exe': 10, 'Nova Setup 0.10.0.exe': 30, 'Nova Setup 0.9.2.exe': 20, 'Nova Setup 0.9.2.exe.blockmap': 5, 'notes.txt': 1, 'Nova Setup 1.0.exe': 1, 'Other Setup 5.0.0.exe': 1 })
  fs.mkdirSync(path.join(dir, 'Nova Setup 9.9.9.exe'))   // a directory with the right name is not an installer
  try {
    const r = U.scanFolder(fs, dir, '0.1.0')
    assert.equal(r.ok, true)
    assert.deepEqual(r.found.map((f) => f.version), ['0.10.0', '0.9.2', '0.1.0'])
    assert.equal(r.newest.version, '0.10.0')
    assert.equal(r.newest.size, 30)
    assert.equal(r.newest.path, path.join(dir, 'Nova Setup 0.10.0.exe'))
    assert.equal(r.newer, true)
    assert.equal(U.scanFolder(fs, dir, '0.10.0').newer, false)   // same version: not an update
    assert.equal(U.scanFolder(fs, dir, '1.0.0').newer, false)    // older files only
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('scanFolder reports an unset, missing or empty folder without throwing', () => {
  assert.equal(U.scanFolder(fs, '', '0.1.0').ok, false)
  assert.equal(U.scanFolder(fs, undefined, '0.1.0').ok, false)
  const gone = U.scanFolder(fs, path.join(os.tmpdir(), 'nova-no-such-folder-xyz'), '0.1.0')
  assert.equal(gone.ok, false)
  assert.match(gone.reason, /cannot read/)
  const dir = folderWith({ 'readme.txt': 1 })
  try {
    const r = U.scanFolder(fs, dir, '0.1.0')
    assert.deepEqual([r.ok, r.newest, r.newer], [true, null, false])
    assert.match(U.describe(r), /no installers/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('describe words each outcome', () => {
  assert.equal(U.describe(null), null)
  assert.match(U.describe({ ok: true, current: '0.1.0', newer: true, newest: { version: '0.2.0', size: 3 * 1048576 } }), /Update available: 0\.2\.0 \(3 MB\), you have 0\.1\.0/)
  assert.match(U.describe({ ok: true, current: '0.2.0', newer: false, newest: { version: '0.2.0', size: 1 } }), /Up to date/)
})

test('tray: check scans the setting, shows the line, a click reveals the installer (never runs it)', () => {
  const dir = folderWith({ 'Nova Setup 0.2.0.exe': 4 })
  try {
    const reg = createTrayRegistry()
    const calls = []
    const shell = { showItemInFolder: (p) => calls.push(['show', p]), openPath: (p) => { calls.push(['open', p]); return Promise.resolve('') } }
    let rebuilt = 0
    const u = U.registerUpdates({ registerTraySection: reg.registerTraySection, SECTION, fs, shell, getSettings: () => ({ app: { updateFolder: dir } }), getVersion: () => '0.1.0', rebuildTray: () => rebuilt++ })
    let items = reg.buildTemplate({})
    assert.deepEqual(items.map((i) => i.label), ['Check for update...'])
    items[0].click()
    assert.equal(rebuilt, 1)
    items = reg.buildTemplate({})
    assert.match(items[1].label, /Update available: 0\.2\.0/)
    items[1].click()
    assert.deepEqual(calls, [['show', path.join(dir, 'Nova Setup 0.2.0.exe')]])
    u.check()
    assert.equal(Object.keys(shell).length, 2)   // only reveal/open exist: nothing can launch the installer
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('tray: with nothing newer a click opens the folder; with no folder set the line explains and is disabled', () => {
  const dir = folderWith({ 'Nova Setup 0.1.0.exe': 4 })
  try {
    const reg = createTrayRegistry()
    const calls = []
    let folder = dir
    U.registerUpdates({ registerTraySection: reg.registerTraySection, SECTION, fs, shell: { showItemInFolder: () => calls.push('show'), openPath: (p) => { calls.push(['open', p]); return Promise.resolve('') } },
      getSettings: () => ({ app: { updateFolder: folder } }), getVersion: () => '0.1.0', rebuildTray: () => {} })
    reg.buildTemplate({})[0].click()
    const line = reg.buildTemplate({})[1]
    assert.match(line.label, /Up to date/)
    line.click()
    assert.deepEqual(calls, [['open', dir]])
    folder = ''
    reg.buildTemplate({})[0].click()
    const none = reg.buildTemplate({})[1]
    assert.match(none.label, /no update folder/)
    assert.equal(none.enabled, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ── settings ────────────────────────────────────────────────────────────────────
test('app.updateFolder: default empty, sanitized, can be cleared, survives a patch of another app field', () => {
  assert.equal(S.DEFAULTS.app.updateFolder, '')
  assert.equal(S.sanitize({ app: { updateFolder: '  D:\\Nova\\installers  ' } }).app.updateFolder, 'D:\\Nova\\installers')
  assert.equal(S.sanitize({ app: { updateFolder: 5 } }).app.updateFolder, '')
  assert.equal(S.sanitize({ app: { updateFolder: 'x'.repeat(300) } }).app.updateFolder, '')
  assert.equal(S.sanitize({ app: { updateFolder: 'a"b' } }).app.updateFolder, '')
  assert.equal(S.sanitize({ app: { updateFolder: 'a\nb' } }).app.updateFolder, '')
  const set = S.applyPatch(S.DEFAULTS, { app: { updateFolder: 'E:\\up' } })
  assert.equal(S.applyPatch(set, { app: { autostart: true } }).app.updateFolder, 'E:\\up')
  assert.equal(S.applyPatch(set, { app: { updateFolder: '' } }).app.updateFolder, '')   // empty clears it
  assert.equal(S.applyPatch(set, { app: { updateFolder: 'a"b' } }).app.updateFolder, 'E:\\up')   // invalid keeps the old one
})

test('the settings panel has a row for the update folder', async () => {
  const { SECTIONS } = await import('../src/settings/fields.js')
  const f = SECTIONS.flatMap((s) => s.fields).find((x) => x.path === 'app.updateFolder')
  assert.ok(f && f.type === 'text')
})

// ── version handshake ───────────────────────────────────────────────────────────
test('compat: 0.x minor and 1.x+ major must match, an unreadable backend version is unknown', () => {
  assert.equal(V.compat('0.1.0', '0.1.7').state, 'ok')
  assert.equal(V.compat('0.1.0', '0.2.0').state, 'mismatch')
  assert.equal(V.compat('1.2.0', '1.9.0').state, 'ok')
  assert.equal(V.compat('1.2.0', '2.0.0').state, 'mismatch')
  assert.equal(V.compat('0.1.0', undefined).state, 'unknown')
  assert.equal(V.compat('0.1.0', 'dev').state, 'unknown')
  assert.match(V.compat('0.1.0', '0.2.0').text, /version mismatch: app 0\.1\.0, backend 0\.2\.0/)
})

test('handshake: a mismatch is logged once, shown in the tray and tooltip; a match shows nothing', () => {
  const reg = createTrayRegistry()
  const log = []
  let rebuilt = 0
  const h = V.registerVersionHandshake({ registerTraySection: reg.registerTraySection, SECTION, getAppVersion: () => '0.1.0', rebuildTray: () => rebuilt++, log: (l) => log.push(l) })
  assert.deepEqual(reg.buildTemplate({}), [])
  assert.equal(h.tooltipSuffix(), '')
  h.setBackendVersion('0.1.4')
  assert.deepEqual(reg.buildTemplate({}), [])
  assert.equal(h.tooltipSuffix(), '')
  h.setBackendVersion('0.3.0')
  h.setBackendVersion('0.3.0')
  assert.deepEqual(reg.buildTemplate({}).map((i) => i.label), ['version mismatch: app 0.1.0, backend 0.3.0'])
  assert.equal(h.tooltipSuffix(), ' - version mismatch: app 0.1.0, backend 0.3.0')
  assert.equal(log.filter((l) => /mismatch/.test(l)).length, 1)   // the repeated identical report is not logged again
  assert.equal(rebuilt, 3)
  h.setBackendVersion({ evil: 1 })                                 // junk from the wire is treated as unknown
  assert.equal(h.state().state, 'unknown')
  assert.deepEqual(reg.buildTemplate({}), [])
})

test('the app version is a version the handshake can read, and the tray sections sit in the Nova group', () => {
  assert.ok(U.parseVersion(pkg.version))
  assert.equal(Math.floor((SECTION.NOVA + 2) / 10), Math.floor(SECTION.NOVA / 10))
})

// ── packaging ───────────────────────────────────────────────────────────────────
test('the icon is wired: files exist, electron-builder points at it, it ships in the package, the tray loads it', () => {
  for (const f of ['build/icon.png', 'build/icon.ico']) assert.ok(fs.existsSync(path.join(root, f)), f)
  const png = fs.readFileSync(path.join(root, 'build', 'icon.png'))
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(png.readUInt32BE(16), 256)
  const ico = fs.readFileSync(path.join(root, 'build', 'icon.ico'))
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1])        // ICO header, type icon
  assert.ok(ico.readUInt16LE(4) >= 4)                                           // several sizes
  assert.equal(pkg.build.win.icon, 'build/icon.ico')
  assert.ok(pkg.build.files.includes('build/icon.png'))
  assert.match(fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8'), /'build', 'icon\.png'/)
})

test('make-icon is deterministic and the ICO directory matches its frames', () => {
  const { render, encodePng, encodeIco } = require('../tools/make-icon')
  const a = encodePng(32, 32, render(32)), b = encodePng(32, 32, render(32))
  assert.ok(a.equals(b))
  const ico = encodeIco([{ size: 16, png: encodePng(16, 16, render(16)) }, { size: 256, png: Buffer.from('x') }])
  assert.equal(ico.readUInt16LE(4), 2)
  assert.equal(ico[6], 16)
  assert.equal(ico[6 + 16], 0)                                                  // 0 means 256
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32)                                // first frame starts after the directory
})
