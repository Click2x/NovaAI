import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const S = require('../electron/settings.js')
const P = require('../electron/placement.js')

test('defaults are valid and a fixed point of sanitize', () => {
  assert.deepEqual(S.sanitize(S.DEFAULTS), S.DEFAULTS)
  assert.deepEqual(S.sanitize(undefined), S.DEFAULTS)
  assert.deepEqual(S.sanitize('junk'), S.DEFAULTS)
  assert.equal(S.DEFAULTS.app.autostart, false)           // autostart is off by default
  assert.equal(S.DEFAULTS.autonomy.mode, 'ask')           // most cautious mode by default
})

test('invalid values keep the base value, valid ones pass', () => {
  const s = S.sanitize({
    voice: { tts: 'yes', voice: '../x', speed: 9, fastModel: true },
    listen: { micOn: false, echoMode: 'loudspeaker', micDeviceId: 5 },
    screen: { looks: false, scope: 'everything', trackWindow: 'x' },
    autonomy: { mode: 'yolo' },
    app: { autostart: true },
    extra: { evil: 1 },
  })
  assert.equal(s.voice.tts, true)
  assert.equal(s.voice.voice, 'af_heart')
  assert.equal(s.voice.speed, 2)                          // clamped, not rejected
  assert.equal(s.voice.fastModel, true)
  assert.equal(s.listen.micOn, false)
  assert.equal(s.listen.echoMode, 'speakers')
  assert.equal(s.listen.micDeviceId, '')
  assert.equal(s.screen.looks, false)
  assert.equal(s.screen.scope, 'window')
  assert.equal(s.screen.trackWindow, true)
  assert.equal(s.autonomy.mode, 'ask')
  assert.equal(s.app.autostart, true)
  assert.equal(s.extra, undefined)
})

test('speed is clamped and rounded; non numbers are ignored', () => {
  assert.equal(S.sanitize({ voice: { speed: 0.1 } }).voice.speed, 0.5)
  assert.equal(S.sanitize({ voice: { speed: 1.2345 } }).voice.speed, 1.23)
  assert.equal(S.sanitize({ voice: { speed: '1.5' } }).voice.speed, 1)
  assert.equal(S.sanitize({ voice: { speed: NaN } }).voice.speed, 1)
})

test('voice ids look like Kokoro ids', () => {
  for (const v of ['af_heart', 'bm_george', 'am_adam']) assert.equal(S.sanitize({ voice: { voice: v } }).voice.voice, v)
  for (const v of ['', 'Heart', 'af heart', 'af_', '../../etc', 'x'.repeat(40)]) assert.equal(S.sanitize({ voice: { voice: v } }).voice.voice, 'af_heart', v)
})

test('phrase lists: strings or arrays, 1-4 words, deduped, capped; empty means default', () => {
  assert.deepEqual(S.cleanPhrases('Hey Nova, ok nova', ['x']), ['Hey Nova', 'ok nova'])
  assert.deepEqual(S.cleanPhrases(['hey nova', 'HEY NOVA', '  hi   there '], ['x']), ['hey nova', 'hi there'])
  assert.deepEqual(S.cleanPhrases(['a b c d e', '', 5, 'x'.repeat(41)], ['d']), ['d'])
  assert.deepEqual(S.cleanPhrases('', ['d']), ['d'])
  assert.deepEqual(S.cleanPhrases(7, ['d']), ['d'])
  assert.equal(S.cleanPhrases('a,b,c,d,e,f', ['d']).length, 4)
  const s = S.sanitize({ listen: { words: { wake: 'computer', stop: '', sleep: ['night night nova'], bogus: ['x'] } } })
  assert.deepEqual(s.listen.words, { wake: ['computer'], stop: ['nova stop'], sleep: ['night night nova'] })
})

