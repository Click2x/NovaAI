// Phase 6: tray sections, Home URL resolution and navigation guard, services (start script, health), settings additions, event bus.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const T = require('../electron/tray.js')
const H = require('../electron/home.js')
const V = require('../electron/services.js')
const S = require('../electron/settings.js')
import { createEvents } from '../src/net/events.js'
import { SECTIONS, getPath, patchFor } from '../src/settings/fields.js'

// ── tray sections ────────────────────────────────────────────────────────────────
const labels = (tpl) => tpl.map((i) => (i.type === 'separator' ? '---' : i.label))

test('sections are ordered, grouped by tens, and Quit comes last', () => {
  const r = T.createTrayRegistry()
  r.registerTraySection(T.SECTION.DEBUG, () => [{ label: 'debug' }])
  r.registerTraySection(T.SECTION.NOVA, () => [{ label: 'show' }, { label: 'status' }])
  r.registerTraySection(T.SECTION.NOVA + 1, () => [{ label: 'home' }])
  r.registerTraySection(T.SECTION.SERVICES, () => [{ label: 'start' }])
  r.registerTraySection(T.SECTION.VOICE, () => [{ label: 'mic' }])
  assert.deepEqual(labels(r.buildTemplate({}, { quit: () => {} })), ['show', 'status', 'home', '---', 'mic', '---', 'start', '---', 'debug', '---', 'Quit'])
})

test('the six named sections are in the documented order', () => {
  assert.deepEqual(Object.keys(T.SECTION), ['NOVA', 'VOICE', 'SCREEN', 'SERVICES', 'CODE', 'DEBUG'])
  const v = Object.values(T.SECTION)
  assert.deepEqual([...v].sort((a, b) => a - b), v)
  assert.equal(new Set(v.map((n) => Math.floor(n / 10))).size, v.length)   // each is its own group
})

test('same order keeps registration order; empty sections add no separator; ctx reaches the section', () => {
  const r = T.createTrayRegistry()
  r.registerTraySection(20, (c) => [{ label: 'b:' + c.n }])
  r.registerTraySection(20, () => [{ label: 'c' }])
  r.registerTraySection(30, () => [])
  r.registerTraySection(40, () => undefined)
  r.registerTraySection(10, () => [{ label: 'a' }])
  assert.deepEqual(labels(r.buildTemplate({ n: 7 })), ['a', '---', 'b:7', 'c'])
})

test('a throwing section is skipped and reported, the rest of the menu survives', () => {
  const r = T.createTrayRegistry()
  const seen = []
  r.registerTraySection(10, () => [{ label: 'a' }])
  r.registerTraySection(20, () => { throw new Error('boom') })
  r.registerTraySection(30, () => [{ label: 'c' }])
  assert.deepEqual(labels(r.buildTemplate({}, { onError: (e, s) => seen.push([e.message, s.order]) })), ['a', '---', 'c'])
  assert.deepEqual(seen, [['boom', 20]])
})

test('registerTraySection validates its arguments and can be undone', () => {
  const r = T.createTrayRegistry()
  assert.throws(() => r.registerTraySection('x', () => []), TypeError)
  assert.throws(() => r.registerTraySection(NaN, () => []), TypeError)
  assert.throws(() => r.registerTraySection(10, null), TypeError)
  const off = r.registerTraySection(10, () => [{ label: 'a' }])
  assert.equal(r.count(), 1)
  off()
  assert.equal(r.count(), 0)
  assert.deepEqual(r.buildTemplate({}), [])
})

test('the shared registry is the one main.js uses', () => {
  assert.equal(typeof T.registerTraySection, 'function')
  assert.equal(typeof T.buildTemplate, 'function')
})

