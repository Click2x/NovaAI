// Phase 13: the Code window's state, as a pure reducer over the agent protocol v1 (backend/api/agent.py docstring). No DOM, no sockets:
// `reduce(state, msg)` returns the next state, the view renders it, and node --test drives it with message scripts.
// Everything that comes from the backend (model text, tool output, file names, diffs) is data; the view only ever sets it as textContent.

export const MODES = ['default', 'acceptEdits', 'plan', 'bypass']
export const MODE_LABELS = { default: 'Ask before changes', acceptEdits: 'Accept edits', plan: 'Plan first', bypass: 'Bypass permissions' }
export const OUTPUT_MAX = 6000          // characters of one tool result kept for display
export const DIFF_MAX = 20000
export const TEXT_MAX = 60000
export const ITEMS_MAX = 600

const cut = (s, n) => { const t = typeof s === 'string' ? s : s == null ? '' : String(s); return t.length > n ? t.slice(0, n) + `\n... (${t.length - n} more characters not shown)` : t }

export function initial() {
  return {
    conn: 'connecting',           // connecting | open | closed
    started: false,
    session: null,                // { id, workspace, mode, model, toolMode, bypassAllowed, resumed }
    mode: 'default',
    items: [],                    // transcript: user | assistant | tool | notice
    permissions: [],              // pending permission_request messages (oldest first); the view shows the first
    plan: null,                   // pending { id, plan }
    todos: [],
    turn: { running: false, id: null, prompt_index: null },
    gpu: null,                    // { state, reason, holder } while waiting for the card
    sessions: [],
    hooks: null,                  // P14: { enabled, user:[hook], project:[hook], trusted, pending_trust, hash }
    hookRuns: 0,
    agents: [],                   // P14: named sub-agents
    checkpoints: [],              // P14: [{ prompt_index, files, count }]
    preview: null,                // P14: { prompt_index, restore, delete, conflicts } for the rewind chooser
    tree: {},                     // path -> { entries, truncated }
    usage: null,                  // last turn { prompt_tokens, completion_tokens }
    tainted: false,
    error: null,                  // last { code, message }
    seq: 0,
  }
}

function pushItem(s, item) {
  s.items.push({ ...item, key: ++s.seq })
  if (s.items.length > ITEMS_MAX) s.items.splice(0, s.items.length - ITEMS_MAX)
  return s.items[s.items.length - 1]
}

const findTool = (s, id) => { for (let i = s.items.length - 1; i >= 0; i--) if (s.items[i].kind === 'tool' && s.items[i].id === id) return s.items[i]; return null }
const streaming = (s) => { const last = s.items[s.items.length - 1]; return last && last.kind === 'assistant' && last.streaming ? last : null }

// A user prompt typed here: shown at once, given its prompt_index when turn_start arrives.
export function addUser(state, text, prompt_id) {
  const s = clone(state)
  pushItem(s, { kind: 'user', text: cut(text, TEXT_MAX), prompt_id: prompt_id || null, prompt_index: null })
  return s
}

// Shallow-enough copy: items and lists are copied, item objects are copied on write inside reduce.
function clone(state) {
  return { ...state, items: state.items.map((i) => ({ ...i })), permissions: [...state.permissions], todos: [...state.todos], sessions: [...state.sessions], tree: { ...state.tree }, turn: { ...state.turn } }
}

export function setConn(state, conn) {
  const s = { ...state, conn }
  if (conn !== 'open') { s.started = false; s.turn = { running: false, id: null, prompt_index: null }; s.permissions = []; s.plan = null; s.gpu = null }
  return s
}