test('applyPatch merges by section and leaves the rest alone', () => {
  const a = S.applyPatch(S.DEFAULTS, { voice: { speed: 1.3 } })
  assert.equal(a.voice.speed, 1.3)
  assert.equal(a.voice.voice, 'af_heart')
  const b = S.applyPatch(a, { listen: { words: { wake: ['yo nova'] } } })
  assert.deepEqual(b.listen.words, { wake: ['yo nova'], stop: ['nova stop'], sleep: ['goodnight nova'] })
  assert.equal(b.voice.speed, 1.3)
  const c = S.applyPatch(b, { voice: { speed: 'fast' }, version: 99, nope: { x: 1 }, screen: 'on' })
  assert.deepEqual(c, b)                                   // nothing valid in the patch
  assert.equal(S.applyPatch(b, null).voice.speed, 1.3)
  assert.notEqual(S.applyPatch(S.DEFAULTS, {}), S.DEFAULTS) // a copy, never the frozen default
})

test('env vars override, lock the field and are not part of stored', () => {
  const stored = S.applyPatch(S.DEFAULTS, { voice: { tts: true, speed: 1.4 } })
  const { settings, locked } = S.effective(stored, { NOVA_TTS: '0', NOVA_ECHO_MODE: 'headphones', NOVA_SCREEN_SCOPE: 'screen', NOVA_VOICE_IN: '0' })
  assert.equal(settings.voice.tts, false)
  assert.equal(settings.voice.speed, 1.4)                  // not overridden
  assert.equal(settings.listen.echoMode, 'headphones')
  assert.equal(settings.listen.micOn, false)
  assert.equal(settings.screen.scope, 'screen')
  assert.deepEqual(locked.sort(), ['listen.echoMode', 'listen.micOn', 'screen.scope', 'voice.tts'])
  assert.equal(stored.voice.tts, true)                     // stored is untouched
})

test('env overrides: bad values are ignored, wake words JSON, truthy forms', () => {
  assert.deepEqual(S.envOverrides({}).locked, [])
  assert.deepEqual(S.envOverrides({ NOVA_ECHO_MODE: 'weird', NOVA_VOICE_SPEED: 'abc', NOVA_WAKE_WORDS: '{not json' }).locked, [])
  const e = S.effective(S.DEFAULTS, { NOVA_WAKE_WORDS: '{"wake":["hey computer"]}', NOVA_FAST_MODEL: '1', NOVA_VOICE_SPEED: '1.5', NOVA_WINDOW_TRACK: '0', NOVA_SCREEN: '0' })
  assert.deepEqual(e.settings.listen.words.wake, ['hey computer'])
  assert.deepEqual(e.settings.listen.words.stop, ['nova stop'])
  assert.equal(e.settings.voice.fastModel, true)
  assert.equal(e.settings.voice.speed, 1.5)
  assert.equal(e.settings.screen.trackWindow, false)
  assert.equal(e.settings.screen.looks, false)
})

test('toBackend matches what backend apply_settings reads', () => {
  const b = S.toBackend(S.effective(S.applyPatch(S.DEFAULTS, { listen: { echoMode: 'headphones' }, voice: { fastModel: true } })).settings)
  assert.deepEqual(Object.keys(b).sort(), ['echo_mode', 'fast_model', 'screen', 'speed', 'tts', 'voice', 'wake_words'])
  assert.equal(b.echo_mode, 'headphones')
  assert.equal(b.fast_model, true)
  assert.deepEqual(b.wake_words, { wake: ['hey nova'], stop: ['nova stop'], sleep: ['goodnight nova'] })
})

test('round trip through a real file; missing and corrupt files give defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-settings-'))
  const file = path.join(dir, 'sub', 'settings.json')
  assert.equal(S.loadFrom(fs, file).status, 'missing')
  const mine = S.applyPatch(S.DEFAULTS, { voice: { voice: 'bf_emma', speed: 0.9 }, app: { autostart: true }, listen: { words: { stop: ['hold on nova'] } } })
  S.saveTo(fs, file, mine)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])   // no stray .tmp
  const back = S.loadFrom(fs, file)
  assert.equal(back.status, 'ok')
  assert.deepEqual(back.settings, mine)
  fs.writeFileSync(file, '{ broken')
  const bad = S.loadFrom(fs, file)
  assert.equal(bad.status, 'corrupt')
  assert.deepEqual(bad.settings, S.DEFAULTS)
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'settings.bad.json'), 'utf8'), '{ broken')
  fs.writeFileSync(file, '[1,2]')
  assert.equal(S.loadFrom(fs, file).status, 'corrupt')
  fs.rmSync(dir, { recursive: true })
})

