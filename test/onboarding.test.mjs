// The guided setup screen: its state, its backend client, its voice queue, and the main-process side (window, avatar file check, first-run
// decision). No Electron, no backend, no audio: everything is injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initial, reduce, newInstallLines, progress, summary, readMs, orbLevel, STEPS, MAX_HISTORY } from '../src/onboarding/model.js'
import { createApi } from '../src/onboarding/api.js'
import { createSpeaker } from '../src/onboarding/speaker.js'
import { SECTIONS, getPath } from '../src/settings/fields.js'

const require = createRequire(import.meta.url)
const ob = require('../electron/onboarding.js')
const S = require('../electron/settings.js')

const tick = () => new Promise((r) => setImmediate(r))

// ── model ──
test('the steps are the backend\'s eight, in order', () => {
  assert.deepEqual(STEPS, ['welcome', 'machine', 'install', 'meet', 'voice', 'safety', 'avatar', 'done'])
  const p = progress({ step: 'meet' })
  assert.deepEqual([p.index, p.total, p.labels.length], [3, 8, 8])
  assert.equal(progress(null).index, 0)
})

test('reducer: status, lines, caption, errors, busy', () => {
  let s = initial()
  assert.equal(s.phase, 'boot')
  s = reduce(s, { type: 'status', status: { step: 'welcome' } })
  assert.equal(s.phase, 'ready')
  s = reduce(s, { type: 'her_line', text: '  Hi.  ' })
  s = reduce(s, { type: 'user_line', text: 'hello' })
  s = reduce(s, { type: 'her_line', text: '   ' })
  s = reduce(s, { type: 'user_line', text: 5 })
  assert.deepEqual(s.history, [{ who: 'nova', text: 'Hi.' }, { who: 'you', text: 'hello' }])
  s = reduce(s, { type: 'caption', text: 'Hi.', emotion: 'happy' })
  assert.deepEqual([s.caption, s.emotion], ['Hi.', 'happy'])
  s = reduce(reduce(s, { type: 'busy', busy: true }), { type: 'error', message: 'x'.repeat(999) })
  assert.equal(s.busy, false)
  assert.equal(s.error.length, 300)
  s = reduce(s, { type: 'status', status: { step: 'machine' } })
  assert.equal(s.error, '')
  assert.equal(reduce(s, { type: 'nope' }), s)
  assert.equal(reduce(s, { type: 'offline' }).phase, 'offline')
})

test('history is capped; install percent is clamped; speaking toggles without churn', () => {
  let s = initial()
  for (let i = 0; i < MAX_HISTORY + 10; i++) s = reduce(s, { type: 'user_line', text: 'm' + i })
  assert.equal(s.history.length, MAX_HISTORY)
  assert.equal(s.history.at(-1).text, 'm' + (MAX_HISTORY + 9))
  assert.equal(reduce(s, { type: 'install', install: { state: 'running', percent: 250 } }).install.percent, 100)
  assert.equal(reduce(s, { type: 'install', install: { state: 'running', percent: -3 } }).install.percent, 0)
  const sp = reduce(s, { type: 'speaking', on: true })
  assert.equal(reduce(sp, { type: 'speaking', on: true }), sp)
})

test('new install lines are only the unspoken ones', () => {
  const inst = { lines: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }
  assert.deepEqual(newInstallLines(inst, 0), { lines: inst.lines, seen: 3 })
  assert.deepEqual(newInstallLines(inst, 2), { lines: [{ text: 'c' }], seen: 3 })
  assert.deepEqual(newInstallLines(inst, 3), { lines: [], seen: 3 })
  assert.deepEqual(newInstallLines(null, 0), { lines: [], seen: 0 })
})

