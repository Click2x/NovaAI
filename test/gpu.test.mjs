// P9: tray GPU submenu (electron/gpu.js) and the Models settings (swap policy). No Electron, no backend: fetch and timers are injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { SECTIONS, getPath, patchFor } from '../src/settings/fields.js'

const require = createRequire(import.meta.url)
const gpu = require('../electron/gpu.js')
const S = require('../electron/settings.js')
const { createTrayRegistry, SECTION } = require('../electron/tray.js')

const STATE = {
  leases: [],
  gpu: { available: true, total_mb: 24576, used_mb: 17000, free_mb: 7576 },
  ollama: { reachable: true, models: [{ name: 'nova-samantha-v1:latest', size_mb: 15780, vram_mb: 16100, context: 32768 }] },
  comfy: { reachable: true, running: 0, pending: 0, progress: null },
  drift: { status: 'ok' },
}
const clone = (o) => JSON.parse(JSON.stringify(o))
const labels = (item) => item.submenu.map((i) => i.label || '---')

test('describe: idle card with the chat model loaded', () => {
  const d = gpu.describe(STATE)
  assert.equal(d.title, 'GPU: 16.6/24.0 GB, Idle')
  assert.deepEqual(d.lines, ['VRAM: 16.6 / 24.0 GB used (7.4 free)', 'Loaded: nova-samantha-v1 (15.7 GB, 32k ctx)'])
  assert.equal(d.exclusive, false)
})

test('describe: nothing loaded, nvidia-smi missing, Ollama down, backend offline', () => {
  const empty = clone(STATE); empty.ollama.models = []
  assert.equal(gpu.describe(empty).title, 'GPU: 16.6/24.0 GB, Empty')
  const nosmi = clone(STATE); nosmi.gpu = { available: false }
  assert.equal(gpu.describe(nosmi).lines[0], 'VRAM: unknown (nvidia-smi unavailable)')
  assert.equal(gpu.describe(nosmi).title, 'GPU: Idle')
  const down = clone(STATE); down.ollama = { reachable: false, models: [] }
  assert.ok(gpu.describe(down).lines.includes('Ollama: not reachable'))
  const off = gpu.describe(null)
  assert.deepEqual([off.title, off.lines], ['GPU', ['No data (backend offline)']])
})

test('describe: a render with ComfyUI step progress, a training lease, an agent swap', () => {
  const r = clone(STATE); r.leases = [{ id: 1, kind: 'render', owner: 'video' }]; r.comfy = { running: 1, pending: 2, progress: { value: 7, max: 20, pct: 35 } }
  const d = gpu.describe(r)
  assert.equal(d.title, 'GPU: 16.6/24.0 GB, Rendering')
  assert.ok(d.lines.includes('Rendering: video'))
  assert.ok(d.lines.includes('ComfyUI: step 7/20 (35%), 2 queued'))
  assert.equal(d.exclusive, true)
  const t = clone(STATE); t.leases = [{ kind: 'training', owner: 'teacher_cycle' }]
  assert.ok(gpu.describe(t).lines.includes('Training: teacher_cycle'))
  const a = clone(STATE); a.leases = [{ kind: 'agent', owner: 'agent', model: 'richardyoung/qwen3.6-27b-abliterated:latest' }]
  assert.ok(gpu.describe(a).lines.includes('Agent task: agent (qwen3.6-27b-abliterated)'))
  const j = clone(STATE); j.comfy = { running: 1, pending: 0, progress: null }                 // a render started outside Nova
  assert.equal(gpu.describe(j).title, 'GPU: 16.6/24.0 GB, ComfyUI busy')
  assert.ok(gpu.describe(j).lines.includes('ComfyUI: rendering'))
})

test('describe: chat and screen leases do not count as a busy card; a drift warning shows', () => {
  const c = clone(STATE); c.leases = [{ kind: 'chat', owner: 'nova' }, { kind: 'screen', owner: 'look' }]
  const d = gpu.describe(c)
  assert.equal(d.exclusive, false)
  assert.ok(d.lines.includes('Screen look: look'))
  assert.ok(!d.lines.some((l) => l.startsWith('Chat')))
  const dr = clone(STATE); dr.drift = { status: 'drifted' }
  assert.ok(gpu.describe(dr).lines.some((l) => l.startsWith('Warning')))
})

