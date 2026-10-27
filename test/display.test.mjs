// Optional display + one origin for the avatar and the chat window: settings, placement.chatBounds, the radial ring, the chat model,
// the chat window manager (fake Electron). No Electron, no backend.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { SECTIONS, getPath, patchFor } from '../src/settings/fields.js'
import { ringLayout, RADIAL_ITEMS } from '../src/ui/radial.js'
import { initialState, addUser, applyEvent, setNet, MAX_MESSAGES } from '../src/chat/model.js'

const require = createRequire(import.meta.url)
const S = require('../electron/settings.js')
const P = require('../electron/placement.js')
const chat = require('../electron/chat.js')

const display = (id, x, y, w, h) => ({ id, workArea: { x, y, width: w, height: h } })
const D1 = display(1, 0, 0, 1920, 1040)
const D2 = display(2, 1920, 0, 1920, 1040)
const AVATAR = { x: 1500, y: 360, width: 420, height: 680 }      // WIN_W x WIN_H at the default bottom-right spot

// ── settings ──
test('display defaults: avatar on, chat window off, automatic side', () => {
  assert.deepEqual(S.DEFAULTS.display, { avatar: true, chat: false, chatSide: 'auto' })
  assert.deepEqual(S.sanitize({ display: { avatar: 'no', chat: 1, chatSide: 'up' } }).display, S.DEFAULTS.display)
  assert.deepEqual(S.applyPatch(S.DEFAULTS, { display: { avatar: false, chat: true, chatSide: 'right' } }).display, { avatar: false, chat: true, chatSide: 'right' })
})

test('the Display rows exist and round-trip', () => {
  const sec = SECTIONS.find((s) => s.title === 'Display')
  assert.deepEqual(sec.fields.map((f) => f.path), ['display.avatar', 'display.chat', 'display.chatSide'])
  for (const f of sec.fields) assert.notEqual(getPath(S.DEFAULTS, f.path), undefined)
  assert.equal(getPath(S.applyPatch(S.DEFAULTS, patchFor('display.avatar', false)), 'display.avatar'), false)
})

test('display settings are not sent to the backend', () => {
  assert.equal('display' in S.toBackend(S.DEFAULTS), false)
})

// ── one origin ──
test('chat opens to the left of the avatar, bottoms aligned, overlapping the transparent margin', () => {
  const b = P.chatBounds([D1], AVATAR)
  assert.equal(b.side, 'left')
  assert.equal(b.x, AVATAR.x - P.CHAT_SIZE.width + P.CHAT_OVERLAP)
  assert.equal(b.y + b.height, AVATAR.y + AVATAR.height)         // 1040 = the bottom of the work area too
  assert.deepEqual([b.width, b.height], [P.CHAT_SIZE.width, P.CHAT_SIZE.height])
})

test('auto flips to the right when the left would leave the display; fixed sides are respected', () => {
  const nearLeft = { x: 10, y: 360, width: 420, height: 680 }
  assert.equal(P.chatBounds([D1], nearLeft).side, 'right')
  assert.equal(P.chatBounds([D1], nearLeft).x, 10 + 420 - P.CHAT_OVERLAP)
  assert.equal(P.chatBounds([D1], AVATAR, P.CHAT_SIZE, 'right').side, 'right')
  assert.equal(P.chatBounds([D1], nearLeft, P.CHAT_SIZE, 'left').x, 0)          // forced left is clamped on screen, not moved off it
})

test('the chat window always stays inside the work area of the avatar display', () => {
  for (const a of [AVATAR, { x: -300, y: -300, width: 420, height: 680 }, { x: 1800, y: 900, width: 420, height: 680 }, { x: 2300, y: 100, width: 420, height: 680 }]) {
    for (const side of ['auto', 'left', 'right']) {
      const b = P.chatBounds([D1, D2], a, P.CHAT_SIZE, side)
      const centre = { x: a.x + 210, y: a.y + 340 }
      const w = (centre.x >= 1920 ? D2 : D1).workArea
      assert.ok(b.x >= w.x && b.x + b.width <= w.x + w.width && b.y >= w.y && b.y + b.height <= w.y + w.height, JSON.stringify({ a, side, b }))
    }
  }
})

test('moving the origin moves the chat window by the same amount (no stored position of its own)', () => {
  const a = P.chatBounds([D1], { ...AVATAR, x: 800, y: 100 })
  const b = P.chatBounds([D1], { ...AVATAR, x: 900, y: 150 })
  assert.deepEqual([b.x - a.x, b.y - a.y], [100, 50])
  assert.equal('chat' in S.DEFAULTS.placement, false)
})