test('summary shows only what is really known', () => {
  assert.deepEqual(summary(null), [])
  const rows = summary({ user: { name: 'Sam', pronouns: 'they/them' }, nova: { name: 'Nova' }, persona: { humor: 0.8, directness: 0.9, warmth: 0.5, formality: 0.1, interests: ['hiking', 'jazz'], boundaries: [] } })
  assert.deepEqual(rows, [['You', 'Sam (they/them)'], ['You like', 'hiking, jazz'], ['My style', 'playful, blunt, casual']])
  assert.deepEqual(summary({ user: { name: 'A' }, nova: { name: 'Luna' }, persona: { humor: 0.5, directness: 0.5, warmth: 0.5, formality: 0.5, interests: [], boundaries: ['no work talk'] } }),
    [['You', 'A'], ['You call me', 'Luna'], ['I will not', 'no work talk']])
})

test('reading time for lines spoken without audio', () => {
  assert.equal(readMs('Hi'), 1200)
  assert.equal(readMs('x'.repeat(150)), 9900)
  assert.equal(readMs(undefined), 1200)
})

test('the orb: silent under the gate, swells with volume, never past 1, junk is silence', () => {
  assert.equal(orbLevel(0), 0)
  assert.equal(orbLevel(0.009), 0)
  assert.ok(orbLevel(0.05) > 0 && orbLevel(0.05) < 1)
  assert.ok(orbLevel(0.08) > orbLevel(0.05))
  assert.equal(orbLevel(0.5), 1)
  for (const bad of [NaN, undefined, null, -1, 'x']) assert.equal(orbLevel(bad), 0, String(bad))
})

// ── api ──
function fakeFetch(routes) {
  const calls = []
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body })
    const key = (opts.method || 'GET') + ' ' + url.replace(/^http:\/\/h/, '').split('?')[0]
    const r = routes[key]
    if (r === 'throw') throw new Error('down')
    if (!r) return { ok: false, status: 404, json: async () => ({ detail: 'no route' }), arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.json, arrayBuffer: async () => r.bytes || new ArrayBuffer(4) }
  }
  f.calls = calls
  return f
}

test('api: json calls, error mapping and offline', async () => {
  const f = fakeFetch({ 'GET /api/onboarding': { json: { step: 'welcome' } }, 'POST /api/onboarding/say': { status: 422, json: { detail: 'too long' } }, 'GET /api/system': 'throw' })
  const api = createApi('http://h/', f)
  assert.deepEqual(await api.status(), { step: 'welcome' })
  assert.deepEqual(await api.say('x'), { ok: false, status: 422, error: 'too long' })
  const off = await api.system()
  assert.deepEqual([off.ok, off.offline], [false, true])
  assert.equal((await api.reset()).ok, false)                                    // unknown route -> a clean error, not a throw
  await api.advance('yes')
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { choice: 'yes' })
  await api.setSafety('off', true, true)
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { mode: 'off', adult_confirmed: true, confirm: true })
})

test('api: speech helpers return null when the backend has no voice', async () => {
  const f = fakeFetch({ 'GET /api/tts/preview': { bytes: new Uint8Array([1, 2, 3]).buffer }, 'POST /api/stt': { json: { text: 'hello there' } } })
  const api = createApi('http://h', f)
  assert.equal((await api.tts('Hi there', 'bf_emma', 1.2)).byteLength, 3)
  assert.match(f.calls[0].url, /voice=bf_emma/)
  assert.match(f.calls[0].url, /text=Hi\+there/)
  assert.equal(await api.stt(new Int16Array([1, 2])), 'hello there')
  const none = createApi('http://h', fakeFetch({ 'GET /api/tts/preview': { status: 503, json: {} }, 'POST /api/stt': { status: 503, json: {} } }))
  assert.equal(await none.tts('x'), null)
  assert.equal(await none.stt(new Int16Array(2)), null)
  const dead = createApi('http://h', fakeFetch({ 'GET /api/tts/preview': 'throw', 'POST /api/stt': 'throw' }))
  assert.equal(await dead.tts('x'), null)
  assert.equal(await dead.stt(new Int16Array(2)), '')
})

