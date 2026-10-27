// Moving things around and locking them: the on-screen clamp, the saved layout, the chat window's own offset, the grips, and a radial menu
// that fans around the orb instead of covering it. No Electron, no DOM (a tiny fake document).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { clampOffset, createLayout } from '../src/ui/layout.js'
import { arcLayout, RADIAL_ITEMS } from '../src/ui/radial.js'

const require = createRequire(import.meta.url)
const P = require('../electron/placement.js')
const S = require('../electron/settings.js')

// ── pure ──
test('clamp: an element can be moved anywhere inside the window, never off it', () => {
  const base = { left: 100, top: 400 }, size = { w: 200, h: 50 }
  assert.deepEqual(clampOffset({ x: 30, y: -20 }, base, size, 420, 680), { x: 30, y: -20 })
  assert.deepEqual(clampOffset({ x: -999, y: -999 }, base, size, 420, 680), { x: -100, y: -400 })
  assert.deepEqual(clampOffset({ x: 999, y: 999 }, base, size, 420, 680), { x: 120, y: 230 })
  assert.deepEqual(clampOffset({ x: NaN, y: 'x' }, base, size, 420, 680), { x: 0, y: 0 })
  assert.deepEqual(clampOffset({ x: 50, y: 50 }, { left: 0, top: 0 }, { w: 900, h: 900 }, 420, 680), { x: 0, y: 0 })   // bigger than the window
})

test('shifted: the chat window moves by the offset and stays on the screen', () => {
  const d = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]
  const base = { x: 1000, y: 300, width: 360, height: 520 }
  const a = P.shifted(d, base, { x: -200, y: 40 })
  assert.deepEqual([a.x, a.y, a.offset], [800, 340, { x: -200, y: 40 }])
  const b = P.shifted(d, base, { x: 5000, y: 5000 })
  assert.deepEqual([b.x, b.y], [1560, 520])
  assert.deepEqual(b.offset, { x: 560, y: 220 })                       // what to save is what was really applied
  assert.deepEqual(P.shifted(d, base, undefined).offset, { x: 0, y: 0 })
  assert.deepEqual(P.shifted([], base, { x: 9, y: 9 }).offset, { x: 0, y: 0 })
})

test('settings: layout is validated, unknown elements dropped, zero offsets not stored', () => {
  assert.deepEqual(S.DEFAULTS.display.layout, { locked: false, chat: { x: 0, y: 0 }, ui: {} })
  const got = S.sanitize({ display: { layout: { locked: 1, chat: { x: 12.6, y: 'a' }, ui: { bubble: { x: 5, y: -9000 }, inputbox: { x: 0, y: 0 }, evil: { x: 1, y: 1 } } } } }).display.layout
  assert.deepEqual(got, { locked: false, chat: { x: 13, y: 0 }, ui: { bubble: { x: 5, y: -4000 } } })
  const locked = S.applyPatch(S.DEFAULTS, { display: { layout: { locked: true } } }).display.layout
  assert.equal(locked.locked, true)
  const moved = S.applyPatch(S.applyPatch(S.DEFAULTS, { display: { layout: { locked: true } } }), { display: { layout: { ui: { actions: { x: 3, y: 4 } } } } }).display.layout
  assert.deepEqual([moved.locked, moved.ui], [true, { actions: { x: 3, y: 4 } }])
  const base = S.applyPatch(S.DEFAULTS, { display: { layout: { locked: true, chat: { x: 9, y: 9 }, ui: { actions: { x: 3, y: 4 } } } } })
  const reset = S.applyPatch(base, { display: { layout: { chat: { x: 0, y: 0 }, ui: {} } } }).display.layout
  assert.deepEqual([reset.ui, reset.chat, reset.locked], [{}, { x: 0, y: 0 }, true])       // reset keeps the lock
})