test('a stored file from an older/hand edited version is repaired field by field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-settings-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ voice: { speed: 99, voice: 'am_adam' }, listen: { echoMode: 'x' }, unknown: 1 }))
  const r = S.loadFrom(fs, file)
  assert.equal(r.status, 'ok')
  assert.equal(r.settings.voice.speed, 2)
  assert.equal(r.settings.voice.voice, 'am_adam')
  assert.equal(r.settings.listen.echoMode, 'speakers')
  fs.rmSync(dir, { recursive: true })
})

test('autostart only registers a packaged app', () => {
  const calls = []
  const app = { setLoginItemSettings: (o) => calls.push(o) }
  assert.deepEqual(S.applyAutostart(app, true, false), { applied: false, reason: 'unpackaged' })
  assert.equal(calls.length, 0)
  assert.deepEqual(S.applyAutostart(app, true, true), { applied: true })
  S.applyAutostart(app, false, true)
  assert.deepEqual(calls, [{ openAtLogin: true }, { openAtLogin: false }])
})

test('placement is sanitized: bad entries dropped, offsets rounded', () => {
  const s = S.sanitize({ placement: { lastDisplay: '2', byDisplay: { '2': { dx: 10.6, dy: 3 }, bad: { dx: 'x', dy: 1 }, '3': null } } })
  assert.deepEqual(s.placement, { lastDisplay: '2', byDisplay: { '2': { dx: 11, dy: 3 } } })
})

// ── per display placement ────────────────────────────────────────────────────────
const SIZE = { width: 420, height: 680 }
const d1 = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const d2 = { id: 2, workArea: { x: 1920, y: -200, width: 2560, height: 1400 } }    // right of d1 and higher
const d3 = { id: 3, workArea: { x: -1280, y: 100, width: 1280, height: 680 } }     // left of d1, negative coordinates

test('default is bottom right with a margin', () => {
  assert.deepEqual(P.boundsFor(d1.workArea, SIZE), { x: 1920 - 420 - 24, y: 1040 - 680, width: 420, height: 680 })
})

test('the window is shrunk and clamped on a small display', () => {
  const small = { x: 0, y: 0, width: 1280, height: 600 }
  const b = P.boundsFor(small, SIZE)
  assert.equal(b.height, 600)
  assert.equal(b.y, 0)
  const tiny = P.boundsFor({ x: 10, y: 10, width: 300, height: 300 }, SIZE, { dx: -500, dy: -500 })
  assert.deepEqual(tiny, { x: 10, y: 10, width: 300, height: 300 })
})

test('saved offsets are clamped back into the work area', () => {
  assert.deepEqual(P.boundsFor(d1.workArea, SIZE, { dx: 5000, dy: 5000 }), { x: 0, y: 0, width: 420, height: 680 })
  assert.deepEqual(P.boundsFor(d1.workArea, SIZE, { dx: -50, dy: -50 }), { x: 1500, y: 360, width: 420, height: 680 })
  assert.deepEqual(P.boundsFor(d1.workArea, SIZE, { dx: NaN, dy: 0 }), P.boundsFor(d1.workArea, SIZE))
})

test('pickDisplay: inside, between displays and far outside', () => {
  const all = [d1, d2, d3]
  assert.equal(P.pickDisplay(all, { x: 100, y: 100 }).id, 1)
  assert.equal(P.pickDisplay(all, { x: 2000, y: 0 }).id, 2)
  assert.equal(P.pickDisplay(all, { x: -100, y: 200 }).id, 3)
  assert.equal(P.pickDisplay(all, { x: 1000, y: 1500 }).id, 1)     // below d1: d1 is nearer than d2
  assert.equal(P.pickDisplay(all, { x: 9999, y: 0 }).id, 2)
  assert.equal(P.pickDisplay([], { x: 0, y: 0 }), null)
})