// ── speaker ──
function rig(over = {}) {
  const log = []
  const waits = []
  const sp = createSpeaker({
    synth: async (t) => { log.push('synth ' + t); return over.noAudio ? null : new ArrayBuffer(8) },
    play: (_b, reg) => new Promise((resolve) => { log.push('play'); reg(() => { log.push('stopped'); resolve() }); setImmediate(() => { if (!over.hang) resolve() }) }),
    system: over.system === undefined ? async (t) => { log.push('system ' + t) } : over.system,
    wait: async (ms) => { waits.push(ms) },
    onLine: (l) => log.push('line ' + l.text),
    onState: (on) => log.push('state ' + on),
    isMuted: () => !!over.muted,
  })
  return { sp, log, waits }
}
const L = (...t) => t.map((text, i) => ({ id: 'l' + i, text, emotion: 'neutral' }))

test('speaker: lines are said in order, the next one is requested while the current plays, idle resolves at the end', async () => {
  const { sp, log } = rig()
  sp.say(L('one', 'two'))
  await sp.idle()
  assert.deepEqual(log, ['state true', 'synth one', 'synth two', 'line one', 'play', 'line two', 'play', 'state false'])
  assert.equal(sp.pending(), 0)
  await sp.idle()
})

test('speaker: lines added while speaking join the queue; empty and junk lines are dropped', async () => {
  const { sp, log } = rig()
  sp.say(L('a'))
  sp.say([{ text: '   ' }, null, { id: 'x' }, ...L('b')])
  await sp.idle()
  assert.deepEqual(log.filter((x) => x.startsWith('line')), ['line a', 'line b'])
})

test('speaker: no backend voice falls back to the system voice, then to reading time', async () => {
  const a = rig({ noAudio: true })
  a.sp.say(L('hello'))
  await a.sp.idle()
  assert.ok(a.log.includes('system hello') && !a.log.includes('play'))
  const b = rig({ noAudio: true, system: null })
  b.sp.say(L('hello'))
  await b.sp.idle()
  assert.deepEqual(b.waits, [1200])
})

test('speaker: muted shows the lines for their reading time and never asks for audio', async () => {
  const { sp, log, waits } = rig({ muted: true })
  sp.say(L('quiet one', 'quiet two'))
  await sp.idle()
  assert.deepEqual(log.filter((x) => x.startsWith('synth') || x === 'play'), [])
  assert.equal(waits.length, 2)
  assert.deepEqual(log.filter((x) => x.startsWith('line')), ['line quiet one', 'line quiet two'])
})

test('speaker: stop cuts the current line and drops the rest; it can speak again afterwards', async () => {
  const { sp, log } = rig({ hang: true })
  sp.say(L('first', 'second', 'third'))
  await tick(); await tick(); await tick()
  assert.ok(log.includes('line first'))
  sp.stop()
  await sp.idle()
  assert.ok(log.includes('stopped'))
  assert.ok(!log.includes('line second'))
  assert.equal(sp.pending(), 0)
  assert.equal(log.at(-1), 'state false')
  const again = rig()
  again.sp.say(L('x'))
  await again.sp.idle()
  assert.ok(again.log.includes('line x'))
})

// ── main process side ──
function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novavrm-'))
  const f = path.join(dir, name)
  fs.writeFileSync(f, bytes)
  return f
}
const glb = (n = 4096) => Buffer.concat([Buffer.from('glTF'), Buffer.alloc(n)])

