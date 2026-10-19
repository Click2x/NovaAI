import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createChips, chipLabel } from '../src/ui/chips.js'

const require = createRequire(import.meta.url)
const { createPrivacy } = require('../electron/privacy.js')
const { createTracker, powershellProvider } = require('../electron/windowtrack.js')
const { cropRect, fitSize, captureActiveWindow } = require('../electron/capture.js')

const privacy = createPrivacy()

test('password managers, messengers, banking and private browsing are private', () => {
  for (const [app, title] of [
    ['1Password.exe', '1Password'], ['Bitwarden.exe', ''], ['KeePassXC.exe', 'Database'], ['Discord.exe', '#general'], ['Signal.exe', ''],
    ['chrome.exe', 'Chase Online - Sign in'], ['firefox.exe', 'Bank of America | Online Banking'], ['msedge.exe', 'New tab - [InPrivate]'],
    ['chrome.exe', 'New Incognito tab'], ['firefox.exe', 'Mozilla Firefox Private Browsing'], ['chrome.exe', 'Reset your password'],
    ['consent.exe', ''], ['', 'anything'], [null, null],
  ]) assert.equal(privacy.isPrivate(app, title), true, `${app} / ${title}`)
})

test('ordinary windows are not private', () => {
  for (const [app, title] of [['Code.exe', 'desktop.py - Visual Studio Code'], ['chrome.exe', 'Stack Overflow'], ['explorer.exe', 'Downloads'], ['blender.exe', 'Blender']])
    assert.equal(privacy.isPrivate(app, title), false, `${app} / ${title}`)
})

function makeTracker(ownPid = 99) {
  const changes = []
  const provider = { start() {}, stop() {} }
  const t = createTracker({ provider, privacy, ownPid, onChange: (v) => changes.push(v) })
  return { t, changes }
}

test('a private window never exposes its title or bounds to the backend view', () => {
  const { t, changes } = makeTracker()
  t.handle({ app: 'chrome.exe', title: 'Chase Online - Sign in', pid: 5, bounds: { x: 0, y: 0, width: 800, height: 600 } })
  assert.deepEqual(changes.at(-1), { app: 'chrome.exe', private: true })
  assert.equal(t.latest().title, undefined)
})

test('changes are reported once, and the Nova window in front does not replace the last real one', () => {
  const { t, changes } = makeTracker(99)
  t.handle({ app: 'Code.exe', title: 'a', pid: 5, bounds: null })
  t.handle({ app: 'Code.exe', title: 'a', pid: 5, bounds: null })
  assert.equal(changes.length, 1)
  t.handle({ app: 'electron.exe', title: 'Nova', pid: 99, bounds: null })
  assert.equal(changes.length, 1)
  assert.equal(t.latest().app, 'Code.exe')
  t.handle({ app: 'Code.exe', title: 'b', pid: 5, bounds: null })
  assert.equal(changes.length, 2)
})

test('powershell provider parses lines and keeps partial output until the newline arrives', () => {
  const handlers = {}
  const child = { stdout: { setEncoding() {}, on: (e, f) => { handlers[e] = f } }, on() {}, kill() { child.killed = true } }
  const samples = []
  const p = powershellProvider({ spawnFn: () => child })
  p.start((s) => samples.push(s))
  handlers.data('{"app":"Code","title":"x","pid":7,"x":10,"y":20,"w":800,"h":600}\n{"ap')
  handlers.data('p":"Notepad","title":"y","pid":8,"x":0,"y":0,"w":300,"h":300}\n{}\n')
  assert.deepEqual(samples.map((s) => s && s.app), ['Code', 'Notepad', null])
  assert.deepEqual(samples[0].bounds, { x: 10, y: 20, width: 800, height: 600 })
  p.stop()
  assert.equal(child.killed, true)
})

