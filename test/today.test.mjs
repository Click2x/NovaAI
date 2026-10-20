// Phase 10: tray "Today" glance formatting, fetch, and registration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const W = require('../electron/today.js')
const T = require('../electron/tray.js')

const at = (h, m = 0) => new Date(2026, 9, 20, h, m)   // local time, 20 Oct 2026
const ev = (title, d, extra = {}) => ({ id: title, title, start: d.toISOString(), end: '', all_day: false, location: '', today: true, ...extra })
const agenda = (events) => ({ authenticated: true, events })
const labels = (l) => l.map((i) => i.label)

test('lists upcoming events today as HH:MM title, all disabled lines', () => {
  const l = W.glanceLines(agenda([ev('Standup', at(9, 5)), ev('Dentist', at(15))]), at(8))
  assert.deepEqual(labels(l), ['09:05  Standup', '15:00  Dentist'])
  assert.ok(l.every((i) => i.enabled === false))
})

test('events already started or on other days are left out; nothing left gives one line', () => {
  const l = W.glanceLines(agenda([ev('Early', at(7)), ev('Tomorrow', at(9), { today: false })]), at(8))
  assert.deepEqual(labels(l), ['Today: nothing more on the calendar'])
})

test('all-day events come first as "All day"', () => {
  const l = W.glanceLines(agenda([ev('Lunch', at(12)), ev('Holiday', at(0), { all_day: true, start: '2026-10-20' })]), at(8))
  assert.deepEqual(labels(l), ['All day  Holiday', '12:00  Lunch'])
})

test('shows at most three and counts the rest', () => {
  const l = W.glanceLines(agenda([1, 2, 3, 4, 5].map((n) => ev('E' + n, at(8 + n)))), at(8))
  assert.deepEqual(labels(l), ['09:00  E1', '10:00  E2', '11:00  E3', '+2 more today'])
})

test('events are sorted by time even if delivered out of order', () => {
  assert.deepEqual(labels(W.glanceLines(agenda([ev('B', at(14)), ev('A', at(10))]), at(8))), ['10:00  A', '14:00  B'])
})

test('long titles are cut and whitespace is collapsed', () => {
  const [line] = W.glanceLines(agenda([ev('x'.repeat(100) + '\n  y', at(10))]), at(8))
  assert.ok(line.label.length <= '10:00  '.length + 40)
  assert.ok(line.label.endsWith('…') && !line.label.includes('\n'))
})

test('hidden (no lines) when not connected, offline or malformed', () => {
  assert.deepEqual(W.glanceLines({ authenticated: false, events: [] }, at(8)), [])
  assert.deepEqual(W.glanceLines(null, at(8)), [])
  assert.deepEqual(W.glanceLines({ authenticated: true }, at(8)), [])
  assert.deepEqual(W.glanceLines(agenda([{ title: 5, today: true }, null, ev('Bad', at(9), { start: 'nope' })]), at(8)), [{ label: 'Today: nothing more on the calendar', enabled: false }])
})

test('fetchAgenda hits the agenda path on the given base and never throws', async () => {
  let url
  const ok = await W.fetchAgenda('http://localhost:8000/', async (u) => { url = u; return { ok: true, json: async () => ({ authenticated: true, events: [] }) } })
  assert.equal(url, 'http://localhost:8000/api/google/agenda?days=1&limit=15')
  assert.equal(ok.authenticated, true)
  assert.equal(await W.fetchAgenda('http://x', async () => ({ ok: false, status: 403 })), null)
  assert.equal(await W.fetchAgenda('http://x', async () => { throw new Error('down') }), null)
})

test('registers at order 15 (the Nova group), fetches once stale, rebuilds, and opens the agenda', async () => {
  const reg = T.createTrayRegistry()
  let clock = at(8).getTime(), rebuilt = 0, opened = null, calls = 0
  const body = agenda([ev('Standup', at(9))])
  const t = W.registerToday({
    registerTraySection: reg.registerTraySection, getBase: () => 'http://localhost:8000', openHome: (p) => { opened = p },
    rebuildTray: () => { rebuilt++ }, fetchFn: async () => { calls++; return { ok: true, json: async () => body } },
    now: () => clock, setTimer: () => 0, clearTimer: () => {},
  })
  reg.registerTraySection(10, () => [{ label: 'show' }])
  assert.deepEqual(labels(reg.buildTemplate({})), ['show'])     // first build: nothing cached yet, a fetch starts
  await t.refresh()
  assert.equal(calls, 1); assert.equal(rebuilt, 1)
  const tpl = reg.buildTemplate({})
  assert.deepEqual(labels(tpl), ['show', '09:00  Standup', 'Open agenda...'])   // order 15 shares the Nova group: no separator
  tpl[2].click(); assert.equal(opened, 'agenda')
  reg.buildTemplate({}); assert.equal(calls, 1)                  // fresh, no second fetch
  clock += 3 * 60 * 1000; reg.buildTemplate({}); await t.refresh(); assert.equal(calls, 2)
})