test('a display smaller than the chat window shrinks it instead of overflowing', () => {
  const tiny = display(9, 0, 0, 300, 400)
  const b = P.chatBounds([tiny], { x: 0, y: 0, width: 300, height: 400 })
  assert.ok(b.width <= 300 && b.height <= 400)
})

// ── radial menu ──
test('radial ring: n points on a circle, first one on top, inside the window', () => {
  const r = ringLayout(6, 200, 300, 96, 420, 680)
  assert.equal(r.points.length, 6)
  assert.deepEqual(r.points[0], { x: 200, y: 204 })
  for (const p of r.points) assert.ok(p.x >= 22 && p.x <= 420 - 22 && p.y >= 22 && p.y <= 680 - 22)
})

test('radial ring is pushed inside the window near an edge and shrinks in a small window', () => {
  const edge = ringLayout(6, 5, 5, 96, 420, 680)
  for (const p of edge.points) assert.ok(p.x >= 22 && p.y >= 22)
  const small = ringLayout(6, 100, 100, 96, 150, 150)
  assert.ok(small.radius < 96)
  for (const p of small.points) assert.ok(p.x >= 22 && p.x <= 128 && p.y >= 22 && p.y <= 128)
})

test('radial items: talk, chat, home, code, settings, hide - unique ids', () => {
  assert.deepEqual(RADIAL_ITEMS.map((i) => i.id), ['talk', 'chat', 'home', 'code', 'settings', 'hide'])
})

// ── chat model ──
test('history rows come in oldest first, once, and pages go above what is shown', () => {
  let s = applyEvent(initialState(), { type: 'history', has_more: true, messages: [{ id: 5, sender: 'user', text: 'hi' }, { id: 6, sender: 'nova', text: 'hello' }, { id: 7, sender: 'nova', text: '' }] })
  assert.deepEqual(s.messages.map((m) => [m.role, m.text]), [['user', 'hi'], ['nova', 'hello']])
  assert.equal(s.hasMore, true)
  s = applyEvent(s, { type: 'history', has_more: false, messages: [{ id: 3, sender: 'user', text: 'older' }, { id: 5, sender: 'user', text: 'hi' }] })
  assert.deepEqual(s.messages.map((m) => m.text), ['older', 'hi', 'hello'])
  assert.equal(s.hasMore, false)
})

test('a turn streams sentences into one message and ends with its id', () => {
  let s = addUser(initialState(), 't1', 'hey')
  s = applyEvent(s, { type: 'turn_start', turn_id: 't1' })
  s = applyEvent(s, { type: 'sentence', turn_id: 't1', text: 'Hi there.' })
  s = applyEvent(s, { type: 'sentence', turn_id: 't1', text: 'How are you?' })
  assert.equal(s.messages[1].text, 'Hi there. How are you?')
  assert.equal(s.messages[1].pending, true)
  s = applyEvent(s, { type: 'turn_end', turn_id: 't1', message_id: 42 })
  assert.deepEqual([s.messages[1].pending, s.messages[1].id, s.turn], [false, 42, null])
})

test('an interrupted turn that said nothing disappears; one that said something stays', () => {
  let s = applyEvent(initialState(), { type: 'turn_start', turn_id: 'a' })
  s = applyEvent(s, { type: 'turn_end', turn_id: 'a', interrupted: true })
  assert.equal(s.messages.length, 0)
  s = applyEvent(applyEvent(s, { type: 'turn_start', turn_id: 'b' }), { type: 'sentence', turn_id: 'b', text: 'Partial' })
  s = applyEvent(s, { type: 'turn_end', turn_id: 'b', interrupted: true })
  assert.equal(s.messages[0].text, 'Partial')
})

test('proactive lines and errors are added; unknown events and junk are ignored', () => {
  let s = applyEvent(initialState(), { type: 'proactive', id: 'x1', text: 'Reminder: tea', message_id: 9 })
  assert.equal(s.messages[0].text, 'Reminder: tea')
  s = applyEvent(applyEvent(s, { type: 'turn_start', turn_id: 'z' }), { type: 'error', message: 'boom' })
  assert.equal(s.messages.at(-1).role, 'note')
  assert.ok(!s.messages.some((m) => m.pending))
  const same = s
  assert.equal(applyEvent(s, { type: 'pong' }), same)
  assert.equal(applyEvent(s, null), same)
  assert.equal(applyEvent(s, { type: 'sentence', turn_id: 'q', text: 5 }), same)
})

test('the list is capped and the net status only changes when it differs', () => {
  let s = initialState()
  for (let i = 0; i < MAX_MESSAGES + 20; i++) s = addUser(s, 't' + i, 'm' + i)
  assert.equal(s.messages.length, MAX_MESSAGES)
  assert.equal(s.messages.at(-1).text, 'm' + (MAX_MESSAGES + 19))
  const o = setNet(s, 'online')
  assert.equal(setNet(o, 'online'), o)
})

