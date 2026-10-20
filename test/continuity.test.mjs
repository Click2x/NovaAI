// Phase 7: bubble text paced by playback, media/URL checks, chat mode + NSFW settings and their panel rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createPacer, HOLD_MS, STALL_MS } from '../src/ui/pacing.js'
import { mediaSrc, timeLabel } from '../src/ui/continuity.js'
import { SECTIONS, getPath, patchFor } from '../src/settings/fields.js'

const require = createRequire(import.meta.url)
const settings = require('../electron/settings.js')

// A manual clock: timers run when `tick(ms)` passes their time.
function rig(opts = {}) {
  let now = 0
  let seq = 0
  const timers = new Map()
  const shown = []
  const done = []
  const pacer = createPacer({
    show: (t) => shown.push(t),
    onDone: (id) => done.push(id),
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimer: (id) => timers.delete(id),
    ...opts,
  })
  const tick = (ms) => {
    const end = now + ms
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      timers.delete(next[0])
      next[1].fn()
    }
    now = end
  }
  return { pacer, tick, shown, done, last: () => shown[shown.length - 1], timers }
}

test('speech off: every sentence shows as it arrives and the bubble fades at turn end', () => {
  const r = rig()
  r.pacer.begin('t1', false)
  r.pacer.sentence('t1', 1, 'Hello there.')
  assert.equal(r.last(), 'Hello there.')
  r.pacer.sentence('t1', 2, 'How are you?')
  assert.equal(r.last(), 'Hello there. How are you?')
  assert.deepEqual(r.done, [])
  r.pacer.finish('t1', false)
  assert.deepEqual(r.done, ['t1'])
})

test('speech on: a sentence waits for its audio to start playing', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'First one.')
  r.pacer.sentence('t1', 2, 'Second one.')
  assert.equal(r.last(), '')                       // text is ahead of the voice: nothing shown yet
  r.pacer.audio('t1', 1, 1000)
  r.pacer.audio('t1', 2, 1000)
  r.pacer.started('t1', 1)
  r.tick(2000)
  assert.equal(r.last(), 'First one.')             // the second is still waiting
  r.pacer.ended('t1', 1)
  r.pacer.started('t1', 2)
  r.tick(2000)
  assert.equal(r.last(), 'First one. Second one.')
})

test('the words of a playing sentence come in across its clip and are all up before it ends', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'one two three four five')
  r.pacer.audio('t1', 1, 5000)
  r.pacer.started('t1', 1)
  assert.equal(r.last(), 'one')
  r.tick(900)
  assert.equal(r.last(), 'one two')                // 5 words over 4000 ms: one every 800 ms
  r.tick(1700)
  assert.equal(r.last(), 'one two three four')
  r.tick(800)
  assert.equal(r.last(), 'one two three four five')
})

test('a turn that ends while audio is still playing fades the bubble only after the last sentence', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'Short.')
  r.pacer.audio('t1', 1, 800)
  r.pacer.started('t1', 1)
  r.pacer.finish('t1', false)                      // turn_end arrives mid-sentence
  assert.deepEqual(r.done, [])
  r.pacer.ended('t1', 1)
  assert.deepEqual(r.done, ['t1'])
  assert.equal(r.last(), 'Short.')
})

test('turn_end before the second clip starts does not finish the turn early', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'A.'); r.pacer.sentence('t1', 2, 'B.')
  r.pacer.audio('t1', 1, 500); r.pacer.audio('t1', 2, 500)
  r.pacer.started('t1', 1)
  r.pacer.finish('t1', false)
  r.pacer.ended('t1', 1)
  assert.deepEqual(r.done, [])                     // clip 2 is on its way
  r.pacer.started('t1', 2); r.pacer.ended('t1', 2)
  assert.deepEqual(r.done, ['t1'])
  assert.equal(r.last(), 'A. B.')
})

test('no audio at all (a canned reply, speech failing): text shows at turn end or after the hold', () => {
  let r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'I cannot look right now.')
  assert.equal(r.last(), '')
  r.tick(HOLD_MS + 10)
  assert.equal(r.last(), 'I cannot look right now.')
  r = rig()
  r.pacer.begin('t2', true)
  r.pacer.sentence('t2', 1, 'Quick answer.')
  r.pacer.finish('t2', false)
  assert.equal(r.last(), 'Quick answer.')
  assert.deepEqual(r.done, ['t2'])
})

test('the hold does not run ahead of audio that exists for the turn', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'Long first sentence.')
  r.pacer.sentence('t1', 2, 'Second.')
  r.pacer.audio('t1', 1, 9000)
  r.pacer.started('t1', 1)
  r.tick(HOLD_MS + 500)
  assert.ok(!r.last().includes('Second'))
})

test('a failed synthesis releases the waiting text', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'Said.'); r.pacer.sentence('t1', 2, 'Never spoken.')
  r.pacer.audio('t1', 1, 500)
  r.pacer.started('t1', 1); r.pacer.ended('t1', 1)
  r.pacer.release('t1')
  assert.equal(r.last(), 'Said. Never spoken.')
})

test('an interrupted turn keeps only what was said and fades', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'Spoken part.'); r.pacer.sentence('t1', 2, 'Cut off part.')
  r.pacer.audio('t1', 1, 500); r.pacer.audio('t1', 2, 500)
  r.pacer.started('t1', 1); r.pacer.ended('t1', 1)
  r.pacer.finish('t1', true)
  assert.equal(r.last(), 'Spoken part.')
  assert.deepEqual(r.done, ['t1'])
  r.tick(10000)
  assert.equal(r.last(), 'Spoken part.')            // no timer brings the rest back
})