// ── Home URL resolution ──────────────────────────────────────────────────────────
test('auto uses the backend /app page when it answers, else the dev server', async () => {
  const seen = []
  const up = async (u) => { seen.push(u); return true }
  assert.deepEqual(await H.resolveHomeUrl('auto', 'http://127.0.0.1:8000', up), { url: 'http://127.0.0.1:8000/app/', source: 'backend' })
  assert.deepEqual(seen, ['http://127.0.0.1:8000/app/'])
  assert.deepEqual(await H.resolveHomeUrl('auto', 'http://127.0.0.1:8000/', async () => false), { url: H.DEV_URL, source: 'dev-server' })
  assert.deepEqual(await H.resolveHomeUrl('AUTO', 'http://h:1', async () => { throw new Error('refused') }), { url: H.DEV_URL, source: 'dev-server' })
  assert.deepEqual(await H.resolveHomeUrl(undefined, 'http://h:1/', up), { url: 'http://h:1/app/', source: 'backend' })
})

test('an explicit address is used as is and never probed', async () => {
  let probed = false
  const r = await H.resolveHomeUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:8000', async () => { probed = true; return true })
  assert.deepEqual(r, { url: 'http://127.0.0.1:5173/', source: 'setting' })
  assert.equal(probed, false)
})

test('probe is true only for a 200 and false on errors or timeouts', async () => {
  assert.equal(await H.makeProbe(async () => ({ status: 200 }))('http://x/'), true)
  assert.equal(await H.makeProbe(async () => ({ status: 404 }))('http://x/'), false)
  assert.equal(await H.makeProbe(async () => ({ status: 307 }))('http://x/'), false)   // a redirect is not "the page"
  assert.equal(await H.makeProbe(async () => { throw new Error('ECONNREFUSED') })('http://x/'), false)
  const hang = (_u, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
  assert.equal(await H.makeProbe(hang, 30)('http://x/'), false)
})

test('panelHash only passes plain panel ids', () => {
  assert.equal(H.panelHash('memory'), '#panel=memory')
  for (const bad of ['', 'Memory', 'a b', 'x;y', '../x', 'a'.repeat(25), '1', null, undefined, 5, {}]) assert.equal(H.panelHash(bad), '', String(bad))
})

// ── navigation guard table ───────────────────────────────────────────────────────
const HOME = 'http://127.0.0.1:8000/app/'
const NAV = [
  // [url, allowed navigation, route for navigation, route for window.open]
  ['http://127.0.0.1:8000/app/', true, 'allow', 'external'],
  ['http://127.0.0.1:8000/app/#panel=notes', true, 'allow', 'external'],
  ['http://127.0.0.1:8000/api/images/1.png', true, 'allow', 'external'],        // same origin: navigation stays, a popup goes to the browser
  ['http://127.0.0.1:5173/', false, 'external', 'external'],                      // another port is another origin
  ['http://localhost:8000/app/', false, 'external', 'external'],                   // localhost is not 127.0.0.1
  ['http://127.0.0.1.evil.example/app/', false, 'external', 'external'],         // look-alike host
  ['https://127.0.0.1:8000/app/', false, 'external', 'external'],                 // other scheme, same host
  ['http://user:pw@evil.example/', false, 'external', 'external'],
  ['https://example.com/', false, 'external', 'external'],
  ['mailto:a@b.c', false, 'external', 'external'],
  ['file:///C:/Windows/System32/calc.exe', false, 'deny', 'deny'],
  ['javascript:alert(1)', false, 'deny', 'deny'],
  ['data:text/html,<script>1</script>', false, 'deny', 'deny'],
  ['about:blank', false, 'deny', 'deny'],
  ['nova-asset://avatar.vrm', false, 'deny', 'deny'],
  ['ms-settings:privacy', false, 'deny', 'deny'],
  ['not a url', false, 'deny', 'deny'],
  ['', false, 'deny', 'deny'],
  [null, false, 'deny', 'deny'],
]
for (const [url, allowed, nav, popup] of NAV) {
  test(`navigation guard: ${JSON.stringify(url)}`, () => {
    assert.equal(H.isAllowedNavigation(url, HOME), allowed)
    assert.equal(H.routeNavigation(url, HOME), nav)
    assert.equal(H.routeNavigation(url, HOME, { popup: true }), popup)
  })
}

test('the guard allows nothing when the Home URL is unknown', () => {
  assert.equal(H.isAllowedNavigation('http://127.0.0.1:8000/', null), false)
  assert.equal(H.isAllowedNavigation('http://127.0.0.1:8000/', 'junk'), false)
})

test('Home is denied every permission, the microphone included', () => {
  for (const p of ['media', 'microphone', 'audioCapture', 'notifications', 'geolocation', 'clipboard-read']) assert.equal(H.homePermission(p), false)
})

// ── Home window wiring (Electron faked) ─────────────────────────────────────────
function fakeElectron() {
  const log = { windows: [], external: [], loads: [], permission: null }
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.handlers = {}; this.once_ = {}
      this.webContents = {
        handlers: {},
        setWindowOpenHandler: (fn) => { this.openHandler = fn },
        on: (ev, fn) => { this.webContents.handlers[ev] = fn },
        loadURL: async (u) => { log.loads.push(u) },
      }
      log.windows.push(this)
    }
    once(ev, fn) { this.once_[ev] = fn }
    on(ev, fn) { this.handlers[ev] = fn }
    async loadURL(u) { log.loads.push(u) }
    isMinimized() { return false }
    show() {} focus() {}
  }
  const ses = { setPermissionRequestHandler: (fn) => { log.permission = fn }, setPermissionCheckHandler: (fn) => { log.check = fn } }
  const session = { fromPartition: (p) => { log.partition = p; return ses } }
  const shell = { openExternal: async (u) => { log.external.push(u) } }
  return { log, BrowserWindow, session, shell }
}

