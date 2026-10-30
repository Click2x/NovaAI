// The memory window: its grouping and wording (model.js), its backend client (api.js) and the main-process side (electron/memory.js).
// No Electron, no backend: everything is injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { KINDS, kindOf, sourceLabel, ago, groupFacts, headline, exportText } from '../src/memory/model.js'
import { createApi } from '../src/memory/api.js'

const require = createRequire(import.meta.url)
const mem = require('../electron/memory.js')

const facts = [
  { id: 1, text: 'The user is called Sam.', kind: 'identity', source: 'onboarding', updated: 100 },
  { id: 2, text: 'The user likes green tea.', kind: 'preference', source: 'learned', updated: 300 },
  { id: 3, text: 'The user likes black coffee in the morning.', kind: 'preference', source: 'user', updated: 200 },
  { id: 4, text: 'The user has a dog named Biscuit.', kind: 'weird-old-kind', source: 'chat', updated: 50 },
]

test('facts are grouped in the window order, newest first, and an unknown kind is not lost', () => {
  const g = groupFacts(facts)
  assert.deepEqual(g.map((x) => x.id), ['identity', 'preference', 'fact'])
  assert.deepEqual(g[1].facts.map((f) => f.id), [2, 3])
  assert.equal(kindOf(facts[3]), 'fact')
  assert.equal(KINDS.length, 5)
})

test('search needs every word, ignores case, and leaves out empty groups', () => {
  assert.deepEqual(groupFacts(facts, 'LIKES tea').flatMap((g) => g.facts.map((f) => f.id)), [2])
  assert.deepEqual(groupFacts(facts, 'nothing like this'), [])
  assert.equal(groupFacts(facts, '  ').length, 3)
})

test('wording: where a fact came from, how old it is, the headline', () => {
  assert.equal(sourceLabel('learned'), 'I picked this up')
  assert.equal(sourceLabel('user'), 'You told me')
  assert.equal(sourceLabel('???'), 'From a chat')
  const now = 1_000_000 * 1000
  assert.equal(ago(1_000_000 - 10, now), 'just now')
  assert.equal(ago(1_000_000 - 600, now), '10 min ago')
  assert.equal(ago(1_000_000 - 3600, now), '1 hour ago')
  assert.equal(ago(1_000_000 - 86400 * 3, now), '3 days ago')
  assert.equal(ago(0, now), '')
  assert.equal(headline(0, 0, ''), 'I do not remember anything about you yet.')
  assert.equal(headline(1, 1, ''), 'I remember 1 thing about you.')
  assert.equal(headline(4, 1, 'tea'), 'I remember 4 things about you. 1 matches your search.')
})

test('the text export is grouped, readable, and says so when empty', () => {
  const day = new Date('2026-10-30T12:00:00Z')
  const out = exportText(facts, day)
  assert.match(out, /^What Nova remembers about you \(exported 2026-10-30\)\n\nAbout you\n- The user is called Sam\./)
  assert.ok(out.indexOf('Likes and dislikes') < out.indexOf('Other things I know'))
  assert.match(exportText([], day), /Nothing yet\./)
  assert.equal(mem.exportText(facts, day), exportText(facts, day), 'the main-process copy writes the same file')
  assert.equal(mem.exportName(day), 'nova-memory-2026-10-30.txt')
})

// ── api ──
const fakeFetch = (routes) => async (url, init = {}) => {
  const key = `${init.method || 'GET'} ${new URL(url).pathname}`
  const hit = routes[key]
  if (!hit) throw new Error('offline')
  const { status = 200, body = {} } = typeof hit === 'function' ? hit(init) : hit
  return { ok: status < 400, status, json: async () => body }
}

