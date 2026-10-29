import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(import.meta.url)
const sc = require('../electron/sidecar.js')

const fsWith = (files) => ({ existsSync: (p) => files.includes(p), mkdirSync() {}, openSync: () => 7, writeSync() {}, closeSync() {} })

test('sidecarPath prefers the installed resources, then the dev build, else null', () => {
  const inst = path.join('R', 'backend', 'novaai-server', sc.EXE)
  const dev = path.join('A', 'backend', 'dist', 'novaai-server', sc.EXE)
  assert.equal(sc.sidecarPath({ resourcesPath: 'R', appRoot: 'A', fs: fsWith([inst, dev]) }), inst)
  assert.equal(sc.sidecarPath({ resourcesPath: 'R', appRoot: 'A', fs: fsWith([dev]) }), dev)
  assert.equal(sc.sidecarPath({ resourcesPath: 'R', appRoot: 'A', fs: fsWith([]) }), null)
  assert.equal(sc.sidecarPath({ fs: fsWith([]) }), null)
})

test('loopbackTarget accepts only this machine', () => {
  assert.deepEqual(sc.loopbackTarget('http://127.0.0.1:8000'), { host: '127.0.0.1', port: 8000 })
  assert.deepEqual(sc.loopbackTarget('http://localhost:9000/'), { host: '127.0.0.1', port: 9000 })
  assert.deepEqual(sc.loopbackTarget('http://[::1]:8001'), { host: '::1', port: 8001 })
  assert.equal(sc.loopbackTarget('http://192.168.1.5:8000'), null)
  assert.equal(sc.loopbackTarget('https://example.com'), null)
  assert.equal(sc.loopbackTarget('not a url'), null)
})

test('decide starts only with an exe, no start script, nothing online and a local address', () => {
  const ok = { exe: 'x', httpUrl: 'http://127.0.0.1:8000', startScript: '', online: false }
  assert.equal(sc.decide(ok).start, true)
  assert.equal(sc.decide({ ...ok, exe: null }).start, false)
  assert.equal(sc.decide({ ...ok, startScript: 'a.ps1' }).start, false)
  assert.equal(sc.decide({ ...ok, online: true }).start, false)
  assert.equal(sc.decide({ ...ok, httpUrl: 'http://10.0.0.2:8000' }).start, false)
})

test('startSidecar runs "serve" on the target port and reports a spawn that throws', () => {
  let call
  const child = { on() {}, pid: 5 }
  const r = sc.startSidecar('C:\\x\\novaai-server.exe', { host: '127.0.0.1', port: 8000 }, 'log', { fs: fsWith([]), spawn: (...a) => { call = a; return child } })
  assert.equal(r.ok, true)
  assert.deepEqual(call[1], ['serve', '--host', '127.0.0.1', '--port', '8000'])
  const bad = sc.startSidecar('x', { host: 'h', port: 1 }, 'log', { fs: fsWith([]), spawn: () => { throw new Error('nope') } })
  assert.deepEqual(bad, { ok: false, reason: 'nope' })
})

test('waitUntilOnline returns true when it answers and false on timeout or stop', async () => {
  let t = 0
  const base = { sleep: async (ms) => { t += ms }, now: () => t, timeoutMs: 2000 }
  let n = 0
  assert.equal(await sc.waitUntilOnline({ ...base, check: async () => ++n >= 3 }), true)
  assert.equal(await sc.waitUntilOnline({ ...base, check: async () => false }), false)
  assert.equal(await sc.waitUntilOnline({ ...base, check: async () => false, stopped: () => true }), false)
})

test('createSidecar leaves a running backend alone, starts a missing one and kills it on stop', async () => {
  const exe = path.join('R', 'backend', 'novaai-server', sc.EXE)
  const opts = { resourcesPath: 'R', appRoot: 'A', httpUrl: 'http://127.0.0.1:8000', startScript: '' }
  let spawned = 0
  const mk = (online) => {
    let up = online
    const child = { pid: 9, killed: false, on() {}, kill() { this.killed = true } }
    const s = sc.createSidecar({ fs: fsWith([exe]), spawn: () => { spawned++; up = true; return child }, check: async () => up, logFile: 'log', isFree: async () => true })
    return { s, child }
  }
  const a = mk(true)
  assert.equal(await a.s.ensure(opts), true)
  assert.equal(spawned, 0)
  const b = mk(false)
  assert.equal(await b.s.ensure(opts), true)
  assert.equal(spawned, 1)
  assert.equal(b.s.running(), true)
  b.s.stop()
  assert.equal(b.child.killed, true)
  assert.equal(b.s.running(), false)
})

test('pickPort takes the preferred port, else the next free one, else null', async () => {
  assert.equal(await sc.pickPort('h', 8000, { isFree: async () => true }), 8000)
  assert.equal(await sc.pickPort('h', 8000, { isFree: async (_h, p) => p >= 8003 }), 8003)
  assert.equal(await sc.pickPort('h', 8000, { isFree: async () => false, tries: 5 }), null)
  assert.equal(sc.httpUrlFor({ host: '::1', port: 8001 }), 'http://[::1]:8001')
})

test('a busy port moves the sidecar to a free one and tells the app', async () => {
  const exe = path.join('R', 'backend', 'novaai-server', sc.EXE)
  let call, moved
  let up = false
  const child = { pid: 1, on() {}, kill() {} }
  const s = sc.createSidecar({
    fs: fsWith([exe]), check: async () => up, logFile: 'log', onRelocate: (u) => { moved = u },
    isFree: async (_h, p) => p !== 8000, spawn: (...a) => { call = a; up = true; return child },
  })
  assert.equal(await s.ensure({ resourcesPath: 'R', httpUrl: 'http://127.0.0.1:8000', startScript: '' }), true)
  assert.equal(moved, 'http://127.0.0.1:8001')
  assert.deepEqual(call[1], ['serve', '--host', '127.0.0.1', '--port', '8001'])
  assert.equal(s.status().state, 'online')
})

test('status explains a sidecar that exits at once, never answers, or has no free port', async () => {
  const exe = path.join('R', 'backend', 'novaai-server', sc.EXE)
  const opts = { resourcesPath: 'R', httpUrl: 'http://127.0.0.1:8000', startScript: '' }
  // exits straight away
  let onExit
  const dying = { pid: 2, on: (ev, f) => { if (ev === 'exit') onExit = f }, kill() {} }
  const a = sc.createSidecar({ fs: fsWith([exe]), check: async () => false, logFile: 'L', isFree: async () => true, spawn: () => { setTimeout(() => onExit(3), 0); return dying } })
  assert.equal(await a.ensure(opts), false)
  assert.equal(a.status().state, 'failed')
  assert.match(a.status().reason, /exit code 3/)
  assert.equal(a.status().logFile, 'L')
  // no free port anywhere
  const b = sc.createSidecar({ fs: fsWith([exe]), check: async () => false, logFile: 'L', isFree: async () => false, spawn: () => assert.fail('must not spawn') })
  assert.equal(await b.ensure(opts), false)
  assert.match(b.status().reason, /no free port/)
  // nothing bundled: stays "none"
  const c = sc.createSidecar({ fs: fsWith([]), check: async () => false, logFile: 'L', spawn: () => assert.fail('must not spawn') })
  assert.equal(await c.ensure(opts), false)
  assert.equal(c.status().state, 'none')
})