test('the Home window is sandboxed, isolated, on its own partition, and loads the panel hash', async () => {
  const e = fakeElectron()
  const home = H.createHome({ ...e, getSettings: () => ({ home: { url: 'http://127.0.0.1:8000/app/' } }), getBackendUrl: () => 'http://127.0.0.1:8000', version: '9.9.9' })
  const r = await home.openHome('memory')
  const w = e.log.windows[0]
  const wp = w.opts.webPreferences
  assert.equal(wp.contextIsolation, true); assert.equal(wp.sandbox, true); assert.equal(wp.nodeIntegration, false)
  assert.equal(wp.partition, H.PARTITION); assert.ok(wp.partition.startsWith('persist:'))
  assert.ok(wp.preload.endsWith('home-preload.js'))
  assert.deepEqual(wp.additionalArguments, ['--nova-version=9.9.9'])
  assert.equal(w.opts.width, 1200); assert.equal(w.opts.height, 800)
  assert.deepEqual(e.log.loads, ['http://127.0.0.1:8000/app/#panel=memory'])
  assert.equal(r.source, 'setting')
  // permissions: everything denied on that partition
  let granted = null
  e.log.permission(null, 'media', (v) => { granted = v })
  assert.equal(granted, false)
  assert.equal(e.log.check(null, 'media'), false)
})

test('Home sends other origins and popups to the browser, and blocks file: and javascript:', async () => {
  const e = fakeElectron()
  const home = H.createHome({ ...e, getSettings: () => ({ home: { url: HOME } }), getBackendUrl: () => 'http://127.0.0.1:8000' })
  await home.openHome()
  const w = e.log.windows[0]
  assert.deepEqual(w.openHandler({ url: 'https://example.com/x' }), { action: 'deny' })
  assert.deepEqual(w.openHandler({ url: 'file:///C:/x' }), { action: 'deny' })
  assert.deepEqual(w.openHandler({ url: 'http://127.0.0.1:8000/api/images/a.png' }), { action: 'deny' })
  const nav = w.webContents.handlers['will-navigate']
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true } })
  const same = ev(); nav(same, 'http://127.0.0.1:8000/app/#panel=notes'); assert.equal(same.prevented, false)
  const other = ev(); nav(other, 'https://evil.example/'); assert.equal(other.prevented, true)
  const file = ev(); nav(file, 'file:///C:/Windows/win.ini'); assert.equal(file.prevented, true)
  const js = ev(); w.webContents.handlers['will-redirect'](js, 'javascript:alert(1)'); assert.equal(js.prevented, true)
  assert.deepEqual(e.log.external, ['https://example.com/x', 'http://127.0.0.1:8000/api/images/a.png', 'https://evil.example/'])
})