test('api: list, add, update, remove, clear and learning switch use the memory endpoints', async () => {
  const seen = []
  const api = createApi('http://127.0.0.1:8000/', fakeFetch({
    'GET /api/memory': { body: { facts } },
    'POST /api/memory': (i) => { seen.push(JSON.parse(i.body)); return { body: { id: 9 } } },
    'PATCH /api/memory/4': (i) => { seen.push(JSON.parse(i.body)); return { body: { ok: true } } },
    'DELETE /api/memory/4': { body: { ok: true } },
    'DELETE /api/memory': { body: { deleted: 4 } },
    'PATCH /api/settings': (i) => { seen.push(JSON.parse(i.body)); return { body: {} } },
  }))
  assert.equal((await api.list()).facts.length, 4)
  assert.equal((await api.add('The user likes jazz.', 'preference')).id, 9)
  assert.equal((await api.update(4, 'The user has a dog.', 'fact')).ok, true)
  assert.equal((await api.remove(4)).ok, true)
  assert.equal((await api.clear()).deleted, 4)
  await api.setAutoLearn(false)
  assert.deepEqual(seen, [{ text: 'The user likes jazz.', kind: 'preference' }, { text: 'The user has a dog.', kind: 'fact' }, { memory: { auto_learn: false } }])
})

test('api: an unreachable backend and a refusal both come back as calm errors', async () => {
  const off = createApi('http://127.0.0.1:1', fakeFetch({}))
  assert.deepEqual(await off.list(), { ok: false, offline: true, error: 'I cannot reach my backend.' })
  const no = createApi('http://x', fakeFetch({ 'PATCH /api/memory/5': { status: 404, body: { detail: 'no such memory, or text too short' } } }))
  const r = await no.update(5, 'x')
  assert.equal(r.ok, false)
  assert.equal(r.status, 404)
  assert.equal(r.error, 'no such memory, or text too short')
})

// ── main-process side ──
function harness({ facts: list = facts, pick = { canceled: false, filePath: 'C:\\out\\mem.txt' }, fetchOk = true } = {}) {
  const handlers = new Map()
  const written = []
  const win = { webContents: {}, isDestroyed: () => false, show() {}, focus() {}, setBounds() {}, once() {}, on() {}, loadFile() {}, loadURL() {} }
  win.webContents.on = () => {}
  win.webContents.setWindowOpenHandler = () => {}
  const reg = mem.registerMemory({
    ipcMain: { handle: (n, f) => handlers.set(n, f) },
    BrowserWindow: function () { return win },
    dialog: { showSaveDialog: async () => pick },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    DEV: false, getBase: () => 'http://127.0.0.1:8000/', distDir: 'dist', preload: 'p.js',
    fetchFn: async () => ({ ok: fetchOk, json: async () => ({ facts: list }) }),
    fsApi: { writeFileSync: (p, t) => written.push([p, t]) },
  })
  reg.open()
  return { handlers, win, written }
}

test('only the memory window may use its channels', async () => {
  const { handlers } = harness()
  assert.equal(await handlers.get(mem.CONFIG)({ sender: {} }), null)
  assert.deepEqual(await handlers.get(mem.EXPORT)({ sender: {} }), { ok: false, error: 'Not allowed.' })
})

test('the page gets the backend address; export writes the grouped text where the user chose', async () => {
  const { handlers, win, written } = harness()
  const e = { sender: win.webContents }
  assert.deepEqual(await handlers.get(mem.CONFIG)(e), { httpBase: 'http://127.0.0.1:8000' })
  const r = await handlers.get(mem.EXPORT)(e)
  assert.equal(r.ok, true)
  assert.match(r.name, /mem\.txt$/)       // path.basename of a Windows path differs by platform; the file name is what matters
  assert.equal(written[0][0], 'C:\\out\\mem.txt')
  assert.equal(written.length, 1)
  assert.match(written[0][1], /About you\n- The user is called Sam\./)
})

test('export: cancelled dialog writes nothing; a backend error is reported', async () => {
  const a = harness({ pick: { canceled: true } })
  assert.deepEqual(await a.handlers.get(mem.EXPORT)({ sender: a.win.webContents }), { ok: false, canceled: true })
  assert.equal(a.written.length, 0)
  const b = harness({ fetchOk: false })
  assert.equal((await b.handlers.get(mem.EXPORT)({ sender: b.win.webContents })).error, 'I could not read my memory.')
})
