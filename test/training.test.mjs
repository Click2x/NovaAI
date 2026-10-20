// Phase 11: tray "Review N training pairs" entry - count parsing, fetch, tray section, click, refresh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const TR = require('../electron/training.js')
const T = require('../electron/tray.js')

const json = (body, ok = true) => async () => ({ ok, json: async () => body })

function setup({ fetchFn = json({ pending: 3 }), t0 = 1_000_000 } = {}) {
  const reg = T.createTrayRegistry()
  const calls = { home: [], rebuild: 0, urls: [] }
  let clock = t0
  const timers = []
  const api = TR.registerTraining({
    registerTraySection: reg.registerTraySection,
    getBase: () => 'http://127.0.0.1:9999/',
    openHome: (p) => calls.home.push(p),
    rebuildTray: () => { calls.rebuild++ },
    fetchFn: async (url, o) => { calls.urls.push(url); return fetchFn(url, o) },
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
  })
  return { reg, calls, api, timers, tick: (ms) => { clock += ms } }
}

test('label is singular and plural', () => {
  assert.equal(TR.label(1), 'Review 1 training pair...')
  assert.equal(TR.label(12), 'Review 12 training pairs...')
})

test('parseCount accepts only non-negative integers', () => {
  assert.equal(TR.parseCount({ pending: 0 }), 0)
  assert.equal(TR.parseCount({ pending: 7 }), 7)
  for (const bad of [null, undefined, 'x', {}, { pending: -1 }, { pending: 1.5 }, { pending: '3' }, { pending: null }]) assert.equal(TR.parseCount(bad), null)
})

test('fetchPending hits the loopback endpoint, trims the base, and maps failures to null', async () => {
  const urls = []
  const ok = async (u) => { urls.push(u); return { ok: true, json: async () => ({ pending: 4 }) } }
  assert.equal(await TR.fetchPending('http://127.0.0.1:8000///', ok), 4)
  assert.deepEqual(urls, ['http://127.0.0.1:8000/api/training/pending-count'])
  assert.equal(await TR.fetchPending('http://x', json({ pending: 4 }, false)), null)
  assert.equal(await TR.fetchPending('http://x', async () => { throw new Error('down') }), null)
  assert.equal(await TR.fetchPending('http://x', json({ nope: 1 })), null)
})

test('fetchPending aborts a hung request', async () => {
  const hang = (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
  assert.equal(await TR.fetchPending('http://x', hang, 20), null)
})

test('registers in the Nova group after notifications (order 17)', () => {
  const { reg } = setup()
  assert.equal(TR.ORDER, 17)
  assert.equal(Math.floor(TR.ORDER / 10), Math.floor(T.SECTION.NOVA / 10))
  assert.equal(reg.count(), 1)
})

test('shows nothing until a count arrives, then the entry; click opens Home on the Training panel', async () => {
  const { reg, calls, api } = setup()
  assert.deepEqual(reg.buildTemplate({}), [])           // first build: unknown, a refresh starts
  await api.refresh()
  assert.equal(calls.rebuild, 1)
  const items = reg.buildTemplate({})
  assert.deepEqual(items.map((i) => i.label), ['Review 3 training pairs...'])
  items[0].click()
  assert.deepEqual(calls.home, ['training'])
  assert.equal(calls.urls[0], 'http://127.0.0.1:9999/api/training/pending-count')
})

test('zero pending or an unreachable backend hides the entry', async () => {
  const zero = setup({ fetchFn: json({ pending: 0 }) })
  await zero.api.refresh()
  assert.deepEqual(zero.reg.buildTemplate({}), [])
  const down = setup({ fetchFn: async () => { throw new Error('x') } })
  await down.api.refresh()
  assert.deepEqual(down.reg.buildTemplate({}), [])
})

test('only rebuilds the tray when the count changes', async () => {
  let n = 2
  const { api, calls } = setup({ fetchFn: async () => ({ ok: true, json: async () => ({ pending: n }) }) })
  await api.refresh(); await api.refresh()
  assert.equal(calls.rebuild, 1)
  n = 5
  await api.refresh()
  assert.equal(calls.rebuild, 2)
  assert.equal(api.count(), 5)
})

test('a stale menu build triggers one refresh; a fresh one does not; concurrent refreshes share a request', async () => {
  const { reg, calls, api, tick } = setup()
  reg.buildTemplate({}); reg.buildTemplate({})          // never fetched -> stale, but the second shares the inflight request
  assert.equal(calls.urls.length, 1)
  await api.refresh()
  const n = calls.urls.length
  reg.buildTemplate({})                                 // fresh
  assert.equal(calls.urls.length, n)
  tick(3 * 60 * 1000)
  reg.buildTemplate({})
  assert.equal(calls.urls.length, n + 1)
})

test('start() polls on a timer once and stop() clears it', async () => {
  const { api, timers, calls } = setup()
  api.start(); api.start()
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, TR.REFRESH_MS)
  assert.equal(calls.urls.length, 1)
  api.stop()
  assert.equal(timers[0].cleared, true)
})