test('opening Home again reuses the window and only changes the hash', async () => {
  const e = fakeElectron()
  const home = H.createHome({ ...e, getSettings: () => ({ home: { url: 'http://127.0.0.1:8000/app/#panel=notes' } }), getBackendUrl: () => 'http://127.0.0.1:8000' })
  await home.openHome()
  await home.openHome('training')
  assert.equal(e.log.windows.length, 1)
  assert.equal(e.log.loads.at(-1), 'http://127.0.0.1:8000/app/#panel=training')
})

// ── settings additions ───────────────────────────────────────────────────────────
test('new settings have defaults and sanitize', () => {
  assert.deepEqual(S.DEFAULTS.home, { url: 'auto' })
  assert.deepEqual(S.DEFAULTS.backend, { url: 'http://127.0.0.1:8000', startScript: '', controlUrl: 'http://127.0.0.1:8765' })
  assert.deepEqual(S.sanitize(S.DEFAULTS), S.DEFAULTS)
  const ok = S.sanitize({ home: { url: 'HTTP://127.0.0.1:5173/' }, backend: { url: 'http://10.0.0.5:9000/', startScript: ' D:\\n\\start.ps1 ', controlUrl: 'https://c.local/' } })
  assert.equal(ok.home.url, 'http://127.0.0.1:5173/')
  assert.equal(ok.backend.url, 'http://10.0.0.5:9000')            // trailing slash dropped
  assert.equal(ok.backend.startScript, 'D:\\n\\start.ps1')
  assert.equal(ok.backend.controlUrl, 'https://c.local')
  assert.equal(S.sanitize({ home: { url: ' auto ' } }).home.url, 'auto')
})

test('bad home/backend values keep the previous value', () => {
  const bad = S.sanitize({
    home: { url: 'file:///C:/x' },
    backend: { url: 'ftp://h', startScript: 'a\nb', controlUrl: 'http://u:p@h/' },
  })
  assert.deepEqual(bad.home, S.DEFAULTS.home)
  assert.deepEqual(bad.backend, S.DEFAULTS.backend)
  for (const v of ['javascript:alert(1)', 'data:text/html,x', 'not a url', '', 5, null, {}, 'http://' + 'a'.repeat(400)]) {
    assert.equal(S.sanitize({ home: { url: v } }).home.url, 'auto', String(v).slice(0, 20))
  }
  for (const v of ['', '   ', 'a"b', 'x\u0000y', 'a'.repeat(300), 5]) assert.equal(S.sanitize({ backend: { startScript: v } }).backend.startScript, S.DEFAULTS.backend.startScript)
  // an invalid patch does not clobber a good stored value
  const cur = S.sanitize({ backend: { url: 'http://10.0.0.5:9000' } })
  assert.equal(S.applyPatch(cur, { backend: { url: 'nope' } }).backend.url, 'http://10.0.0.5:9000')
  assert.equal(S.applyPatch(cur, { backend: { startScript: 'E:\\run.ps1' } }).backend.url, 'http://10.0.0.5:9000')   // sections merge per key
})

test('NOVA_HOME_URL and NOVA_START_SCRIPT override and lock their fields, and are not stored', () => {
  const stored = S.sanitize({ home: { url: 'auto' } })
  const r = S.effective(stored, { NOVA_HOME_URL: 'http://127.0.0.1:5999/app/', NOVA_START_SCRIPT: 'D:\\stub.ps1' })
  assert.equal(r.settings.home.url, 'http://127.0.0.1:5999/app/')
  assert.equal(r.settings.backend.startScript, 'D:\\stub.ps1')
  assert.ok(r.locked.includes('home.url') && r.locked.includes('backend.startScript'))
  assert.ok(!r.locked.includes('backend.url') && !r.locked.includes('backend.controlUrl'))
  assert.equal(stored.home.url, 'auto')
  const bad = S.effective(stored, { NOVA_HOME_URL: 'javascript:1', NOVA_START_SCRIPT: '' })
  assert.equal(bad.settings.home.url, 'auto')                 // an invalid override falls back
  assert.equal(S.effective(stored, {}).locked.length, 0)
})

