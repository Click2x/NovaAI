// Phase 8: speak rule + quiet hours (table tests), proactive settings, notification cards, the notifier (with a minimal fake DOM), tray section,
// fullscreen check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { decideProactive, inQuietHours, parseClock, SPEAK_MODES } from '../src/ui/speakrule.js'
import { cardFromNotify, cardFromConfirm, cardsFromCatchup, visibleCards, createNotifier, CONFIRM_TEXT, MAX_CARDS } from '../src/ui/notify.js'
import { SECTIONS, getPath, patchFor } from '../src/settings/fields.js'

const require = createRequire(import.meta.url)
const settings = require('../electron/settings.js')
const N = require('../electron/notifications.js')
const T = require('../electron/tray.js')

const at = (h, m = 0) => new Date(2026, 9, 20, h, m)     // local time
const RULE = { speak: 'when_visible_and_not_fullscreen', quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' }
const OK = { now: at(14), visible: true, fullscreen: false, ttsOn: true, talking: false }

// ── speak rule: one row per situation ────────────────────────────────────────────
const SPEAK_TABLE = [
  // [name, rule, ctx overrides, expected {speak, pop, reason}]
  ['default setting never speaks', { ...RULE, speak: 'off' }, {}, { speak: false, pop: true, reason: 'speak_off' }],
  ['unknown mode never speaks', { ...RULE, speak: 'sometimes' }, {}, { speak: false, pop: true, reason: 'speak_off' }],
  ['no rule at all never speaks', undefined, {}, { speak: false, pop: true, reason: 'speak_off' }],
  ['visible, nothing fullscreen: speaks', RULE, {}, { speak: true, pop: true, reason: 'ok' }],
  ['her window hidden', RULE, { visible: false }, { speak: false, pop: true, reason: 'hidden' }],
  ['a fullscreen app in front', RULE, { fullscreen: true }, { speak: false, pop: true, reason: 'fullscreen' }],
  ['fullscreen unknown (window tracking off) is treated as not safe', RULE, { fullscreen: null }, { speak: false, pop: true, reason: 'fullscreen_unknown' }],
  ['fullscreen undefined too', RULE, { fullscreen: undefined }, { speak: false, pop: true, reason: 'fullscreen_unknown' }],
  ['speech turned off in Voice settings', RULE, { ttsOn: false }, { speak: false, pop: true, reason: 'tts_off' }],
  ['she is already talking', RULE, { talking: true }, { speak: false, pop: true, reason: 'already_talking' }],
  ['quiet hours silence and hide, even when everything else allows it', { ...RULE, quietEnabled: true }, { now: at(23) }, { speak: false, pop: false, reason: 'quiet_hours' }],
  ['quiet hours silence and hide when speak is off too', { ...RULE, speak: 'off', quietEnabled: true }, { now: at(23) }, { speak: false, pop: false, reason: 'quiet_hours' }],
  ['quiet hours configured but disabled', { ...RULE, quietEnabled: false }, { now: at(23) }, { speak: true, pop: true, reason: 'ok' }],
  ['outside quiet hours', { ...RULE, quietEnabled: true }, { now: at(12) }, { speak: true, pop: true, reason: 'ok' }],
]
for (const [name, rule, over, want] of SPEAK_TABLE) {
  test(`speak rule: ${name}`, () => assert.deepEqual(decideProactive(rule, { ...OK, ...over }), want))
}

test('speak modes match the settings schema', () => assert.deepEqual(SPEAK_MODES, settings.SPEAK_MODES))

// ── quiet hours ──────────────────────────────────────────────────────────────────
const Q = (start, end, enabled = true) => ({ quietEnabled: enabled, quietStart: start, quietEnd: end })
const QUIET_TABLE = [
  // [start, end, [hour, minute], expected]
  ['22:00', '08:00', [21, 59], false], ['22:00', '08:00', [22, 0], true], ['22:00', '08:00', [23, 30], true], ['22:00', '08:00', [0, 0], true],
  ['22:00', '08:00', [7, 59], true], ['22:00', '08:00', [8, 0], false], ['22:00', '08:00', [12, 0], false],
  ['13:00', '15:30', [12, 59], false], ['13:00', '15:30', [13, 0], true], ['13:00', '15:30', [15, 29], true], ['13:00', '15:30', [15, 30], false],
  ['09:00', '09:00', [9, 0], false],            // equal bounds = an empty window, not a whole day
  ['7:05', '8:00', [7, 5], true],               // one-digit hour is read
  ['25:00', '08:00', [3, 0], false], ['22:00', 'late', [23, 0], false], ['', '', [1, 0], false], [null, undefined, [1, 0], false],
]
for (const [start, end, [h, m], want] of QUIET_TABLE) {
  test(`quiet ${start}-${end} at ${h}:${String(m).padStart(2, '0')} -> ${want}`, () => assert.equal(inQuietHours(Q(start, end), at(h, m)), want))
}
test('quiet hours off means never quiet', () => assert.equal(inQuietHours(Q('00:00', '23:59', false), at(3)), false))
test('parseClock', () => {
  assert.equal(parseClock('08:30'), 510)
  assert.equal(parseClock(' 7:05 '), 425)
  for (const bad of ['24:00', '12:60', 'noon', '', null, undefined, 830, '1230']) assert.equal(parseClock(bad), null)
})

// ── proactive settings ───────────────────────────────────────────────────────────
test('proactive defaults: speaking off, quiet hours off', () => {
  assert.deepEqual(settings.DEFAULTS.proactive, { speak: 'off', quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' })
  assert.deepEqual(settings.sanitize({}).proactive, settings.DEFAULTS.proactive)
})
test('proactive sanitize: bad values keep the previous value, clocks are normalised', () => {
  const s = settings.sanitize({ proactive: { speak: 'when_visible_and_not_fullscreen', quietEnabled: true, quietStart: '7:05', quietEnd: '23:59' } })
  assert.deepEqual(s.proactive, { speak: 'when_visible_and_not_fullscreen', quietEnabled: true, quietStart: '07:05', quietEnd: '23:59' })
  const bad = settings.sanitize({ proactive: { speak: 'loud', quietEnabled: 'yes', quietStart: '25:00', quietEnd: 5 } })
  assert.deepEqual(bad.proactive, settings.DEFAULTS.proactive)
  assert.deepEqual(settings.sanitize({ proactive: 'x' }).proactive, settings.DEFAULTS.proactive)
  const base = settings.sanitize({ proactive: { speak: 'when_visible_and_not_fullscreen', quietStart: '21:30' } })
  assert.equal(settings.sanitize({ proactive: { speak: 'nope', quietStart: '99:99' } }, base).proactive.speak, 'when_visible_and_not_fullscreen')
  assert.equal(settings.sanitize({ proactive: { quietStart: '99:99' } }, base).proactive.quietStart, '21:30')
})
test('proactive patches merge by key and survive a round trip', () => {
  const cur = settings.sanitize({})
  const next = settings.applyPatch(cur, patchFor('proactive.speak', 'when_visible_and_not_fullscreen'))
  assert.equal(next.proactive.speak, 'when_visible_and_not_fullscreen')
  assert.equal(next.proactive.quietEnd, '08:00')
  assert.deepEqual(settings.sanitize(JSON.parse(JSON.stringify(next))), next)
})
test('proactive is not sent to the backend (the overlay decides)', () => {
  assert.ok(!('proactive' in settings.toBackend(settings.sanitize({}))))
})
test('the Notifications panel rows edit real settings', () => {
  const sec = SECTIONS.find((s) => s.title === 'Notifications')
  assert.deepEqual(sec.fields.map((f) => f.path), ['proactive.speak', 'proactive.quietEnabled', 'proactive.quietStart', 'proactive.quietEnd'])
  for (const f of sec.fields) assert.notEqual(getPath(settings.DEFAULTS, f.path), undefined, f.path)
  const speak = sec.fields[0]
  assert.deepEqual(speak.options.map((o) => o[0]), settings.SPEAK_MODES)
})

// ── cards ────────────────────────────────────────────────────────────────────────
test('cardFromNotify keeps only usable fields and at most 3 buttons', () => {
  const c = cardFromNotify({ id: 'review-4', kind: 'outreach_review', title: ' Nova\n wants ', body: 'I wonder', ref: { item_id: 4 },
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'bad id', label: 'x' }, { id: 'reject', label: '' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] })
  assert.equal(c.title, 'Nova wants')
  assert.deepEqual(c.actions.map((a) => a.id), ['approve', 'a', 'b'])
  assert.deepEqual(c.ref, { item_id: 4 })
  assert.equal(c.local, false)
})
test('unusable notify messages are refused', () => {
  for (const m of [null, {}, { id: 'x', kind: 'alert', title: '' }, { id: 'bad id', kind: 'alert', title: 't' }, { id: 'x', kind: 5, title: 't' }, { id: 'x', kind: 'a b', title: 't' }]) assert.equal(cardFromNotify(m), null)
})
test('confirm card: Yes/No answer in the words the backend understands', () => {
  const c = cardFromConfirm({ turn_id: 't1', tool: 'run_command', description: 'run `dir`' })
  assert.equal(c.title, 'Nova wants to run `dir`')
  assert.deepEqual(c.actions.map((a) => a.id), ['yes', 'no'])
  assert.equal(c.local, true)
  assert.deepEqual(CONFIRM_TEXT, { yes: 'yes', no: 'no' })
  assert.equal(cardFromConfirm({ turn_id: 't1', tool: 'git_push', description: '' }).title, 'Nova wants to git push')
  assert.equal(cardFromConfirm({ tool: 'x' }), null)
  assert.equal(cardFromConfirm({ turn_id: 't', tool: '', description: '' }), null)
})
test('catch-up cards: one for the messages, one per waiting thought', () => {
  const cards = cardsFromCatchup({ messages: [{ id: 1, text: 'first' }, { id: 2, text: 'reminder: call mom' }, { id: 3, text: '  ' }],
    reviews: [{ item_id: 7, text: 'I wonder about your week' }, { item_id: 'x', text: 'bad' }, { item_id: 8, text: '' }] })
  assert.deepEqual(cards.map((c) => c.id), ['catchup', 'review-7'])
  assert.equal(cards[0].title, '2 messages while you were away')
  assert.equal(cards[0].body, 'reminder: call mom')
  assert.deepEqual(cards[1].ref, { item_id: 7 })
  assert.deepEqual(cards[1].actions.map((a) => a.id), ['approve', 'reject'])
  assert.equal(cardsFromCatchup({ messages: [{ text: 'one' }] })[0].title, 'A message while you were away')
  assert.deepEqual(cardsFromCatchup(null), [])
  assert.deepEqual(cardsFromCatchup({ messages: [], reviews: [] }), [])
})
test('visibleCards: newest three out loud, quiet ones only when expanded', () => {
  const cards = [1, 2, 3, 4, 5].map((n) => ({ id: 'c' + n, quiet: n === 5 }))
  assert.deepEqual(visibleCards(cards, false).map((c) => c.id), ['c2', 'c3', 'c4'])
  assert.deepEqual(visibleCards(cards, true).map((c) => c.id), ['c1', 'c2', 'c3', 'c4', 'c5'])
})

// ── the notifier, on a minimal fake DOM ──────────────────────────────────────────
class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this._text = ''; this.disabled = false; this.onclick = null; this.attrs = {}
    const self = this
    this.classList = { toggle(c, on) { const set = new Set(self.className.split(' ').filter(Boolean)); (on ? set.add(c) : set.delete(c)); self.className = [...set].join(' ') }, contains: (c) => self.className.split(' ').includes(c) } }
  append(...n) { this.children.push(...n) }
  set textContent(v) { this._text = String(v); if (v === '') this.children = [] }
  get textContent() { return this._text }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out) } return out }
}
function rig(extra = {}) {
  globalThis.document = { createElement: (tag) => new FakeNode(tag) }
  const sent = [], locals = [], changes = [], timers = []
  const root = new FakeNode('div')
  const notifier = createNotifier(root, { send: (m) => { sent.push(m); return extra.sendOk !== false }, local: (c, a) => locals.push([c.id, a]), onChange: (l) => changes.push(l), setTimer: (fn) => timers.push(fn) })
  const buttons = () => root.all((n) => n.tag === 'button' && n.className.includes('rb') && !n.className.includes('bell'))
  const titles = () => root.all((n) => n.className === 'ntitle').map((n) => n.textContent)
  return { notifier, root, sent, locals, changes, timers, buttons, titles }
}
const REVIEW = { id: 'review-4', kind: 'outreach_review', title: 'Nova wants to say something', body: 'hi', actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], ref: { item_id: 4 }, local: false }

