// GPU submenu in the tray (roadmap P9): what the backend GPU arbiter says is loaded and running, plus two actions (free the GPU, load the
// chat model). Reads GET <backend>/api/system/gpu (loopback only), so it works only against a backend on this machine. Registered with
// registerTraySection, so main.js only wires it. Pure formatting is exported for node --test; fetch and timers are injected.
const POLL_MS = 15000
const FETCH_TIMEOUT_MS = 4000
const GB = 1024

const SECTION_ORDER = 35          // between Screen (30) and Services (40); the tens digit is Screen's, so no extra separator

const gb = (mb) => (mb / GB).toFixed(1)
// "nova-samantha-v1:latest" -> "nova-samantha-v1"; "hf.co/x/y:Q4_K_M" -> "y:Q4_K_M"
function shortName(name) {
  const s = String(name || '?')
  const tail = s.split('/').pop()
  return tail.endsWith(':latest') ? tail.slice(0, -7) : tail
}

const KIND_LABEL = { render: 'Rendering', agent: 'Agent task', graph: 'Memory graph write', training: 'Training', idle: 'Idle job', screen: 'Screen look', chat: 'Chat' }

// The text lines of the submenu for one /api/system/gpu answer (or null = backend unreachable / not asked yet).
function describe(state) {
  if (!state) return { title: 'GPU', lines: ['No data (backend offline)'], busy: false, exclusive: false }
  const lines = []
  const g = state.gpu || {}
  if (g.available) lines.push(`VRAM: ${gb(g.used_mb)} / ${gb(g.total_mb)} GB used (${gb(g.free_mb)} free)`)
  else lines.push('VRAM: unknown (nvidia-smi unavailable)')
  const models = (state.ollama && state.ollama.models) || []
  if (state.ollama && state.ollama.reachable === false) lines.push('Ollama: not reachable')
  else if (!models.length) lines.push('Loaded: nothing')
  else for (const m of models.slice(0, 4)) lines.push(`Loaded: ${shortName(m.name)} (${gb(m.vram_mb || m.size_mb)} GB${m.context ? `, ${Math.round(m.context / 1024)}k ctx` : ''})`)
  const leases = (state.leases || []).filter((l) => l.kind !== 'chat')
  for (const l of leases.slice(0, 3)) lines.push(`${KIND_LABEL[l.kind] || l.kind}: ${l.owner}${l.model ? ` (${shortName(l.model)})` : ''}`)
  const c = state.comfy || {}
  if (c.running || c.pending) {
    const p = c.progress
    lines.push(p && p.max ? `ComfyUI: step ${p.value}/${p.max} (${p.pct}%)${c.pending ? `, ${c.pending} queued` : ''}`
      : `ComfyUI: ${c.running ? 'rendering' : 'queued'}${c.pending ? `, ${c.pending} queued` : ''}`)
  }
  if (state.drift && state.drift.status === 'drifted') lines.push('Warning: orphaned model runner holds VRAM (restart Ollama)')
  const exclusive = (state.leases || []).some((l) => l.kind !== 'chat' && l.kind !== 'screen')
  const busy = exclusive || !!(c.running || c.pending)
  const head = exclusive ? KIND_LABEL[leases.find((l) => l.kind !== 'screen').kind] : busy ? 'ComfyUI busy' : models.length ? 'Idle' : 'Empty'
  return { title: g.available ? `GPU: ${gb(g.used_mb)}/${gb(g.total_mb)} GB, ${head}` : `GPU: ${head}`, lines, busy, exclusive }
}

// Menu items for the "GPU" section. `act(path)` posts to the backend; both actions are off while a job holds the card or the backend is down.
function buildItems(state, act) {
  const d = describe(state)
  const actionsOk = !!state && !d.exclusive
  return [{
    label: d.title,
    submenu: [
      ...d.lines.map((label) => ({ label, enabled: false })),
      { type: 'separator' },
      { label: 'Free GPU (unload models)', enabled: actionsOk && ((state.ollama && state.ollama.models) || []).length > 0, click: () => act('/api/system/gpu/unload') },
      { label: 'Load chat model now', enabled: actionsOk, click: () => act('/api/system/gpu/load-chat') },
    ],
  }]
}

async function fetchGpu(base, fetchFn = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchFn(String(base).replace(/\/+$/, '') + '/api/system/gpu', { signal: ctl.signal })
    if (!r.ok) return null
    const j = await r.json()
    return j && typeof j === 'object' ? j : null
  } catch { return null } finally { clearTimeout(t) }
}

// deps: { registerTraySection, getBase, isBackendOnline, rebuildTray, fetchFn, setTimer, clearTimer }
function registerGpu(deps) {
  const { registerTraySection, getBase, isBackendOnline = () => true, rebuildTray, fetchFn, setTimer = setTimeout, clearTimer = clearTimeout } = deps
  let state = null
  let last = ''
  let timer = null
  let stopped = true

  async function refresh() {
    const next = isBackendOnline() ? await fetchGpu(getBase(), fetchFn) : null
    // The menu is rebuilt only when what it shows changes (not on every poll).
    const key = JSON.stringify(next ? describe(next) : null) + JSON.stringify(next && next.ollama && next.ollama.models && next.ollama.models.length)
    state = next
    if (key !== last) { last = key; rebuildTray() }
    return next
  }
  async function act(p) {
    try { await (fetchFn || globalThis.fetch)(String(getBase()).replace(/\/+$/, '') + p, { method: 'POST' }) } catch { /* the next poll shows the result */ }
    await refresh()
  }
  function schedule() {
    clearTimer(timer)
    if (!stopped) timer = setTimer(async () => { await refresh(); schedule() }, POLL_MS)
  }
  registerTraySection(SECTION_ORDER, () => buildItems(state, act))
  return {
    start() { stopped = false; refresh().then(schedule) },
    stop() { stopped = true; clearTimer(timer) },
    refresh,
    getState: () => state,
  }
}

module.exports = { SECTION_ORDER, describe, buildItems, fetchGpu, registerGpu, shortName }