test('validateVrm accepts a real-looking VRM and refuses everything else', () => {
  assert.deepEqual(Object.keys(ob.validateVrm(tmpFile('me.vrm', glb()))), ['ok', 'path', 'name'])
  assert.equal(ob.validateVrm(tmpFile('me.vrm', glb())).name, 'me.vrm')
  for (const [f, why] of [
    [tmpFile('x.exe', glb()), 'extension'], [tmpFile('x.vrm', Buffer.from('glTF')), 'tiny'], [tmpFile('x.vrm', Buffer.concat([Buffer.from('MZ90'), Buffer.alloc(4096)])), 'magic'],
    [path.join(os.tmpdir(), 'does-not-exist.vrm'), 'missing'], [os.tmpdir() + '.vrm', 'missing dir'], [undefined, 'type'], ['a'.repeat(300) + '.vrm', 'long'],
  ]) assert.equal(ob.validateVrm(f).ok, false, why)
  const big = { statSync: () => ({ isFile: () => true, size: ob.MAX_VRM_BYTES + 1 }) }
  assert.match(ob.validateVrm('big.vrm', big).error, /120 MB/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novavrm-')) + path.sep + 'folder.vrm'
  fs.mkdirSync(dir)
  assert.match(ob.validateVrm(dir).error, /not a file/)
})

test('only the Ollama download page can be opened from setup', () => {
  assert.equal(ob.allowExternal('https://ollama.com/download'), true)
  for (const u of ['https://ollama.com.evil.com/download', 'http://ollama.com/download', 'file:///c:/x', 'javascript:alert(1)', '', undefined]) assert.equal(ob.allowExternal(u), false, String(u))
})

test('first-run decision', () => {
  const fresh = { onboardingDone: false, onboardingDismissed: false }
  const up = (done) => ({ reachable: true, supported: true, done })
  assert.equal(ob.shouldAutoOpen(up(false), fresh), true)                                                        // new install, backend ready
  assert.equal(ob.shouldAutoOpen(up(true), fresh), false)                                                        // backend says it is already set up
  assert.equal(ob.shouldAutoOpen({ reachable: false, supported: false, done: false }, fresh), true)             // no backend yet: show how to start it
  assert.equal(ob.shouldAutoOpen({ reachable: true, supported: false, done: false }, fresh), false)             // an older backend without setup: leave it alone
  assert.equal(ob.shouldAutoOpen(up(false), { ...fresh, onboardingDone: true }), false)
  assert.equal(ob.shouldAutoOpen(up(false), { ...fresh, onboardingDismissed: true }), false)                    // "do this later" is respected
  assert.equal(ob.shouldAutoOpen({ reachable: false }, { ...fresh, onboardingDismissed: true }), false)
})

test('probeBackend reads the setup state and survives anything', async () => {
  const ok = async (u) => { assert.equal(u, 'http://127.0.0.1:8000/api/onboarding'); return { ok: true, json: async () => ({ step: 'meet', done: false }) } }
  assert.deepEqual(await ob.probeBackend('http://127.0.0.1:8000/', ok), { reachable: true, supported: true, done: false })
  assert.deepEqual(await ob.probeBackend('http://x', async () => ({ ok: true, json: async () => ({ step: 'done', done: true }) })), { reachable: true, supported: true, done: true })
  assert.deepEqual(await ob.probeBackend('http://x', async () => ({ ok: false, status: 404 })), { reachable: true, supported: false, done: false })
  assert.deepEqual(await ob.probeBackend('http://x', async () => ({ ok: true, json: async () => ({ hello: 1 }) })), { reachable: true, supported: false, done: false })
  assert.deepEqual(await ob.probeBackend('http://x', async () => ({ ok: true, json: async () => { throw new Error('bad json') } })), { reachable: true, supported: false, done: false })
  assert.deepEqual(await ob.probeBackend('http://x', async () => { throw new Error('refused') }), { reachable: false, supported: false, done: false })
})

function fakeElectron({ picked } = {}) {
  const handlers = {}, listeners = {}, wins = [], opened = []
  class W {
    constructor(o) { this.o = o; this.destroyed = false; this.handlers = {}; this.once_ = {}; this.boundsSet = []; this.shown = false; this.webContents = { on() {}, setWindowOpenHandler() {} }; wins.push(this) }
    setBounds(b) { this.boundsSet.push(b) }
    once(e, fn) { this.once_[e] = fn }
    loadFile(f) { this.file = f }
    loadURL(u) { this.url = u }
    on(e, fn) { this.handlers[e] = fn }
    show() { this.shown = true } focus() {}
    isDestroyed() { return this.destroyed }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed() }
  }
  return {
    wins, opened, handlers, listeners,
    ipcMain: { handle: (c, fn) => { handlers[c] = fn }, on: (c, fn) => { listeners[c] = fn } },
    BrowserWindow: W,
    dialog: { showOpenDialog: async () => picked || { canceled: true, filePaths: [] } },
    shell: { openExternal: (u) => opened.push(u) },
  }
}