// ── the menu around the orb ──
test('radial fan: around the orb, outside it, on screen, neighbours apart', () => {
  const orb = { cx: 306, cy: 566, r: 96 }, W = 420, H = 680
  const f = arcLayout(RADIAL_ITEMS.length, orb.cx, orb.cy, orb.r + 38, W, H)
  assert.equal(f.points.length, RADIAL_ITEMS.length)
  for (const p of f.points) {
    assert.ok(Math.hypot(p.x - orb.cx, p.y - orb.cy) >= orb.r + 22, 'clear of the orb ' + JSON.stringify(p))
    assert.ok(p.x >= 22 && p.x <= W - 22 && p.y >= 22 && p.y <= H - 22, 'inside the window ' + JSON.stringify(p))
  }
  for (let i = 1; i < f.points.length; i++) assert.ok(Math.hypot(f.points[i].x - f.points[i - 1].x, f.points[i].y - f.points[i - 1].y) >= 44, 'buttons do not overlap')
  const small = arcLayout(RADIAL_ITEMS.length, 300, 600, 72 / 2 + 38, W, H)         // a small orb: the arc widens instead of crowding
  for (let i = 1; i < small.points.length; i++) assert.ok(Math.hypot(small.points[i].x - small.points[i - 1].x, small.points[i].y - small.points[i - 1].y) >= 44)
})

// ── the grips ──
function fakeDoc() {
  const doc = {
    body: { classes: new Set(), children: [], append(x) { this.children.push(x) }, classList: { toggle(c, on) { on ? doc.body.classes.add(c) : doc.body.classes.delete(c) } } },
    defaultView: { innerWidth: 420, innerHeight: 680 },
    createElement() {
      const handlers = {}
      const g = { className: '', title: '', style: {}, handlers, classes: new Set(), addEventListener(t, f) { handlers[t] = f }, setPointerCapture() {} }
      g.classList = { toggle(c, on) { on ? g.classes.add(c) : g.classes.delete(c) } }
      return g
    },
  }
  return doc
}
function fakeEl(rect) {
  const vars = {}
  return { vars, rect, style: { setProperty: (k, v) => { vars[k] = v } }, getBoundingClientRect() { return this.rect } }
}
function setup(visible = () => true) {
  const doc = fakeDoc()
  const els = { bubble: fakeEl({ left: 12, top: 300, width: 300, height: 60 }), inputbox: fakeEl({ left: 12, top: 620, width: 396, height: 40 }) }
  const saved = []
  const state = { locked: false }
  const layout = createLayout(doc, { els, isLocked: () => state.locked, save: (u) => saved.push(u), visible: (el) => visible(el, els) })
  return { doc, els, saved, state, layout, grip: (i) => doc.body.children[i] }
}
const ev = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault() {} })

test('dragging a grip moves its element, keeps it on screen, and saves on release', () => {
  const t = setup()
  const g = t.grip(0)
  g.handlers.pointerdown(ev(100, 290))
  assert.equal(t.layout.dragging(), true)
  g.handlers.pointermove(ev(130, 250))
  assert.deepEqual([t.els.bubble.vars['--dx'], t.els.bubble.vars['--dy']], ['30px', '-40px'])
  g.handlers.pointermove(ev(5000, 250))                                   // far right: held at the window edge
  assert.equal(t.els.bubble.vars['--dx'], '108px')                       // 420 - 300 - 12
  g.handlers.pointerup(ev(5000, 250))
  assert.equal(t.layout.dragging(), false)
  assert.deepEqual(t.saved, [{ bubble: { x: 108, y: -40 } }])
})

test('locked: grips do nothing and are hidden; unlocking brings them back', () => {
  const t = setup()
  t.state.locked = true
  t.layout.apply({ locked: true, ui: {} })
  assert.equal(t.doc.body.classes.has('locked'), true)
  t.grip(0).handlers.pointerdown(ev(100, 290))
  assert.equal(t.layout.dragging(), false)
  t.layout.tick()
  assert.equal(t.grip(0).classes.has('show'), false)
  t.state.locked = false
  t.layout.apply({ locked: false, ui: {} })
  assert.equal(t.doc.body.classes.has('locked'), false)
  t.layout.tick()
  assert.equal(t.grip(0).classes.has('show'), true)
  assert.deepEqual([t.grip(0).style.left, t.grip(0).style.top], ['145px', '285px'])
})

test('a hidden element has no grip; double-click puts one element back', () => {
  const t = setup((el, els) => el !== els.inputbox)
  t.layout.tick()
  assert.equal(t.grip(0).classes.has('show'), true)
  assert.equal(t.grip(1).classes.has('show'), false)
  t.layout.apply({ locked: false, ui: { bubble: { x: 20, y: 30 }, inputbox: { x: 1, y: 2 }, junk: { x: 1, y: 1 } } })
  assert.equal(t.els.bubble.vars['--dx'], '20px')
  t.grip(0).handlers.dblclick()
  assert.equal(t.els.bubble.vars['--dx'], '0px')
  assert.deepEqual(t.saved.at(-1), { inputbox: { x: 1, y: 2 } })
})