test('a button press sends notify_action with the card ref and locks the card until the answer', () => {
  const r = rig()
  r.notifier.add(REVIEW)
  assert.deepEqual(r.titles(), ['Nova wants to say something'])
  assert.deepEqual(r.buttons().map((b) => b.textContent), ['Approve', 'Reject'])
  r.buttons()[0].onclick()
  assert.deepEqual(r.sent, [{ type: 'notify_action', id: 'review-4', kind: 'outreach_review', action: 'approve', ref: { item_id: 4 } }])
  assert.ok(r.buttons().every((b) => b.disabled))
  r.buttons()[1].onclick()
  assert.equal(r.sent.length, 1)                                         // locked: a second press does nothing
  r.notifier.ack({ id: 'review-4', ok: true, message: 'Approved' })
  assert.ok(r.root.all((n) => n.className === 'nstatus' && n.textContent === 'Approved').length === 1)
  r.timers.forEach((fn) => fn())                                         // the status lingers, then the card goes
  assert.equal(r.notifier.count(), 0)
})
test('a refused press is shown and the card still goes away', () => {
  const r = rig()
  r.notifier.add(REVIEW)
  r.buttons()[0].onclick()
  r.notifier.ack({ id: 'review-4', ok: false, message: 'it is no longer waiting for review' })
  assert.ok(r.root.all((n) => n.className === 'nstatus' && /no longer/.test(n.textContent)).length === 1)
  r.timers.forEach((fn) => fn())
  assert.equal(r.notifier.count(), 0)
})
test('no connection: the press is not lost silently', () => {
  const r = rig({ sendOk: false })
  r.notifier.add(REVIEW)
  r.buttons()[0].onclick()
  assert.ok(r.root.all((n) => n.className === 'nstatus' && /reach the backend/.test(n.textContent)).length === 1)
})
test('local cards (confirm) go to the local handler, nothing is sent to notify_action', () => {
  const r = rig()
  r.notifier.add(cardFromConfirm({ turn_id: 't1', tool: 'run_command', description: 'run `dir`' }))
  r.buttons()[1].onclick()
  assert.deepEqual(r.locals, [['confirm', 'no']])
  assert.equal(r.sent.length, 0)
})
test('same id replaces the card; the cap drops the oldest; clear and remove report to the tray', () => {
  const r = rig()
  r.notifier.add(REVIEW)
  r.notifier.add({ ...REVIEW, body: 'changed' })
  assert.equal(r.notifier.count(), 1)
  for (let i = 0; i < MAX_CARDS + 5; i++) r.notifier.add({ id: 'n' + i, kind: 'alert', title: 'A' + i, body: '', actions: [], local: false })
  assert.equal(r.notifier.count(), MAX_CARDS)
  assert.ok(!r.notifier.has('review-4'))
  assert.equal(r.changes.at(-1).length, MAX_CARDS)
  r.notifier.clear()
  assert.equal(r.notifier.count(), 0)
  assert.deepEqual(r.changes.at(-1), [])
})
test('quiet-hours cards wait behind the bell until it is opened', () => {
  const r = rig()
  r.notifier.add(REVIEW, { pop: false })
  assert.deepEqual(r.titles(), [])
  const bell = r.root.all((n) => n.className.includes('bell'))[0]
  assert.equal(bell.textContent, '🔔 1')
  bell.onclick()
  assert.deepEqual(r.titles(), ['Nova wants to say something'])
})
test('backend text only ever goes in as text', () => {
  const r = rig()
  r.notifier.add({ id: 'x', kind: 'alert', title: '<img src=x onerror=alert(1)>', body: '<b>hi</b>', actions: [], local: false })
  const t = r.root.all((n) => n.className === 'ntitle')[0]
  assert.equal(t.textContent, '<img src=x onerror=alert(1)>')        // a plain text node: the fake DOM has no innerHTML, and the code never uses it
})