function setup(over = {}) {
  const f = fakeElectron(over)
  const calls = { avatar: [], finish: 0, later: 0 }
  const api = ob.registerOnboarding({
    ...f, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1707, height: 650 } }) }, DEV: false, getBase: () => 'http://127.0.0.1:8000/', getVrmName: () => 'Nova_v1_grunge.vrm',
    setAvatar: (p) => calls.avatar.push(p), onFinish: () => { calls.finish++ }, onLater: () => { calls.later++ }, distDir: '/dist', preload: '/p.js',
  })
  return { f, api, calls }
}

test('the setup window is created once, sandboxed, and only talks to its own page', async () => {
  const { f, api } = setup()
  const w = api.open()
  assert.equal(api.open(), w)
  assert.equal(f.wins.length, 1)
  assert.deepEqual([w.o.webPreferences.sandbox, w.o.webPreferences.nodeIntegration, w.o.webPreferences.contextIsolation], [true, false, true])
  assert.deepEqual(await f.handlers['onboarding-config']({ sender: w.webContents }), { httpBase: 'http://127.0.0.1:8000', vrmName: 'Nova_v1_grunge.vrm', backend: { state: 'none', reason: '', logFile: '' } })
  assert.equal(await f.handlers['onboarding-config']({ sender: {} }), null)
  assert.equal(await f.handlers['onboarding-open-external']({ sender: {} }, 'https://ollama.com/download'), false)
  assert.equal(await f.handlers['onboarding-open-external']({ sender: w.webContents }, 'https://ollama.com/download'), true)
  assert.equal(await f.handlers['onboarding-open-external']({ sender: w.webContents }, 'https://evil.example/'), false)
  assert.deepEqual(f.opened, ['https://ollama.com/download'])
})

test('the window is shown only after its bounds are set again on the real display', () => {
  const { api } = setup()
  const w = api.open()
  assert.equal(w.o.show, false)
  const first = w.boundsSet.at(-1)
  assert.deepEqual(first, { x: 574, y: 24, width: 560, height: 602 })                       // fits the 650 px high work area, centred
  w.once_['ready-to-show']()
  assert.equal(w.boundsSet.length, 2)                                                     // right after creation, and again on ready-to-show
  assert.equal(w.shown, true)
})

test('centeredBounds: centred, never bigger than the work area, never tiny', () => {
  assert.deepEqual(ob.centeredBounds({ x: 0, y: 0, width: 1920, height: 1040 }, { width: 560, height: 800 }), { x: 680, y: 120, width: 560, height: 800 })
  assert.deepEqual(ob.centeredBounds({ x: -1707, y: -271, width: 1707, height: 640 }, { width: 560, height: 800 }), { x: -1133, y: -247, width: 560, height: 592 })
  const tiny = ob.centeredBounds({ x: 0, y: 0, width: 300, height: 380 }, { width: 560, height: 800 })
  assert.ok(tiny.width >= 320 && tiny.height >= 420)
})

