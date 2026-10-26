// Phase 13: Code window entry. Wires the agent connection (client.js), the state reducer (model.js) and the view (view.js).
// The main process gives this page its configuration through the preload (`window.novaCode`); the page talks to the agent WebSocket
// directly (loopback, the backend checks the origin).
import * as A from './actions.js'
import { initial, reduce, setConn, addUser } from './model.js'
import { createView } from './view.js'
import { createClient } from './client.js'

const api = window.novaCode
let state = initial()
let view = null, client = null, config = null, scheduled = false, promptSeq = 0

function paint() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => { scheduled = false; view.render(state) })
}

function apply(m) {
  state = reduce(state, m)
  if (m.type === 'started') { client.send(A.sessions()); client.send(A.tree('.')); client.send(A.checkpoints()) }
  if (m.type === 'rewound' || m.type === 'turn_end') { client.send(A.tree('.')); client.send(A.checkpoints()) }     // the agent may have changed files
  if (m.type === 'turn_end') client.send(A.sessions())
  paint()
}

const handlers = {
  onPrompt(text) {
    if (!state.started || state.turn.running) return false          // one turn at a time: the composer is locked while one runs
    const id = 'p' + (++promptSeq)
    if (!client.send(A.prompt(text, id))) return false
    state = addUser(state, text, id)
    paint()
    return true
  },
  onInterrupt() { client.send(A.interrupt()) },
  onMode(mode) { client.send(A.setMode(mode)) },
  onPermission(req, choice, feedback) {
    if (client.send(A.permissionResponse(req, choice, feedback))) { state = { ...state, permissions: state.permissions.filter((p) => p.id !== req.id) }; paint() }
  },
  onPlan(plan, approved, opts) {
    if (client.send(A.planResponse(plan, approved, opts))) { state = { ...state, plan: null }; paint() }
  },
  onRewind(index, scope, force) { client.send(A.rewind(index, scope, force)) },
  onRewindPreview(index) { client.send(A.rewindPreview(index)) },
  onHooksTrust(hash, trust) { client.send(A.hooksTrust(hash, trust)) },
  onTree(path) { client.send(A.tree(path)) },
  onNewSession() { client.restart(null) },
  onResume(id) { client.restart(id) },
  async onPickWorkspace() {
    const picked = await api.pickFolder()
    if (!picked) return
    const res = await api.setWorkspace(picked)
    if (!res || !res.ok) { state = { ...state, error: { code: 'workspace', message: (res && res.error) || 'The backend refused that folder.' } }; paint(); return }
    config.workspace = res.workspace || picked
    client.restart(null)
  },
}

async function main() {
  view = createView(document.getElementById('app'), handlers)
  config = await api.config()
  client = createClient({
    url: config.wsUrl,
    onMessage: apply,
    onState: (c) => { state = setConn(state, c); paint() },
    startOptions: () => ({ workspace: config.workspace || undefined, mode: config.defaultMode || undefined }),
  })
  view.render(state)
  client.connect()
  if (config.smoke) runSmoke()
}

// Test hook: with NOVA_SMOKE_CODE_JS set the main process runs that script in this page (executeJavaScript, so the CSP's no-eval rule is
// untouched) once a session has started; it drives the real controls through `handlers`. Absent in normal use.
function runSmoke() {
  window.__novaCodeSmoke = { handlers, view, ready: () => state.started }
}

main().catch((e) => { document.body.textContent = 'Could not start the Code window: ' + (e && e.message) })