test('events of another turn are ignored, a new turn clears the old one', () => {
  const r = rig()
  r.pacer.begin('t1', false)
  r.pacer.sentence('t0', 1, 'stale')
  r.pacer.started('t0', 1)
  assert.equal(r.last(), '')
  r.pacer.sentence('t1', 1, 'now')
  r.pacer.begin('t2', false)
  assert.equal(r.last(), '')
})

test('playback that never reports does not leave the bubble up forever', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'Stuck.')
  r.pacer.audio('t1', 1, 500)
  r.pacer.finish('t1', false)
  assert.deepEqual(r.done, [])
  r.tick(STALL_MS + 10)
  assert.equal(r.last(), 'Stuck.')
  assert.deepEqual(r.done, ['t1'])
})

test('a one-word sentence and a clip of unknown length show whole', () => {
  const r = rig()
  r.pacer.begin('t1', true)
  r.pacer.sentence('t1', 1, 'Yes.'); r.pacer.sentence('t1', 2, 'and then some more words')
  r.pacer.audio('t1', 1, 400); r.pacer.audio('t1', 2, NaN)
  r.pacer.started('t1', 1); r.pacer.ended('t1', 1)
  r.pacer.started('t1', 2)
  assert.equal(r.last(), 'Yes. and then some more words')
})

// ── what the overlay will load ───────────────────────────────────────────────

test('mediaSrc only passes the backend image/video routes and small inline images', () => {
  const base = 'http://127.0.0.1:8000/'
  assert.equal(mediaSrc(base, '/api/images/chat/12?v=345'), 'http://127.0.0.1:8000/api/images/chat/12?v=345')
  assert.equal(mediaSrc(base, '/api/videos/clip_1.mp4'), 'http://127.0.0.1:8000/api/videos/clip_1.mp4')
  assert.equal(mediaSrc(base, 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  for (const bad of ['http://evil.example/x.png', '//evil.example/x.png', '/api/other/x', '/api/images/../../etc/passwd', 'javascript:alert(1)',
    'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', '', null, 5, '/api/images/x"onerror="y']) {
    assert.equal(mediaSrc(base, bad), null, String(bad))
  }
  assert.equal(mediaSrc('file:///x', '/api/images/chat/1'), null)       // no usable backend origin
  assert.equal(mediaSrc(undefined, '/api/images/chat/1'), null)
})

test('timeLabel tolerates junk', () => {
  assert.equal(timeLabel('not a date'), '')
  assert.equal(timeLabel(null), '')
  assert.ok(timeLabel(new Date().toISOString()).length > 0)
})

// ── chat mode and NSFW settings ──────────────────────────────────────────────

test('chat defaults: companion, NSFW off', () => {
  assert.deepEqual(settings.DEFAULTS.chat, { mode: 'companion', nsfw: false })
  assert.deepEqual(settings.sanitize({}).chat, { mode: 'companion', nsfw: false })
  assert.deepEqual(settings.sanitize({ chat: 'x' }).chat, { mode: 'companion', nsfw: false })
})

test('chat settings are validated and an invalid value keeps the old one', () => {
  const s = settings.sanitize({ chat: { mode: 'friend', nsfw: true } })
  assert.deepEqual(s.chat, { mode: 'friend', nsfw: true })
  const kept = settings.sanitize({ chat: { mode: 'evil', nsfw: 'yes' } }, s)
  assert.deepEqual(kept.chat, { mode: 'friend', nsfw: true })
  for (const m of settings.CHAT_MODES) assert.equal(settings.sanitize({ chat: { mode: m } }).chat.mode, m)
  assert.deepEqual(settings.CHAT_MODES, ['companion', 'friend', 'assistant', 'buddy'])
})

test('a patch changes one chat field and leaves the other', () => {
  const next = settings.applyPatch(settings.sanitize({}), { chat: { nsfw: true } })
  assert.deepEqual(next.chat, { mode: 'companion', nsfw: true })
  assert.deepEqual(settings.applyPatch(next, { chat: { mode: 'buddy' } }).chat, { mode: 'buddy', nsfw: true })
})

test('chat settings go to the backend, and a mode the backend does not know never does', () => {
  const eff = settings.sanitize({ chat: { mode: 'assistant', nsfw: true } })
  const out = settings.toBackend(eff)
  assert.equal(out.mode, 'assistant')
  assert.equal(out.nsfw, true)
  assert.equal(settings.toBackend(settings.sanitize({})).nsfw, false)
})

test('NOVA_CHAT_MODE and NOVA_NSFW override and lock; a bad mode is ignored', () => {
  const { patch, locked } = settings.envOverrides({ NOVA_CHAT_MODE: 'friend', NOVA_NSFW: '1' })
  assert.deepEqual(patch.chat, { mode: 'friend', nsfw: true })
  assert.deepEqual(locked, ['chat.mode', 'chat.nsfw'])
  assert.deepEqual(settings.envOverrides({ NOVA_CHAT_MODE: 'evil' }).locked, [])
  assert.equal(settings.effective(settings.sanitize({}), { NOVA_NSFW: '0' }).settings.chat.nsfw, false)
  assert.equal(settings.effective(settings.sanitize({ chat: { nsfw: true } }), {}).settings.chat.nsfw, true)
})

test('the panel has rows for both and each maps to a real setting', () => {
  const rows = SECTIONS.flatMap((s) => s.fields).filter((f) => f.path.startsWith('chat.'))
  assert.deepEqual(rows.map((r) => r.path), ['chat.mode', 'chat.nsfw'])
  const defaults = settings.sanitize({})
  for (const r of rows) assert.notEqual(getPath(defaults, r.path), undefined)
  assert.deepEqual(rows[0].options.map((o) => o[0]), settings.CHAT_MODES)
  assert.deepEqual(patchFor('chat.nsfw', true), { chat: { nsfw: true } })
})