test('shortName', () => {
  assert.equal(gpu.shortName('nova-samantha-v1:latest'), 'nova-samantha-v1')
  assert.equal(gpu.shortName('hf.co/QuantFactory/Mistral-Nemo-GGUF:Q4_K_M'), 'Mistral-Nemo-GGUF:Q4_K_M')
  assert.equal(gpu.shortName(undefined), '?')
})

test('menu: actions are off while a job holds the card or the backend is down', () => {
  const acts = []
  const item = gpu.buildItems(STATE, (p) => acts.push(p))[0]
  const free = item.submenu.find((i) => i.label === 'Free GPU (unload models)')
  const load = item.submenu.find((i) => i.label === 'Load chat model now')
  assert.equal(free.enabled, true); assert.equal(load.enabled, true)
  free.click(); load.click()
  assert.deepEqual(acts, ['/api/system/gpu/unload', '/api/system/gpu/load-chat'])
  const busy = clone(STATE); busy.leases = [{ kind: 'training', owner: 't' }]
  const b = gpu.buildItems(busy, () => {})[0].submenu
  assert.equal(b.find((i) => i.label === 'Free GPU (unload models)').enabled, false)
  assert.equal(b.find((i) => i.label === 'Load chat model now').enabled, false)
  const empty = clone(STATE); empty.ollama.models = []
  assert.equal(gpu.buildItems(empty, () => {})[0].submenu.find((i) => i.label === 'Free GPU (unload models)').enabled, false)
  const off = gpu.buildItems(null, () => {})[0].submenu
  assert.equal(off.find((i) => i.label === 'Load chat model now').enabled, false)
  assert.ok(labels(gpu.buildItems(STATE, () => {})[0]).includes('---'))
})

test('fetchGpu: 200 -> object; error, non-JSON, timeout -> null (never throws)', async () => {
  const ok = await gpu.fetchGpu('http://x/', async (url) => { assert.equal(url, 'http://x/api/system/gpu'); return { ok: true, json: async () => STATE } })
  assert.equal(ok, STATE)
  assert.equal(await gpu.fetchGpu('http://x', async () => ({ ok: false })), null)
  assert.equal(await gpu.fetchGpu('http://x', async () => ({ ok: true, json: async () => { throw new Error('bad json') } })), null)
  assert.equal(await gpu.fetchGpu('http://x', () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('a'), { name: 'AbortError' })), 5))), null)
})

test('tray registration: order 35 sits after Screen and before Services; rebuilds only when the shown text changes', async () => {
  const reg = createTrayRegistry()
  reg.registerTraySection(SECTION.SCREEN, () => [{ label: 'screen' }])
  reg.registerTraySection(SECTION.SERVICES, () => [{ label: 'services' }])
  let answer = STATE
  let rebuilds = 0
  const calls = []
  const g = gpu.registerGpu({
    registerTraySection: reg.registerTraySection, getBase: () => 'http://127.0.0.1:8000', rebuildTray: () => { rebuilds++ },
    fetchFn: async (url, opts) => { calls.push([url, opts && opts.method]); return { ok: true, json: async () => answer } },
    setTimer: () => 0, clearTimer: () => {},
  })
  assert.equal(gpu.SECTION_ORDER, 35)
  assert.deepEqual(reg.buildTemplate({}).map((i) => i.label || '---'), ['screen', 'GPU', '---', 'services'])      // no data yet
  await g.refresh()
  assert.equal(rebuilds, 1)
  await g.refresh()
  assert.equal(rebuilds, 1)                                           // same answer: no rebuild
  answer = { ...clone(STATE), leases: [{ kind: 'render', owner: 'video' }] }
  await g.refresh()
  assert.equal(rebuilds, 2)
  const labelsNow = reg.buildTemplate({}).map((i) => i.label || '---')
  assert.deepEqual(labelsNow.filter((l) => l !== '---'), ['screen', 'GPU: 16.6/24.0 GB, Rendering', 'services'])
  assert.ok(!labelsNow.slice(0, 2).includes('---'))                   // Screen (30) and GPU (35) share a group: no separator between them
  g.stop()
})