// ── main process: fullscreen check and the tray section ─────────────────────────
const DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 }
const FS_TABLE = [
  ['game covering the display (DIPs)', { app: 'game', title: 'X', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, true],
  ['game covering the display (physical px at 150%)', { app: 'game', title: 'X', bounds: { x: 0, y: 0, width: 2880, height: 1620 } }, true],
  ['one pixel short is still fullscreen', { app: 'game', title: 'X', bounds: { x: 0, y: 0, width: 1919, height: 1079 } }, true],
  ['maximized window leaves the taskbar out', { app: 'chrome', title: 'Tab', bounds: { x: 0, y: 0, width: 1920, height: 1040 } }, false],
  ['a normal window', { app: 'notepad', title: 'x', bounds: { x: 100, y: 100, width: 800, height: 600 } }, false],
  ['the desktop itself is not a fullscreen app', { app: 'explorer', title: 'Program Manager', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, false],
  ['an Explorer window with a title can be fullscreen', { app: 'explorer', title: 'Downloads', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, true],
  ['no bounds: unknown', { app: 'x', title: '' }, null],
  ['no window: unknown', null, null],
  ['junk bounds: unknown', { app: 'x', bounds: { width: 'a', height: 0 } }, null],
]
for (const [name, win, want] of FS_TABLE) test(`fullscreen: ${name}`, () => assert.equal(N.isFullscreenWindow(win, DISPLAY), want))
test('fullscreen: no display is unknown', () => assert.equal(N.isFullscreenWindow({ app: 'x', bounds: { width: 10, height: 10 } }, null), null))

test('tray section: hidden when empty, a count and titles when not, rebuilt only on change', () => {
  const reg = T.createTrayRegistry()
  let rebuilt = 0, cleared = 0
  const n = N.registerNotifications({ registerTraySection: reg.registerTraySection, rebuildTray: () => rebuilt++, clear: () => cleared++ })
  const labels = () => reg.buildTemplate({}).map((i) => i.label)
  assert.deepEqual(labels(), [])
  n.setItems([{ id: 'a', title: 'Reminder' }, { id: 'b', title: 'x'.repeat(100) }])
  assert.equal(rebuilt, 1)
  const l = labels()
  assert.equal(l[0], 'Notifications (2)')
  assert.equal(l[1], '   Reminder')
  assert.ok(l[2].length <= 3 + 46 && l[2].endsWith('…'))
  assert.equal(l.at(-1), 'Clear notifications')
  n.setItems([{ id: 'a', title: 'Reminder' }, { id: 'b', title: 'x'.repeat(100) }])
  assert.equal(rebuilt, 1)                                              // same list: no rebuild
  reg.buildTemplate({}).at(-1).click()
  assert.equal(cleared, 1)
  n.setItems(Array.from({ length: 9 }, (_, i) => ({ id: 'i' + i, title: 'T' + i })))
  assert.ok(labels().includes('   +3 more'))
  n.setItems('junk')
  assert.deepEqual(labels(), [])
})
test('the notifications section sits in the Nova group, below Today', () => {
  assert.ok(N.ORDER > 15 && N.ORDER < 20)
})