test('the backend address for HTTP and WebSocket follows NOVA_BACKEND, else the setting', () => {
  const eff = S.sanitize(null)
  assert.equal(S.backendHttpUrl(eff, {}), 'http://127.0.0.1:8000')
  assert.equal(S.backendWsUrl(eff, {}), 'ws://127.0.0.1:8000/api/desktop/ws')
  assert.equal(S.backendWsUrl({ ...eff, backend: { ...eff.backend, url: 'https://n.example:9' } }, {}), 'wss://n.example:9/api/desktop/ws')
  const env = { NOVA_BACKEND: 'ws://127.0.0.1:9123/api/desktop/ws' }
  assert.equal(S.backendWsUrl(eff, env), env.NOVA_BACKEND)
  assert.equal(S.backendHttpUrl(eff, env), 'http://127.0.0.1:9123')      // a mock backend: the real one is never polled
  assert.equal(S.backendHttpUrl(eff, { NOVA_BACKEND: 'garbage' }), 'http://127.0.0.1:8000')
})

test('the new settings have panel rows, and env locks map to those rows', () => {
  const rows = SECTIONS.flatMap((s) => s.fields)
  for (const p of ['home.url', 'backend.url', 'backend.startScript', 'backend.controlUrl']) {
    const f = rows.find((r) => r.path === p)
    assert.ok(f, p)
    assert.equal(f.type, 'text')
    assert.notEqual(getPath(S.DEFAULTS, p), undefined)
    assert.equal(getPath(S.applyPatch(S.DEFAULTS, patchFor(p, getPath(S.DEFAULTS, p))), p), getPath(S.DEFAULTS, p))
  }
  const locked = S.envOverrides({ NOVA_HOME_URL: 'http://x/', NOVA_START_SCRIPT: 'y' }).locked
  for (const l of locked) assert.ok(rows.some((r) => r.path === l), l)
})