test('remember then resolve gives back the same bounds, per display', () => {
  const all = [d1, d2, d3]
  let p = P.remember(all, null, { x: 2500, y: 300, width: 420, height: 680 })     // dragged onto d2
  assert.equal(p.lastDisplay, '2')
  assert.deepEqual(p.byDisplay['2'], { dx: 4480 - 2920, dy: 1200 - 980 })
  let r = P.resolve(all, d1, p, SIZE)
  assert.equal(r.display.id, 2)
  assert.deepEqual(r.bounds, { x: 2500, y: 300, width: 420, height: 680 })
  p = P.remember(all, p, { x: 100, y: 200, width: 420, height: 680 })              // then onto d1: d2's spot stays remembered
  assert.equal(p.lastDisplay, '1')
  assert.ok(p.byDisplay['2'])
  assert.deepEqual(P.resolve(all, d1, p, SIZE).bounds, { x: 100, y: 200, width: 420, height: 680 })
  assert.deepEqual(P.boundsFor(d2.workArea, SIZE, p.byDisplay['2']), { x: 2500, y: 300, width: 420, height: 680 })
})

test('unplugged display falls back to the primary; replugged remembers its spot', () => {
  const all = [d1, d2]
  const p = P.remember(all, null, { x: 2500, y: 300, width: 420, height: 680 })
  const without = P.resolve([d1], d1, p, SIZE)
  assert.equal(without.display.id, 1)
  assert.deepEqual(without.bounds, P.boundsFor(d1.workArea, SIZE))
  assert.deepEqual(P.resolve(all, d1, p, SIZE).bounds, { x: 2500, y: 300, width: 420, height: 680 })
})

test('a resolution change keeps her anchored to the corner and on screen', () => {
  const p = P.remember([d1], null, { x: 1400, y: 300, width: 420, height: 680 })   // offset dx 100, dy 60
  const smaller = { id: 1, workArea: { x: 0, y: 0, width: 1280, height: 720 } }
  const r = P.resolve([smaller], smaller, p, SIZE)
  assert.deepEqual(r.bounds, { x: 1280 - 420 - 100, y: 0, width: 420, height: 680 })
})

test('a window dragged half off screen is clamped when remembered', () => {
  const p = P.remember([d1], null, { x: 1800, y: -300, width: 420, height: 680 })
  assert.deepEqual(P.boundsFor(d1.workArea, SIZE, p.byDisplay['1']), { x: 1500, y: 0, width: 420, height: 680 })
})

test('screen looks need window tracking (privacy check) and sanitize never aliases the defaults', () => {
  assert.equal(S.toBackend(S.applyPatch(S.DEFAULTS, { screen: { trackWindow: false } })).screen, false)
  assert.equal(S.toBackend(S.DEFAULTS).screen, true)
  const s = S.sanitize(null)
  s.listen.words.wake.push('x')
  assert.deepEqual(S.DEFAULTS.listen.words.wake, ['hey nova'])
})

// ── settings panel field table ───────────────────────────────────────────────────
import { SECTIONS, patchFor, getPath, parseWords, formatWords } from '../src/settings/fields.js'

test('every panel field edits a real setting and its patch survives applyPatch', () => {
  const all = SECTIONS.flatMap((s) => s.fields)
  assert.ok(all.length >= 14)
  for (const f of all) {
    assert.notEqual(getPath(S.DEFAULTS, f.path), undefined, f.path)
    if (f.type === 'select') for (const [value] of f.options) {
      assert.deepEqual(getPath(S.applyPatch(S.DEFAULTS, patchFor(f.path, value)), f.path), value, `${f.path}=${value}`)
    }
  }
  assert.equal(new Set(all.map((f) => f.path)).size, all.length)
})

test('patchFor / words helpers', () => {
  assert.deepEqual(patchFor('listen.words.wake', ['a']), { listen: { words: { wake: ['a'] } } })
  assert.deepEqual(parseWords(' Hey Nova ,, ok nova\nyo '), ['Hey Nova', 'ok nova', 'yo'])
  assert.equal(formatWords(['a', 'b']), 'a, b')
  assert.deepEqual(S.applyPatch(S.DEFAULTS, patchFor('listen.words.wake', parseWords(''))).listen.words.wake, ['hey nova'])   // empty -> default
})