test('actions post to the backend then refresh; an offline backend gives an empty submenu and no request', async () => {
  const reg = createTrayRegistry()
  const calls = []
  let online = true
  const g = gpu.registerGpu({
    registerTraySection: reg.registerTraySection, getBase: () => 'http://127.0.0.1:8000/', isBackendOnline: () => online, rebuildTray: () => {},
    fetchFn: async (url, opts) => { calls.push([url, (opts && opts.method) || 'GET']); return { ok: true, json: async () => STATE } },
    setTimer: () => 0, clearTimer: () => {},
  })
  await g.refresh()
  const item = reg.buildTemplate({}).find((i) => i.submenu)
  item.submenu.find((i) => i.label === 'Free GPU (unload models)').click()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls.slice(0, 3), [['http://127.0.0.1:8000/api/system/gpu', 'GET'], ['http://127.0.0.1:8000/api/system/gpu/unload', 'POST'], ['http://127.0.0.1:8000/api/system/gpu', 'GET']])
  online = false
  const n = calls.length
  await g.refresh()
  assert.equal(calls.length, n)
  assert.equal(g.getState(), null)
  assert.equal(reg.buildTemplate({}).find((i) => i.submenu).label, 'GPU')
})

// ── settings ──

test('models settings: defaults, validation, patching', () => {
  assert.deepEqual(S.DEFAULTS.models, { agentSwap: 'always', agentModel: '', chatReloadMinutes: 5 })        // D10
  assert.deepEqual(S.sanitize(S.DEFAULTS).models, S.DEFAULTS.models)
  assert.deepEqual(S.sanitize({ models: { agentSwap: 'never', agentModel: ' org/model:27b ', chatReloadMinutes: 12.34 } }).models,
    { agentSwap: 'never', agentModel: 'org/model:27b', chatReloadMinutes: 12.3 })
  for (const bad of [{ agentSwap: 'sometimes' }, { agentSwap: 5 }, { agentModel: 'two words' }, { agentModel: 'a"b' }, { agentModel: 'x'.repeat(201) }, { agentModel: 3 },
    { chatReloadMinutes: 'soon' }, { chatReloadMinutes: NaN }, { chatReloadMinutes: null }]) {
    assert.deepEqual(S.sanitize({ models: bad }).models, S.DEFAULTS.models, JSON.stringify(bad))
  }
  assert.equal(S.sanitize({ models: { chatReloadMinutes: -4 } }).models.chatReloadMinutes, 0)
  assert.equal(S.sanitize({ models: { chatReloadMinutes: 99999 } }).models.chatReloadMinutes, 1440)
  assert.equal(S.sanitize({ models: { agentModel: '' } }).models.agentModel, '')                        // empty is valid: backend default
  assert.deepEqual(S.sanitize({ models: 'junk' }).models, S.DEFAULTS.models)
  const patched = S.applyPatch(S.DEFAULTS, { models: { agentSwap: 'never' } })
  assert.deepEqual(patched.models, { agentSwap: 'never', agentModel: '', chatReloadMinutes: 5 })
})

test('models settings reach the backend as the swap policy; an empty model tag is left out', () => {
  assert.deepEqual(S.gpuPolicy(S.sanitize({})), { agentSwap: 'always', chatReloadMinutes: 5 })
  const eff = S.sanitize({ models: { agentSwap: 'never', agentModel: 'm:1', chatReloadMinutes: 0 } })
  assert.deepEqual(S.toBackend(eff).gpu, { agentSwap: 'never', chatReloadMinutes: 0, agentModel: 'm:1' })
})

test('settings panel: every Models row edits a real setting, is patchable, and the policy is not hardcoded anywhere else', () => {
  const sec = SECTIONS.find((s) => s.title === 'Models')
  assert.ok(sec)
  assert.deepEqual(sec.fields.map((f) => f.path), ['models.agentSwap', 'models.agentModel', 'models.chatReloadMinutes'])
  for (const f of sec.fields) {
    assert.notEqual(getPath(S.DEFAULTS, f.path), undefined, f.path)
    assert.equal(getPath(S.applyPatch(S.DEFAULTS, patchFor(f.path, getPath(S.DEFAULTS, f.path))), f.path), getPath(S.DEFAULTS, f.path))
  }
  assert.deepEqual(sec.fields[0].options.map((o) => o[0]), S.AGENT_SWAPS)
  const range = sec.fields[2]
  assert.deepEqual([range.min, range.max, range.unit, range.decimals], [0, 60, ' min', 0])
})