// ── services: start script ──────────────────────────────────────────────────────
test('startScript runs powershell hidden with the script, and logs to the file', () => {
  const calls = []
  const writes = []
  const fsFake = {
    existsSync: () => true, mkdirSync() {}, openSync: () => 7, writeSync: (fd, s) => writes.push([fd, s]), closeSync() {},
  }
  const child = { pid: 123, on() {}, unref() { this.unrefd = true } }
  const spawn = (cmd, args, opts) => { calls.push([cmd, args, opts]); return child }
  const r = V.startScript('C:\\scripts\\start_nova.ps1', 'C:\\logs\\start.log', { spawn, fs: fsFake, now: () => new Date('2026-10-19T10:00:00Z') })
  assert.equal(r.ok, true); assert.equal(r.pid, 123); assert.equal(child.unrefd, true)
  const [cmd, args, opts] = calls[0]
  assert.equal(cmd, 'powershell.exe')
  assert.deepEqual(args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\scripts\\start_nova.ps1'])
  assert.equal(opts.windowsHide, true); assert.ok(!opts.detached);   // detached + hidden makes powershell exit without running the script
  assert.deepEqual(opts.stdio, ['ignore', 7, 7])
  assert.match(writes[0][1], /2026-10-19T10:00:00.000Z start C:\\scripts\\start_nova.ps1/)
})

test('startScript refuses a missing script or an empty path and never spawns', () => {
  let spawned = false
  const spawn = () => { spawned = true }
  const noFile = V.startScript('C:\\nope.ps1', 'x.log', { spawn, fs: { existsSync: () => false } })
  assert.equal(noFile.ok, false); assert.match(noFile.reason, /not found/)
  assert.equal(V.startScript('', 'x.log', { spawn, fs: { existsSync: () => true } }).ok, false)
  assert.equal(V.startScript(null, 'x.log', { spawn, fs: { existsSync: () => true } }).ok, false)
  assert.equal(spawned, false)
})

test('startScript reports a log file that cannot be opened', () => {
  const r = V.startScript('a.ps1', 'x.log', { spawn() { throw new Error('no') }, fs: { existsSync: () => true, mkdirSync() { throw new Error('read-only') } } })
  assert.equal(r.ok, false); assert.match(r.reason, /cannot write/)
})

test('a harmless stub script really runs, hidden, and its output lands in the log', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-start-'))
  const marker = path.join(dir, 'ran.txt')
  const stub = path.join(dir, 'stub.ps1')
  fs.writeFileSync(stub, `Set-Content -Path '${marker}' -Value 'ran'\nWrite-Output 'stub says hi'\n`)
  const log = path.join(dir, 'logs', 'start.log')
  const r = V.startScript(stub, log, { spawn, fs })
  assert.equal(r.ok, true)
  const keepAlive = setInterval(() => {}, 50)      // the child is unref'd (it must outlive the app), so keep the test's loop running
  await new Promise((res) => r.child.on('exit', res))
  clearInterval(keepAlive)
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ran')
  const text = fs.readFileSync(log, 'utf8')
  assert.match(text, /start .*stub\.ps1/); assert.match(text, /stub says hi/); assert.match(text, /exited with code 0/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Start is offered only while the backend is offline and nothing is starting', () => {
  assert.equal(V.canStart({ online: false, starting: false }), true)
  assert.equal(V.canStart({ online: true, starting: false }), false)
  assert.equal(V.canStart({ online: false, starting: true }), false)
})

test('the Services tray section: Start disabled while online or starting, health line, control page opens the setting', () => {
  const r = T.createTrayRegistry()
  const opened = []
  let health = { online: false }
  let socketOnline = false
  const startedWith = []
  const fsFake = { existsSync: () => true, mkdirSync() {}, openSync: () => 1, writeSync() {}, closeSync() {} }
  const child = { pid: 1, on() {}, unref() {} }
  const svc = V.registerServices({
    registerTraySection: r.registerTraySection, SECTION: T.SECTION,
    spawn: (...a) => { startedWith.push(a); return child }, fs: fsFake, shell: { openExternal: async (u) => { opened.push(u) } },
    getSettings: () => ({ backend: { startScript: 'C:\\s.ps1', controlUrl: 'http://127.0.0.1:8765' } }),
    getLogFile: () => 'l.log', getHealth: () => health, isSocketOnline: () => socketOnline,
    poller: { boost() {} }, rebuildTray() {},
  })
  const items = () => r.buildTemplate({}).filter((i) => i.type !== 'separator')
  let [start, line, control] = items()
  assert.equal(start.label, 'Start Nova services'); assert.equal(start.enabled, true)
  assert.equal(line.label, 'Backend: offline'); assert.equal(line.enabled, false)
  control.click(); assert.deepEqual(opened, ['http://127.0.0.1:8765'])
  start.click()
  assert.equal(startedWith.length, 1)
  ;[start] = items(); assert.equal(start.enabled, false); assert.match(start.label, /Starting/)
  start.click(); assert.equal(startedWith.length, 1)                       // a second click does nothing while starting
  health = { online: true, status: 'healthy', services: {} }
  assert.equal(items()[1].label, 'Backend: healthy')
  assert.equal(svc.isStarting(), true)
})

test('Start is disabled when the socket says the backend is online even if /health has not answered', () => {
  const r = T.createTrayRegistry()
  V.registerServices({
    registerTraySection: r.registerTraySection, SECTION: T.SECTION, spawn() { throw new Error('must not run') }, fs: {}, shell: {},
    getSettings: () => ({ backend: {} }), getLogFile: () => 'l', getHealth: () => null, isSocketOnline: () => true, poller: {}, rebuildTray() {},
  })
  const [start, line] = r.buildTemplate({})
  assert.equal(start.enabled, false)
  assert.equal(line.label, 'Backend: checking...')
})

// ── services: health ────────────────────────────────────────────────────────────
test('healthLabel reads the /health payload of main.py', () => {
  assert.equal(V.healthLabel(null), 'Backend: checking...')
  assert.equal(V.healthLabel({ online: false }), 'Backend: offline')
  assert.equal(V.healthLabel({ online: true, status: 'healthy', services: { llm: 'ready', chromadb: 'connected', image_generation: 'disabled', graphiti: 'disabled', gpu_state: 'ok' } }), 'Backend: healthy')
  assert.equal(V.healthLabel({ online: true, status: 'degraded', services: { llm: 'not_loaded', chromadb: 'connected', graphiti: 'unreachable' } }), 'Backend: degraded (llm not_loaded, graphiti unreachable)')
  assert.equal(V.healthLabel({ online: true, status: 'degraded', services: {} }), 'Backend: degraded')
})

test('fetchHealth parses /health and reports offline on errors, bad status and timeouts', async () => {
  let asked
  const ok = await V.fetchHealth('http://h:8000/', async (u) => { asked = u; return { ok: true, json: async () => ({ status: 'healthy', services: { llm: 'ready' } }) } })
  assert.equal(asked, 'http://h:8000/health')
  assert.deepEqual(ok, { online: true, status: 'healthy', services: { llm: 'ready' } })
  assert.equal((await V.fetchHealth('http://h', async () => ({ ok: false, status: 503 }))).online, false)
  assert.equal((await V.fetchHealth('http://h', async () => { throw new Error('refused') })).reason, 'unreachable')
  assert.equal((await V.fetchHealth('http://h', async () => ({ ok: true, json: async () => { throw new Error('html') } }))).status, 'unknown')
  const hang = (_u, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))
  assert.equal((await V.fetchHealth('http://h', hang, 20)).reason, 'timeout')
})