test('finish and "do this later" close the window and report, but only from the page itself', () => {
  const { f, api, calls } = setup()
  const w = api.open()
  f.listeners['onboarding-finish']({ sender: {} })
  assert.deepEqual([api.isOpen(), calls.finish], [true, 0])
  f.listeners['onboarding-finish']({ sender: w.webContents })
  assert.deepEqual([api.isOpen(), calls.finish, calls.later], [false, 1, 0])
  const w2 = api.open()
  f.listeners['onboarding-later']({ sender: w2.webContents })
  assert.deepEqual([api.isOpen(), calls.later], [false, 1])
})

test('choosing an avatar validates the file first and hands it over only when it is good', async () => {
  const good = tmpFile('mine.vrm', glb())
  const a = setup({ picked: { canceled: false, filePaths: [good] } })
  const wa = a.api.open()
  assert.deepEqual(await a.f.handlers['onboarding-pick-avatar']({ sender: wa.webContents }), { ok: true, name: 'mine.vrm', path: good })
  assert.deepEqual(a.calls.avatar, [good])
  const bad = setup({ picked: { canceled: false, filePaths: [tmpFile('evil.vrm', Buffer.concat([Buffer.from('MZ90'), Buffer.alloc(4096)]))] } })
  const wb = bad.api.open()
  assert.equal((await bad.f.handlers['onboarding-pick-avatar']({ sender: wb.webContents })).ok, false)
  assert.deepEqual(bad.calls.avatar, [])
  const cancel = setup()
  const wc = cancel.api.open()
  assert.deepEqual(await cancel.f.handlers['onboarding-pick-avatar']({ sender: wc.webContents }), { ok: false, canceled: true })
  assert.equal((await cancel.f.handlers['onboarding-pick-avatar']({ sender: {} })).ok, false)
})

// ── settings ──
test('settings: onboarding flags and the custom avatar path', () => {
  assert.deepEqual([S.DEFAULTS.app.onboardingDone, S.DEFAULTS.app.onboardingDismissed, S.DEFAULTS.display.vrm], [false, false, ''])
  const got = S.sanitize({ app: { onboardingDone: true, onboardingDismissed: 'yes' }, display: { vrm: 'C:\\Users\\me\\Avatars\\Mira.VRM' } })
  assert.deepEqual([got.app.onboardingDone, got.app.onboardingDismissed, got.display.vrm], [true, false, 'C:\\Users\\me\\Avatars\\Mira.VRM'])
  for (const bad of ['evil.exe', 'a\nb.vrm', 'x"y.vrm', 'a'.repeat(300) + '.vrm', 5]) assert.equal(S.sanitize({ display: { vrm: bad } }).display.vrm, '', String(bad))
  assert.equal(S.applyPatch(S.sanitize({ display: { vrm: 'C:\\a.vrm' } }), { display: { vrm: '' } }).display.vrm, '')
  const row = SECTIONS.flatMap((s) => s.fields).find((f) => f.path === 'display.vrm')
  assert.ok(row && getPath(S.DEFAULTS, 'display.vrm') === '')
})

test('pageConfig carries the bundled backend status, cleaned', async () => {
  const { pageConfig } = (await import('node:module')).createRequire(import.meta.url)('../electron/onboarding.js')
  assert.deepEqual(pageConfig({ httpBase: 'http://127.0.0.1:8000/' }).backend, { state: 'none', reason: '', logFile: '' })
  const c = pageConfig({ httpBase: 'http://x/', backend: { state: 'failed', reason: 'exit code 3', logFile: 'C:\l.log' } })
  assert.deepEqual(c.backend, { state: 'failed', reason: 'exit code 3', logFile: 'C:\l.log' })
  assert.equal(pageConfig({ httpBase: 'x', backend: { state: 'bogus' } }).backend.state, 'none')
})

test('the offline action keeps the backend status it is given', () => {
  const s = reduce(initial(), { type: 'offline', backend: { state: 'failed', reason: 'r', logFile: 'l' } })
  assert.equal(s.backend.state, 'failed')
  assert.equal(reduce(s, { type: 'offline' }).backend.state, 'failed')
})