test('crop rectangle follows the window, clamps to the display and rejects tiny windows', () => {
  assert.deepEqual(cropRect({ x: 100, y: 50, width: 800, height: 600 }, { x: 0, y: 0 }, 1.5, 3840, 2160), { x: 150, y: 75, width: 1200, height: 900 })
  assert.deepEqual(cropRect({ x: -50, y: 0, width: 400, height: 300 }, { x: 0, y: 0 }, 1, 1920, 1080), { x: 0, y: 0, width: 350, height: 300 })
  assert.equal(cropRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0 }, 1, 1920, 1080), null)
  assert.equal(cropRect(null, { x: 0, y: 0 }, 1, 1920, 1080), null)
})

test('fitSize caps the longest side at 1280 and never enlarges', () => {
  assert.deepEqual(fitSize(2560, 1440, 1280), { width: 1280, height: 720 })
  assert.deepEqual(fitSize(800, 600, 1280), { width: 800, height: 600 })
})

// A fake Electron: enough for captureActiveWindow.
function fakeElectron({ onCapture } = {}) {
  const image = (w, h) => ({
    isEmpty: () => false, getSize: () => ({ width: w, height: h }), crop(r) { return image(r.width, r.height) },
    resize(s) { return image(s.width, s.height) }, toJPEG: () => Buffer.from('jpegbytes'),
  })
  const display = { id: 1, scaleFactor: 1, size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  return {
    screen: { screenToDipRect: (_w, r) => r, getDisplayMatching: () => display, getPrimaryDisplay: () => display },
    desktopCapturer: { getSources: async () => { onCapture && onCapture(); return [{ display_id: '1', thumbnail: image(1920, 1080) }] } },
  }
}

test('capture is refused for a private window and the screen is never grabbed', async () => {
  const { t } = makeTracker()
  t.handle({ app: 'Bitwarden.exe', title: 'vault', pid: 5, bounds: { x: 0, y: 0, width: 800, height: 600 } })
  let grabbed = false
  const r = await captureActiveWindow({ ...fakeElectron({ onCapture: () => { grabbed = true } }), tracker: t, privacy })
  assert.deepEqual([r.ok, r.reason, grabbed], [false, 'private', false])
})

test('capture is refused when no window is known', async () => {
  const { t } = makeTracker()
  const r = await captureActiveWindow({ ...fakeElectron(), tracker: t, privacy })
  assert.equal(r.ok, false)
})

test('capture result is dropped if a private window came to the front while the picture was taken', async () => {
  const { t } = makeTracker()
  t.handle({ app: 'Code.exe', title: 'x', pid: 5, bounds: { x: 0, y: 0, width: 800, height: 600 } })
  const e = fakeElectron({ onCapture: () => t.handle({ app: '1Password.exe', title: '', pid: 6, bounds: null }) })
  const r = await captureActiveWindow({ ...e, tracker: t, privacy })
  assert.deepEqual([r.ok, r.reason], [false, 'private'])
})

test('a capture of an ordinary window is cropped, scaled and hides then shows the overlay', async () => {
  const { t } = makeTracker()
  t.handle({ app: 'Code.exe', title: 'x', pid: 5, bounds: { x: 100, y: 100, width: 1600, height: 800 } })
  const calls = []
  const r = await captureActiveWindow({ ...fakeElectron(), tracker: t, privacy, hideOverlay: () => calls.push('hide'), showOverlay: () => calls.push('show') })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['hide', 'show'])
  assert.deepEqual([r.width, r.height, r.cropped], [1280, 640, true])
  assert.equal(Buffer.from(r.jpeg_b64, 'base64').toString(), 'jpegbytes')
})

test('chips: label, show on tool, clear on first sentence', () => {
  assert.equal(chipLabel('web_search'), 'Searching the web')
  assert.equal(chipLabel('some_new_tool'), 'Some new tool...')
  const el = { classList: { toggle(cls, on) { el.shown = on } }, appendChild() {} }
  const doc = { createElement: () => ({ className: '', textContent: '', remove() {} }) }
  const chips = createChips(el, doc)
  chips.tool({ turn_id: 't1', name: 'screen', status: 'start' })
  chips.tool({ turn_id: 't1', name: 'screen' })
  assert.deepEqual(chips.labels(), ['Looking at your screen'])
  assert.equal(el.shown, true)
  chips.clear()
  assert.deepEqual(chips.labels(), [])
  assert.equal(el.shown, false)
})