test('the health poller reports changes only', async () => {
  const seen = []
  let answer = { ok: false, status: 500 }
  const p = V.createHealthPoller({
    getBase: () => 'http://h', fetchFn: async () => (answer.ok ? { ok: true, json: async () => ({ status: 'healthy', services: {} }) } : answer),
    onChange: (h) => seen.push(h.online), setTimer: () => 1, clearTimer() {},
  })
  await p.refresh(); await p.refresh()
  answer = { ok: true }
  await p.refresh(); await p.refresh()
  assert.deepEqual(seen, [false, true])
})

// ── event bus ───────────────────────────────────────────────────────────────────
test('events: handlers run in order per type; unknown types are ignored; unsubscribe works', () => {
  const ev = createEvents()
  const got = []
  const off = ev.on('sentence', (m) => got.push('a' + m.text))
  ev.on('sentence', (m) => got.push('b' + m.text))
  ev.on('turn_end', () => got.push('end'))
  assert.equal(ev.emit({ type: 'sentence', text: '1' }), 2)
  assert.equal(ev.emit({ type: 'nobody_listens' }), 0)
  off()
  ev.emit({ type: 'sentence', text: '2' })
  ev.emit({ type: 'turn_end' })
  assert.deepEqual(got, ['a1', 'b1', 'b2', 'end'])
})

test('events: a throwing handler does not stop the others; junk messages are ignored', () => {
  const errors = []
  const ev = createEvents({ onError: (e, m) => errors.push([e.message, m.type]) })
  const got = []
  ev.on('x', () => { throw new Error('bad') })
  ev.on('x', () => got.push('still ran'))
  assert.equal(ev.emit({ type: 'x' }), 2)
  assert.deepEqual(got, ['still ran']); assert.deepEqual(errors, [['bad', 'x']])
  for (const junk of [null, undefined, 'x', {}, { type: 5 }]) assert.equal(ev.emit(junk), 0)
  assert.throws(() => ev.on(5, () => {}), TypeError); assert.throws(() => ev.on('x', null), TypeError)
})

test('main.js no longer has the event switch and subscribes to every event it used to handle', () => {
  const src = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.ok(!/switch \(m\.type\)/.test(src))
  for (const t of ['turn_start', 'sentence', 'turn_end', 'transcript', 'tool', 'capture_request', 'state', 'proactive', 'error']) assert.ok(src.includes(`events.on('${t}'`), t)
})