export function reduce(state, m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return state
  const s = clone(state)
  switch (m.type) {
    case 'started': {
      s.started = true
      s.conn = 'open'
      s.error = null
      s.session = { id: m.session_id, workspace: m.workspace, mode: m.mode, model: m.model || '', toolMode: m.tool_mode || '', bypassAllowed: !!m.bypass_allowed, resumed: !!m.resumed }
      s.mode = MODES.includes(m.mode) ? m.mode : 'default'
      s.items = []; s.permissions = []; s.plan = null; s.todos = []; s.gpu = null; s.tree = {}; s.usage = null
      s.hooks = null; s.hookRuns = 0; s.agents = []; s.checkpoints = []; s.preview = null
      for (const h of Array.isArray(m.history) ? m.history : []) {
        if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue
        pushItem(s, { kind: h.role, text: cut(h.content, TEXT_MAX), prompt_index: Number.isInteger(h.prompt_index) ? h.prompt_index : null, restored: true })
      }
      return s
    }
    case 'sessions': s.sessions = Array.isArray(m.items) ? m.items.filter((x) => x && typeof x.session_id === 'string').slice(0, 50) : []; return s
    case 'hooks': {
      const list = (a) => (Array.isArray(a) ? a.filter((h) => h && typeof h.command === 'string').slice(0, 30).map((h) => ({ event: String(h.event || ''), matcher: String(h.matcher || ''), command: cut(h.command, 300), timeout: h.timeout, source: String(h.source || '') })) : [])
      s.hooks = { enabled: m.enabled !== false, user: list(m.user), project: list(m.project), trusted: !!m.trusted, pending_trust: !!m.pending_trust, hash: typeof m.hash === 'string' ? m.hash : '' }
      return s
    }
    case 'hook': {
      s.hookRuns++
      if (m.blocked || m.failed) {
        const what = m.blocked ? 'blocked' : m.timed_out ? 'timed out' : 'failed'
        pushItem(s, { kind: 'notice', level: 'warn', text: `Hook ${m.event}${m.tool ? ' (' + m.tool + ')' : ''} ${what}${m.output ? ': ' + cut(m.output, 300) : ''}` })
      }
      return s
    }
    case 'agents': s.agents = Array.isArray(m.items) ? m.items.filter((a) => a && typeof a.name === 'string').slice(0, 20).map((a) => ({ name: a.name, description: cut(a.description, 200), source: String(a.source || ''), tools: Array.isArray(a.tools) ? a.tools.map(String) : [] })) : []; return s
    case 'checkpoints': s.checkpoints = Array.isArray(m.items) ? m.items.filter((c) => c && Number.isInteger(c.prompt_index)).slice(-50).map((c) => ({ prompt_index: c.prompt_index, files: Array.isArray(c.files) ? c.files.map(String).slice(0, 50) : [], count: Number(c.count) || 0 })) : []; return s
    case 'rewind_preview': { const l = (a) => (Array.isArray(a) ? a.map(String).slice(0, 100) : []); s.preview = { prompt_index: m.prompt_index, restore: l(m.restore), delete: l(m.delete), conflicts: l(m.conflicts) }; return s }
    case 'tree': if (typeof m.path === 'string') s.tree[m.path] = { entries: Array.isArray(m.entries) ? m.entries : [], truncated: !!m.truncated }; return s
    case 'mode': if (MODES.includes(m.mode)) { s.mode = m.mode; if (s.session) s.session = { ...s.session, mode: m.mode } } return s
    case 'turn_start': {
      s.turn = { running: true, id: m.turn_id, prompt_index: m.prompt_index ?? null }
      s.error = null
      for (let i = s.items.length - 1; i >= 0; i--) {                       // the user line this turn answers
        const it = s.items[i]
        if (it.kind === 'user') { if (it.prompt_index == null && (!m.prompt_id || it.prompt_id === m.prompt_id)) it.prompt_index = m.prompt_index ?? null; break }
      }
      return s
    }
    case 'assistant_delta': {
      let a = streaming(s)
      if (!a) a = pushItem(s, { kind: 'assistant', text: '', streaming: true })
      a.text = cut(a.text + (m.text || ''), TEXT_MAX)
      return s
    }
    case 'assistant': {
      const a = streaming(s)
      const text = cut(m.text, TEXT_MAX)
      if (a) { a.text = text; a.streaming = false; if (!text.trim()) s.items.pop() }
      else if (text.trim()) pushItem(s, { kind: 'assistant', text })
      return s
    }
    case 'tool_use': {
      const a = streaming(s)                                              // markup streamed before a tool call is not a message
      if (a) { a.streaming = false; if (!a.text.trim()) s.items.pop() }
      pushItem(s, { kind: 'tool', id: m.id, name: String(m.name || ''), description: cut(m.description, 2000), input: m.input, status: m.status === 'denied' ? 'denied' : 'pending',
        decision: m.decision || null, parent_id: m.parent_id || null, result: null })
      return s
    }
    case 'permission_request': {
      if (m.kind === 'question') s.permissions.push({ id: m.id, kind: 'question', question: cut(m.question, 4000), options: Array.isArray(m.options) ? m.options.map(String).slice(0, 12) : [], tool_use_id: m.tool_use_id })
      else s.permissions.push({ id: m.id, kind: 'tool', tool_use_id: m.tool_use_id, tool: String(m.tool || ''), description: cut(m.description, 4000), input: m.input,
        diff: cut(m.diff, DIFF_MAX), reason: cut(m.reason, 500), tainted: !!m.tainted, suggested_rule: typeof m.suggested_rule === 'string' ? m.suggested_rule : null, mode: m.mode || null })
      return s
    }
    case 'tool_result': {
      const t = findTool(s, m.tool_use_id)
      s.permissions = s.permissions.filter((p) => p.tool_use_id !== m.tool_use_id)
      const result = { ok: !!m.ok, denied: !!m.denied, output: cut(m.output, OUTPUT_MAX), diff: cut(m.diff, DIFF_MAX), duration_ms: Number.isFinite(m.duration_ms) ? m.duration_ms : null, tainted: !!m.tainted }
      if (t) { t.result = result; t.status = m.denied ? 'denied' : m.ok ? 'done' : 'failed' }
      else pushItem(s, { kind: 'tool', id: m.tool_use_id, name: '', description: '', input: null, status: result.denied ? 'denied' : result.ok ? 'done' : 'failed', decision: null, parent_id: null, result })
      if (m.tainted) s.tainted = true
      return s
    }
    case 'todo': s.todos = Array.isArray(m.todos) ? m.todos.filter((t) => t && typeof t.content === 'string').map((t) => ({ content: cut(t.content, 300), status: t.status })).slice(0, 40) : []; return s
    case 'plan': s.plan = { id: m.id, plan: cut(m.plan, TEXT_MAX), tool_use_id: m.tool_use_id }; return s
    case 'gpu_wait': s.gpu = m.state === 'waiting' ? { state: 'waiting', reason: m.reason || '', holder: m.holder || '' } : null; return s
    case 'compact': pushItem(s, { kind: 'notice', level: 'info', text: `Context ${m.kind === 'summary' ? 'summarised' : 'trimmed'}: ${m.tokens_before} -> ${m.tokens_after} tokens` }); return s
    case 'rewound': {
      if (m.scope === 'conversation' || m.scope === 'both') {
        const at = s.items.findIndex((i) => i.kind === 'user' && i.prompt_index != null && i.prompt_index >= m.prompt_index)
        if (at >= 0) s.items.length = at
      }
      const n = (a) => (Array.isArray(a) ? a.length : 0)
      const conflicts = Array.isArray(m.conflicts) ? m.conflicts : []
      pushItem(s, { kind: 'notice', level: conflicts.length ? 'warn' : 'info', text: `Rewound to prompt ${m.prompt_index} (${m.scope}): ${n(m.restored)} restored, ${n(m.deleted)} deleted` + (conflicts.length ? `; ${conflicts.length} changed since the agent left them and were kept` : ''), conflicts, rewind: { prompt_index: m.prompt_index, scope: m.scope } })
      s.permissions = []; s.plan = null; s.preview = null
      return s
    }
    case 'turn_end': {
      const a = streaming(s)
      if (a) a.streaming = false
      s.turn = { running: false, id: null, prompt_index: m.prompt_index ?? s.turn.prompt_index }
      s.permissions = []; s.plan = null; s.gpu = null
      s.usage = m.usage && typeof m.usage === 'object' ? m.usage : s.usage
      if (typeof m.mode === 'string' && MODES.includes(m.mode)) s.mode = m.mode
      s.tainted = !!m.tainted
      for (const it of s.items) if (it.kind === 'tool' && it.status === 'pending') it.status = 'interrupted'
      if (m.reason === 'error') pushItem(s, { kind: 'notice', level: 'error', text: `The turn failed: ${cut(m.error, 600) || 'unknown error'}` })
      else if (m.reason === 'blocked') pushItem(s, { kind: 'notice', level: 'warn', text: `A hook stopped that prompt: ${cut(m.text, 600) || 'no reason given'}` })
      else if (m.reason === 'interrupted') pushItem(s, { kind: 'notice', level: 'info', text: 'Interrupted' })
      else if (m.reason === 'max_steps') pushItem(s, { kind: 'notice', level: 'warn', text: 'Stopped: the step limit for one turn was reached' })
      return s
    }
    case 'error': s.error = { code: String(m.code || 'error'), message: cut(m.message, 600) }; return s
    default: return state                                                   // pong, unknown additive messages
  }
}

