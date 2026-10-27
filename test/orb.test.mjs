// The orb that stands in for the avatar on the desktop: its behaviour, its size on the screen, and its settings. No Electron, no DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createOrb, tintFor, levelOf } from '../src/ui/orb.js'
import { SECTIONS, getPath } from '../src/settings/fields.js'

const require = createRequire(import.meta.url)
const P = require('../electron/placement.js')
const S = require('../electron/settings.js')

function fakeEl(rect = { left: 600, top: 400, width: 120, height: 120 }) {
  const vars = {}
  return { vars, rect, style: { setProperty: (k, v) => { vars[k] = v } }, getBoundingClientRect() { return this.rect } }
}

test('tint: neutral when calm, towards the mood when she has one, never out of range', () => {
  assert.deepEqual(tintFor({}), [139, 92, 246])
  assert.deepEqual(tintFor({ happy: 0 }), [139, 92, 246])
  const happy = tintFor({ happy: 1 })
  assert.deepEqual(happy, [236, 110, 170])
  const half = tintFor({ sad: 0.5 })
  assert.ok(half[2] < 246 && half[0] < 139)                                     // part-way towards blue
  for (const c of tintFor({ happy: 1, sad: 1, angry: 1, surprised: 1, relaxed: 1 })) assert.ok(c >= 0 && c <= 255)
  assert.deepEqual(tintFor({ happy: NaN, sad: 'x' }), [139, 92, 246])
})

test('level: the loudest mouth shape, 0..1, junk is silence', () => {
  assert.equal(levelOf({}), 0)
  assert.equal(levelOf(null), 0)
  assert.equal(levelOf({ aa: 0.6, ee: 0.2 }), 0.6)
  assert.ok(Math.abs(levelOf({ ou: 1 }) - 0.75) < 1e-9)
  assert.equal(levelOf({ aa: 5 }), 1)
})

test('the orb has the surface the overlay drives the avatar through', () => {
  const o = createOrb(fakeEl())
  for (const name of ['update', 'render', 'lookAtNormalized', 'setExpression', 'setMouth', 'setVisemes', 'alphaAt', 'setSize']) assert.equal(typeof o[name], 'function', name)
})

test('size: set from the screen, never smaller than it can be hit', () => {
  const el = fakeEl()
  const o = createOrb(el, { size: 192 })
  assert.equal(el.style.width, '192px')
  assert.equal(o.size(), 192)
  o.setSize(10)
  assert.equal(o.size(), 48)
  assert.equal(el.style.height, '48px')
  o.setSize(150.4)
  assert.equal(el.style.width, '150px')
})

test('it swells with the sound and settles back, and glows more while she speaks', () => {
  const el = fakeEl()
  const o = createOrb(el)
  o.update(0.016); o.render()
  const idle = parseFloat(/scale\(([\d.]+)\)/.exec(el.style.transform)[1])
  const idleGlow = parseFloat(el.vars['--glow'])
  o.setVisemes({ aa: 1 })
  for (let i = 0; i < 12; i++) { o.update(0.016); o.render() }
  const loud = parseFloat(/scale\(([\d.]+)\)/.exec(el.style.transform)[1])
  assert.ok(loud > idle + 0.25, `${loud} vs ${idle}`)
  assert.ok(parseFloat(el.vars['--glow']) > idleGlow + 0.5)
  o.setVisemes({})
  for (let i = 0; i < 60; i++) { o.update(0.016); o.render() }
  assert.ok(parseFloat(/scale\(([\d.]+)\)/.exec(el.style.transform)[1]) < 1.1)
})

test('mood tints it and the cursor nudges the highlight within bounds', () => {
  const el = fakeEl()
  const o = createOrb(el)
  o.setExpression('sad', 1)
  o.render()
  assert.equal(el.vars['--tint'], '70, 120, 230')
  o.lookAtNormalized(1, 1)
  o.render()
  assert.deepEqual([el.vars['--hx'], el.vars['--hy']], ['44.0%', '21.0%'])
  o.lookAtNormalized(99, -99)
  o.render()
  assert.deepEqual([el.vars['--hx'], el.vars['--hy']], ['44.0%', '39.0%'])
})

test('hit test: inside the circle yes, the empty corners of its box no, a hidden orb never', () => {
  const el = fakeEl({ left: 600, top: 400, width: 120, height: 120 })
  const o = createOrb(el)
  assert.equal(o.alphaAt(660, 460), 255)
  assert.equal(o.alphaAt(601, 401), 0)                    // the corner of the square, outside the circle
  assert.equal(o.alphaAt(719, 460), 255)
  assert.equal(o.alphaAt(0, 0), 0)
  el.rect = { left: 0, top: 0, width: 0, height: 0 }
  assert.equal(o.alphaAt(0, 0), 0)
})

test('orb diameter is a share of the screen width, kept between 72 and 360 px', () => {
  const w = (width) => ({ x: 0, y: 0, width, height: 1000 })
  assert.equal(P.orbDiameter(w(1920), 10), 192)
  assert.equal(P.orbDiameter(w(2560), 10), 256)
  assert.equal(P.orbDiameter(w(1000), 10), 100)
  assert.equal(P.orbDiameter(w(400), 10), 72)
  assert.equal(P.orbDiameter(w(5120), 10), 360)
  assert.equal(P.orbDiameter(w(1920), 1), Math.round(1920 * 0.04))          // below 4 percent is raised to 4
  assert.equal(P.orbDiameter(w(1920), 90), 360)                             // above 20 percent is capped (and by the 360 px limit)
  assert.equal(P.orbDiameter(w(1920), undefined), 192)
  assert.equal(P.orbDiameter(w(1920), NaN), 192)
})

test('settings: the orb is the default look, sized at a tenth of the screen', () => {
  assert.deepEqual([S.DEFAULTS.display.style, S.DEFAULTS.display.orbPercent], ['orb', 10])
  assert.deepEqual(S.LOOKS, ['orb', 'avatar'])
  const got = S.sanitize({ display: { style: 'avatar', orbPercent: 14.6 } })
  assert.deepEqual([got.display.style, got.display.orbPercent], ['avatar', 15])
  for (const bad of [[{ style: 'cube' }, 'orb'], [{ style: 7 }, 'orb']]) assert.equal(S.sanitize({ display: bad[0] }).display.style, bad[1])
  assert.equal(S.sanitize({ display: { orbPercent: 1 } }).display.orbPercent, 4)
  assert.equal(S.sanitize({ display: { orbPercent: 99 } }).display.orbPercent, 20)
  assert.equal(S.sanitize({ display: { orbPercent: 'big' } }).display.orbPercent, 10)
  assert.equal(S.sanitize({ display: { orbPercent: NaN } }).display.orbPercent, 10)
  assert.equal(S.applyPatch(S.DEFAULTS, { display: { style: 'avatar' } }).display.style, 'avatar')
})

test('settings panel rows for the look', () => {
  const rows = SECTIONS.flatMap((s) => s.fields).filter((f) => f.path.startsWith('display.'))
  const style = rows.find((f) => f.path === 'display.style')
  assert.deepEqual(style.options.map((o) => o[0]), ['orb', 'avatar'])
  const size = rows.find((f) => f.path === 'display.orbPercent')
  assert.deepEqual([size.type, size.min, size.max], ['range', 4, 20])
  for (const f of rows) assert.notEqual(getPath(S.DEFAULTS, f.path), undefined, f.path)
})