// ── chat window manager with a fake Electron ──
function fakeElectron() {
  const made = []
  const handlers = {}
  const listeners = {}
  class FakeWin {
    constructor(opts) {
      this.opts = opts; this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }; this.destroyed = false; this.shown = false; this.sent = []
      this.webContents = { on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, send: (...a) => this.sent.push(a) }
      this.handlers = {}; made.push(this)
    }
    setAlwaysOnTop() {}
    loadFile(f) { this.file = f }
    loadURL(u) { this.url = u }
    once(ev, fn) { this.handlers[ev] = fn }
    on(ev, fn) { this.handlers[ev] = fn }
    show() { this.shown = true }
    focus() {}
    isDestroyed() { return this.destroyed }
    setBounds(b) { this.bounds = { ...b } }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed() }
  }
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn }, on: (c, fn) => { listeners[c] = fn } }
  return { made, handlers, listeners, FakeWin, ipcMain }
}

function makeChat(over = {}) {
  const f = fakeElectron()
  let origin = { ...AVATAR }
  let closedByUser = 0
  const api = chat.registerChat({
    ipcMain: f.ipcMain, BrowserWindow: f.FakeWin, screen: { getAllDisplays: () => [D1, D2] }, DEV: false, placement: P,
    getWsUrl: () => 'ws://127.0.0.1:8000/api/desktop/ws', getBackendSettings: () => ({ tts: true, voice: 'af_heart' }),
    getOrigin: () => origin, getSide: () => 'auto', isAvatarVisible: () => true, onClosedByUser: () => { closedByUser++ },
    distDir: '/dist', preload: '/p.js', ...over,
  })
  return { f, api, setOrigin: (o) => { origin = o }, closed: () => closedByUser }
}

test('open creates one frameless, sandboxed window at the derived bounds; a second open reuses it', () => {
  const { f, api } = makeChat()
  const w = api.open()
  assert.equal(f.made.length, 1)
  assert.equal(w.opts.frame, false)
  assert.equal(w.opts.webPreferences.sandbox, true)
  assert.equal(w.opts.webPreferences.nodeIntegration, false)
  assert.equal(w.opts.webPreferences.contextIsolation, true)
  assert.deepEqual({ x: w.opts.x, y: w.opts.y }, { x: P.chatBounds([D1, D2], AVATAR).x, y: P.chatBounds([D1, D2], AVATAR).y })
  api.open()
  assert.equal(f.made.length, 1)
  assert.equal(api.isOpen(), true)
})

test('follow re-derives the bounds from the moved origin', () => {
  const { f, api, setOrigin } = makeChat()
  const w = api.open()
  setOrigin({ ...AVATAR, x: 700, y: 200 })
  api.follow()
  assert.deepEqual(w.bounds, (({ x, y, width, height }) => ({ x, y, width, height }))(P.chatBounds([D1, D2], { ...AVATAR, x: 700, y: 200 })))
  api.close()
  assert.doesNotThrow(() => api.follow())          // nothing to move
  assert.equal(f.made.length, 1)
})

test('toggle opens and closes; closing from the page reports to the owner', () => {
  const { f, api, closed } = makeChat()
  assert.equal(api.toggle(), true)
  const w = f.made[0]
  f.listeners['chat-close']({ sender: w.webContents })
  assert.equal(api.isOpen(), false)
  assert.equal(closed(), 1)
  assert.equal(api.toggle(), true)
  assert.equal(f.made.length, 2)
})

test('the page config and close come only from the chat window itself', () => {
  const { f, api, closed } = makeChat()
  api.open()
  const w = f.made[0]
  const cfg = f.handlers['chat-config']({ sender: w.webContents })
  assert.deepEqual(cfg, { wsUrl: 'ws://127.0.0.1:8000/api/desktop/ws', backendSettings: { tts: true, voice: 'af_heart' }, avatarVisible: true })
  assert.equal(f.handlers['chat-config']({ sender: {} }), null)
  f.listeners['chat-close']({ sender: {} })
  assert.equal(api.isOpen(), true)
  assert.equal(closed(), 0)
})

test('navigation is pinned to the chat page and avatar visibility is pushed to the page', () => {
  assert.equal(chat.allowNavigation('file:///dist/chat.html', 'file:///dist/'), true)
  assert.equal(chat.allowNavigation('https://example.com/', 'file:///dist/'), false)
  const { f, api } = makeChat()
  api.open()
  api.avatarVisible(false)
  assert.deepEqual(f.made[0].sent.at(-1), ['avatar-visible', false])
})