// What the approval card shows for the first pending request, or null.
export function currentApproval(state) {
  const p = state.permissions[0]
  return p || null
}

// Short label for a tool call row: "Edit src/app.js", "Shell: git status".
export function toolTitle(item) {
  const name = item.name || 'tool'
  const d = (item.description || '').replace(/\s+/g, ' ').trim()
  return d ? `${name}: ${d.length > 140 ? d.slice(0, 139) + '…' : d}` : name
}

// What to say about hooks and sub-agents in the footer ('' when there is nothing).
export function wiringLine(state) {
  const bits = []
  const h = state.hooks
  if (h && h.enabled) {
    const active = h.user.length + (h.trusted ? h.project.length : 0)
    if (active) bits.push(`${active} hook${active === 1 ? '' : 's'} active`)
    if (h.pending_trust) bits.push(`${h.project.length} project hook${h.project.length === 1 ? '' : 's'} waiting for your trust`)
  } else if (h && !h.enabled) bits.push('hooks are turned off')
  if (state.agents.length) bits.push('sub-agents: ' + state.agents.map((a) => a.name).join(', '))
  return bits.join('  ·  ')
}

export function statusLine(state) {
  if (state.conn === 'connecting') return 'Connecting...'
  if (state.conn === 'closed') return 'Disconnected'
  if (!state.started) return 'Starting a session...'
  if (state.gpu && state.gpu.state === 'waiting') return state.gpu.holder ? `Waiting for the GPU (${state.gpu.holder})` : 'Waiting for the GPU'
  if (state.plan) return 'Plan ready for review'
  if (state.permissions.length) return 'Waiting for your approval'
  if (state.turn.running) return 'Working...'
  return 'Ready'
}
