// Phase 13: the Code window - protocol reducer, outgoing messages, diff parsing, the connection client (fake socket), the view (fake DOM),
// the main-process module and the agent settings.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { initial, reduce, addUser, setConn, currentApproval, statusLine, toolTitle, OUTPUT_MAX, MODES } from '../src/code/model.js'
import * as A from '../src/code/actions.js'
import { createClient, BACKOFF_MS, PING_MS } from '../src/code/client.js'
import { createView, diffBlock } from '../src/code/view.js'
import { SECTIONS, getPath, patchFor } from '../src/settings/fields.js'

const require = createRequire(import.meta.url)
const settings = require('../electron/settings.js')
const C = require('../electron/code.js')

const run = (msgs, s = initial()) => msgs.reduce((st, m) => reduce(st, m), s)
const STARTED = { type: 'started', session_id: 's1', workspace: 'D:\\ws\\proj', mode: 'default', model: 'qwen', tool_mode: 'native', bypass_allowed: false, resumed: false, history: [], prompt_index: 0 }

// ── reducer ──────────────────────────────────────────────────────────────────────
test('started resets the transcript and seeds history from a resumed session', () => {
  let s = run([STARTED, { type: 'assistant', text: 'old' }])
  s = reduce(s, { ...STARTED, session_id: 's2', resumed: true, history: [{ role: 'user', content: 'hi', prompt_index: 1 }, { role: 'assistant', content: 'hello' }, { role: 'system', content: 'x' }] })
  assert.deepEqual(s.items.map((i) => [i.kind, i.text]), [['user', 'hi'], ['assistant', 'hello']])
  assert.equal(s.items[0].prompt_index, 1)
  assert.equal(s.session.id, 's2'); assert.equal(s.started, true)
})

test('a full turn: user line gets its index, deltas stream into one message, the clean text replaces them', () => {
  let s = run([STARTED])
  s = addUser(s, 'fix the bug', 'p1')
  s = run([{ type: 'turn_start', turn_id: 't1', prompt_id: 'p1', prompt_index: 1 }, { type: 'assistant_delta', turn_id: 't1', text: 'Look' }, { type: 'assistant_delta', turn_id: 't1', text: 'ing <tool>' }], s)
  assert.equal(s.turn.running, true)
  assert.equal(s.items[0].prompt_index, 1)
  assert.equal(s.items.filter((i) => i.kind === 'assistant').length, 1)
  s = run([{ type: 'assistant', turn_id: 't1', text: 'Looking' }, { type: 'turn_end', turn_id: 't1', reason: 'done', text: 'Looking', usage: { prompt_tokens: 5, completion_tokens: 2 }, mode: 'default', tainted: false, prompt_index: 1 }], s)
  assert.equal(s.items[1].text, 'Looking'); assert.equal(s.items[1].streaming, false)
  assert.equal(s.turn.running, false); assert.deepEqual(s.usage, { prompt_tokens: 5, completion_tokens: 2 })
})

test('markup-only streamed text before a tool call does not leave an empty message', () => {
  let s = run([STARTED, { type: 'turn_start', turn_id: 't', prompt_index: 1 }, { type: 'assistant_delta', text: '   ' }, { type: 'tool_use', id: 'c1', name: 'read', input: {}, description: 'Read a.txt', status: 'pending', decision: 'allow' }])
  assert.deepEqual(s.items.map((i) => i.kind), ['tool'])
})

test('tool_use -> permission_request -> tool_result: row status, diff and the request leaving the queue', () => {
  let s = run([STARTED, { type: 'tool_use', id: 'c1', name: 'edit', input: { path: 'a.py' }, description: 'Edit a.py', status: 'pending', decision: 'ask' },
    { type: 'permission_request', id: 'p1', kind: 'tool', tool_use_id: 'c1', tool: 'edit', description: 'Edit a.py', input: {}, diff: '--- a\n+++ b\n@@\n-x\n+y\n', reason: 'edits ask', tainted: false, suggested_rule: 'Edit(a.py)', mode: 'default' }])
  assert.equal(currentApproval(s).id, 'p1'); assert.equal(statusLine(s), 'Waiting for your approval')
  s = reduce(s, { type: 'tool_result', tool_use_id: 'c1', ok: true, denied: false, output: 'done', diff: '+y', duration_ms: 12, tainted: false })
  assert.equal(s.permissions.length, 0)
  assert.equal(s.items[0].status, 'done'); assert.equal(s.items[0].result.duration_ms, 12)
})

test('denied tools, failed tools and a result with no row', () => {
  let s = run([STARTED, { type: 'tool_use', id: 'c1', name: 'shell', input: {}, description: 'rm -rf', status: 'denied', decision: 'deny' }, { type: 'tool_result', tool_use_id: 'c1', ok: false, denied: true, output: 'Denied', diff: '' }])
  assert.equal(s.items[0].status, 'denied')
  s = run([{ type: 'tool_use', id: 'c2', name: 'shell', input: {}, description: 'x', status: 'pending' }, { type: 'tool_result', tool_use_id: 'c2', ok: false, denied: false, output: 'boom' }, { type: 'tool_result', tool_use_id: 'ghost', ok: true, output: '' }], s)
  assert.equal(s.items[1].status, 'failed'); assert.equal(s.items[2].id, 'ghost')
})

test('tool output and diffs are capped', () => {
  const s = run([STARTED, { type: 'tool_use', id: 'c', name: 'shell', input: {}, description: 'x', status: 'pending' }, { type: 'tool_result', tool_use_id: 'c', ok: true, output: 'a'.repeat(OUTPUT_MAX * 3), diff: '' }])
  assert.ok(s.items[0].result.output.length < OUTPUT_MAX + 80)
  assert.match(s.items[0].result.output, /more characters not shown/)
})

test('questions, plans, todos, mode, gpu and compaction', () => {
  let s = run([STARTED, { type: 'permission_request', id: 'q1', kind: 'question', question: 'Which db?', options: ['sqlite', 'postgres'], tool_use_id: 'c' }])
  assert.deepEqual(currentApproval(s).options, ['sqlite', 'postgres'])
  s = run([{ type: 'plan', id: 'pl1', plan: '1. do it', tool_use_id: 'c' }, { type: 'todo', todos: [{ content: 'a', status: 'pending' }, { bogus: 1 }] },
    { type: 'mode', mode: 'acceptEdits' }, { type: 'mode', mode: 'nonsense' }, { type: 'gpu_wait', state: 'waiting', reason: 'render', holder: 'video' },
    { type: 'compact', kind: 'trim', tokens_before: 9000, tokens_after: 5000 }], s)
  assert.equal(s.plan.id, 'pl1'); assert.equal(s.todos.length, 1); assert.equal(s.mode, 'acceptEdits')
  assert.equal(s.gpu.holder, 'video'); assert.match(s.items.at(-1).text, /trimmed: 9000 -> 5000/)
  assert.equal(statusLine(s), 'Waiting for the GPU (video)')
  s = reduce(s, { type: 'gpu_wait', state: 'granted' })
  assert.equal(s.gpu, null); assert.equal(statusLine(s), 'Plan ready for review')
})

test('turn_end clears pending approvals and marks unfinished tools; reasons become notices', () => {
  let s = run([STARTED, { type: 'turn_start', turn_id: 't', prompt_index: 1 }, { type: 'tool_use', id: 'c', name: 'shell', input: {}, description: 'x', status: 'pending' },
    { type: 'permission_request', id: 'p', kind: 'tool', tool_use_id: 'c', tool: 'shell', description: 'x', diff: '', suggested_rule: null },
    { type: 'turn_end', turn_id: 't', reason: 'interrupted', text: '', usage: {}, mode: 'default', tainted: true, prompt_index: 1 }])
  assert.equal(s.permissions.length, 0); assert.equal(s.items[0].status, 'interrupted'); assert.equal(s.items.at(-1).text, 'Interrupted'); assert.equal(s.tainted, true)
  s = reduce(s, { type: 'turn_end', reason: 'error', error: 'model offline', usage: {} })
  assert.match(s.items.at(-1).text, /model offline/); assert.equal(s.items.at(-1).level, 'error')
  s = reduce(s, { type: 'turn_end', reason: 'max_steps', usage: {} })
  assert.match(s.items.at(-1).text, /step limit/)
})

test('rewound drops the conversation from that prompt and reports conflicts', () => {
  let s = run([STARTED], initial())
  for (const i of [1, 2, 3]) s = run([{ type: 'turn_start', turn_id: 't' + i, prompt_index: i }, { type: 'turn_end', reason: 'done', usage: {}, prompt_index: i }], addUser(s, 'q' + i, 'p' + i))
  s = reduce(s, { type: 'rewound', prompt_index: 2, scope: 'both', restored: ['a.txt'], deleted: [], conflicts: ['b.txt'], messages: 2 })
  assert.deepEqual(s.items.filter((i) => i.kind === 'user').map((i) => i.text), ['q1'])
  const n = s.items.at(-1)
  assert.equal(n.level, 'warn'); assert.deepEqual(n.rewind, { prompt_index: 2, scope: 'both' }); assert.match(n.text, /1 changed since/)
  const files = reduce(s, { type: 'rewound', prompt_index: 1, scope: 'files', restored: [], deleted: [], conflicts: [] })
  assert.equal(files.items.filter((i) => i.kind === 'user').length, 1)       // files only: the conversation stays
})

test('connection loss clears anything pending; sessions and tree are stored; unknown messages are ignored', () => {
  let s = run([STARTED, { type: 'permission_request', id: 'p', kind: 'tool', tool_use_id: 'c', tool: 't', description: 'd', diff: '' }, { type: 'plan', id: 'x', plan: 'p' },
    { type: 'sessions', items: [{ session_id: 'a', updated: 'u', first_prompt: 'f' }, { nope: 1 }] }, { type: 'tree', path: '.', entries: [{ name: 'src', type: 'dir' }], truncated: false }])
  assert.equal(s.sessions.length, 1); assert.equal(s.tree['.'].entries[0].name, 'src')
  const closed = setConn(s, 'closed')
  assert.equal(closed.started, false); assert.equal(closed.permissions.length, 0); assert.equal(closed.plan, null)
  assert.equal(statusLine(closed), 'Disconnected')
  assert.equal(reduce(s, { type: 'pong' }), s); assert.equal(reduce(s, null), s); assert.equal(reduce(s, { type: 5 }), s)
  assert.equal(reduce(s, { type: 'error', code: 'busy', message: 'a turn is already running' }).error.code, 'busy')
})

test('the reducer does not mutate the previous state', () => {
  const a = run([STARTED, { type: 'assistant_delta', text: 'x' }])
  const frozen = JSON.stringify(a)
  reduce(a, { type: 'assistant_delta', text: 'more' }); reduce(a, { type: 'tool_use', id: 'c', name: 'n', input: {}, description: 'd' })
  assert.equal(JSON.stringify(a), frozen)
})

test('hostile text is stored as plain strings', () => {
  const s = run([STARTED, { type: 'assistant', text: '<img src=x onerror=alert(1)>' }])
  assert.equal(s.items[0].text, '<img src=x onerror=alert(1)>')
  assert.equal(toolTitle({ name: 'shell', description: 'a\n\nb   c' }), 'shell: a b c')
})

// ── outgoing messages ────────────────────────────────────────────────────────────
test('message builders carry v:1 and only the fields given', () => {
  assert.deepEqual(A.start({}), { v: 1, type: 'start' })
  assert.deepEqual(A.start({ workspace: 'D:\\w', mode: 'plan', resume: 'abc' }), { v: 1, type: 'start', workspace: 'D:\\w', resume: 'abc', mode: 'plan' })
  assert.deepEqual(A.prompt('hi', 'p1'), { v: 1, type: 'prompt', text: 'hi', prompt_id: 'p1' })
  assert.deepEqual(A.tree('.'), { v: 1, type: 'tree' }); assert.deepEqual(A.tree('src'), { v: 1, type: 'tree', path: 'src' })
  assert.deepEqual(A.rewind(3), { v: 1, type: 'rewind', prompt_index: 3, scope: 'both' })
  assert.deepEqual(A.rewind(3, 'files', true), { v: 1, type: 'rewind', prompt_index: 3, scope: 'files', force: true })
  assert.deepEqual(A.setMode('plan'), { v: 1, type: 'set_mode', mode: 'plan' })
})

test('permission responses: once, session, always, deny with feedback, deny always, question', () => {
  const req = { id: 'p1', kind: 'tool', suggested_rule: 'Edit(a.py)' }
  assert.deepEqual(A.permissionResponse(req, 'once'), { v: 1, type: 'permission_response', id: 'p1', decision: 'allow' })
  assert.equal(A.permissionResponse(req, 'session').remember, 'session')
  assert.equal(A.permissionResponse(req, 'always').remember, 'local')
  assert.deepEqual(A.permissionResponse(req, 'deny', 'use sed'), { v: 1, type: 'permission_response', id: 'p1', decision: 'deny', feedback: 'use sed' })
  assert.deepEqual(A.permissionResponse(req, 'deny'), { v: 1, type: 'permission_response', id: 'p1', decision: 'deny' })
  assert.deepEqual(A.permissionResponse(req, 'deny_always', 'no'), { v: 1, type: 'permission_response', id: 'p1', decision: 'deny', remember: 'local', feedback: 'no' })
  assert.deepEqual(A.permissionResponse({ id: 'q', kind: 'question' }, 'answer', 'sqlite'), { v: 1, type: 'permission_response', id: 'q', answer: 'sqlite' })
})

test('remembering is only offered when a rule can cover the call', () => {
  assert.deepEqual(A.approvalChoices({ kind: 'tool', suggested_rule: 'Shell(git status)' }).map((c) => c.id), ['once', 'session', 'always', 'deny', 'deny_always'])
  assert.deepEqual(A.approvalChoices({ kind: 'tool', suggested_rule: null }).map((c) => c.id), ['once', 'deny'])
  assert.match(A.ruleNote({ suggested_rule: 'Edit(a.py)' }), /Rule: Edit\(a\.py\)/)
  assert.match(A.ruleNote({ suggested_rule: null, tainted: true }), /untrusted/i)
  assert.match(A.ruleNote({ suggested_rule: null, tainted: false }), /too broad/)
})

test('plan responses', () => {
  assert.deepEqual(A.planResponse({ id: 'pl' }, true, { mode: 'acceptEdits', feedback: 'ignored' }), { v: 1, type: 'plan_response', id: 'pl', approved: true, mode: 'acceptEdits' })
  assert.deepEqual(A.planResponse({ id: 'pl' }, false, { feedback: 'smaller' }), { v: 1, type: 'plan_response', id: 'pl', approved: false, feedback: 'smaller' })
})

test('diff parsing classifies lines, counts changes and caps the length', () => {
  const d = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n'
  assert.deepEqual(A.parseDiff(d).map((l) => l.kind), ['meta', 'meta', 'hunk', 'ctx', 'del', 'add'])
  assert.deepEqual(A.diffStat(d), { add: 1, del: 1 })
  const big = A.parseDiff('+x\n'.repeat(1000), 50)
  assert.equal(big.length, 51); assert.match(big.at(-1).text, /more lines/)
  assert.deepEqual(A.parseDiff(''), [])
})

// ── the connection client, on a fake socket ──────────────────────────────────────
class FakeSocket {
  static all = []
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.all.push(this) }
  send(t) { this.sent.push(JSON.parse(t)) }
  close() { this.readyState = 3; this.onclose && this.onclose() }
  open() { this.readyState = 1; this.onopen() }
  say(m) { this.onmessage({ data: JSON.stringify(m) }) }
}
function clientRig(opts = {}) {
  FakeSocket.all = []
  const msgs = [], states = [], timers = [], repeats = []
  const c = createClient({
    url: 'ws://127.0.0.1:8000/api/agent/ws', WebSocketImpl: FakeSocket, onMessage: (m) => msgs.push(m), onState: (s) => states.push(s),
    startOptions: () => ({ workspace: 'D:\\ws', mode: 'plan' }),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }, clearTimer: (t) => { if (t) t.cleared = true },
    setRepeat: (fn, ms) => { const t = { fn, ms }; repeats.push(t); return t }, clearRepeat: (t) => { if (t) t.cleared = true },
    ...opts,
  })
  return { c, msgs, states, timers, repeats, sock: () => FakeSocket.all.at(-1) }
}

test('client sends start on open, pings, and passes parsed messages on', () => {
  const r = clientRig()
  r.c.connect(); r.sock().open()
  assert.deepEqual(r.sock().sent[0], { v: 1, type: 'start', workspace: 'D:\\ws', mode: 'plan' })
  assert.equal(r.repeats[0].ms, PING_MS)
  r.repeats[0].fn()
  assert.equal(r.sock().sent.at(-1).type, 'ping')
  r.sock().say({ type: 'started', session_id: 'abc' }); r.sock().onmessage({ data: 'not json' }); r.sock().say({ nope: 1 })
  assert.deepEqual(r.msgs.map((m) => m.type), ['started'])
  assert.deepEqual(r.states, ['connecting', 'open'])
})

test('an unexpected drop reconnects with backoff and resumes the same session', () => {
  const r = clientRig()
  r.c.connect(); r.sock().open(); r.sock().say({ type: 'started', session_id: 'abc' })
  r.sock().close()
  assert.equal(r.states.at(-1), 'closed'); assert.equal(r.timers.at(-1).ms, BACKOFF_MS[0])
  r.timers.at(-1).fn(); r.sock().open()
  assert.equal(r.sock().sent[0].resume, 'abc')
  r.sock().close(); assert.equal(r.timers.at(-1).ms, BACKOFF_MS[0])                     // it connected, so the delay starts over
  r.timers.at(-1).fn(); r.sock().close(); assert.equal(r.timers.at(-1).ms, BACKOFF_MS[1])   // this attempt never opened: it grows
  for (let i = 0; i < 8; i++) { r.timers.at(-1).fn(); r.sock().close() }
  assert.equal(r.timers.at(-1).ms, BACKOFF_MS.at(-1))                                   // capped
})

test('restart(null) starts a fresh session on purpose; restart(id) resumes; close() stops reconnecting', () => {
  const r = clientRig()
  r.c.connect(); r.sock().open(); r.sock().say({ type: 'started', session_id: 'abc' })
  const old = r.sock()
  r.c.restart(null); assert.notEqual(r.sock(), old); r.sock().open()
  assert.equal(r.sock().sent[0].resume, undefined)
  old.say({ type: 'assistant', text: 'ghost' })                                         // events from the old socket are ignored
  assert.equal(r.msgs.filter((m) => m.type === 'assistant').length, 0)
  r.c.restart('older'); r.sock().open(); assert.equal(r.sock().sent[0].resume, 'older')
  const n = r.timers.length
  r.c.close(); r.sock().onclose && r.sock().onclose()
  assert.equal(r.timers.length, n); assert.equal(r.c.isOpen(), false)
})

test('send reports failure when the socket is not open', () => {
  const r = clientRig()
  assert.equal(r.c.send({ a: 1 }), false)
  r.c.connect(); assert.equal(r.c.send({ a: 1 }), false)
  r.sock().open(); assert.equal(r.c.send({ a: 1 }), true)
})

// ── the view, on a minimal fake DOM ──────────────────────────────────────────────
class N {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.style = {}; this.attrs = {}; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0 }
  append(...n) { this.children.push(...n) }
  set textContent(v) { this._text = String(v); if (v === '') this.children = [] }
  get textContent() { return this._text }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out) } return out }
  focus() {}
}
function viewRig() {
  globalThis.document = { createElement: (t) => new N(t) }
  const calls = []
  const h = new Proxy({}, { get: (_, name) => (...a) => { calls.push([name, ...a]); return true } })
  const root = new N('div')
  const view = createView(root, h)
  const find = (cls) => root.all((n) => n.className.split(' ').includes(cls))
  const buttons = (label) => root.all((n) => n.tag === 'button' && (label === undefined || n.textContent === label))
  return { view, root, calls, find, buttons, texts: () => root.all((n) => n.textContent).map((n) => n.textContent) }
}
const APPROVE = { type: 'permission_request', id: 'p1', kind: 'tool', tool_use_id: 'c1', tool: 'edit', description: 'Edit a.py', input: {}, diff: '-x\n+y', reason: 'asks', tainted: false, suggested_rule: 'Edit(a.py)' }

test('the approval card shows the exact description, the diff and the rule, and its buttons answer', () => {
  const r = viewRig()
  r.view.render(run([STARTED, APPROVE]))
  assert.ok(r.texts().includes('Edit a.py')); assert.ok(r.texts().some((t) => t === 'Rule: Edit(a.py)'))
  assert.equal(r.find('diff').length, 1)
  r.buttons('Always allow')[0].onclick()
  assert.deepEqual(r.calls.at(-1).slice(0, 3).map((x, i) => (i === 0 ? x : x.id || x)), ['onPermission', 'p1', 'always'])
  r.buttons('Allow once')[0].onclick()
  assert.equal(r.calls.at(-1)[2], 'once')
})

test('deny opens a feedback box and sends the text', () => {
  const r = viewRig()
  const st = run([STARTED, APPROVE])
  r.view.render(st)
  r.buttons('Deny')[0].onclick()
  const box = r.root.all((n) => n.tag === 'textarea' && n.oninput)[0]
  box.value = 'use a smaller change'; box.oninput()
  r.buttons('Send denial')[0].onclick()
  const call = r.calls.at(-1)
  assert.equal(call[0], 'onPermission'); assert.equal(call[2], 'deny'); assert.equal(call[3], 'use a smaller change')
})

test('a tainted request warns; a request with no rule offers no remember buttons', () => {
  const r = viewRig()
  r.view.render(run([STARTED, { ...APPROVE, tainted: true, suggested_rule: null }]))
  assert.ok(r.texts().some((t) => /Untrusted web content/.test(t)))
  assert.equal(r.buttons('Always allow').length, 0); assert.equal(r.buttons('Allow once').length, 1)
})

test('a question card answers with an option', () => {
  const r = viewRig()
  r.view.render(run([STARTED, { type: 'permission_request', id: 'q', kind: 'question', question: 'Which?', options: ['a', 'b'], tool_use_id: 'c' }]))
  r.buttons('b')[0].onclick()
  assert.deepEqual(r.calls.at(-1).slice(2), ['answer', 'b'])
})

test('the plan card approves with a mode or sends feedback', () => {
  const r = viewRig()
  r.view.render(run([STARTED, { type: 'plan', id: 'pl', plan: '1. x', tool_use_id: 'c' }]))
  r.buttons('Approve and accept edits')[0].onclick()
  assert.deepEqual(r.calls.at(-1)[3], { mode: 'acceptEdits' })
  assert.equal(r.calls.at(-1)[2], true)
  r.buttons('Keep planning...')[0].onclick()
  const box = r.root.all((n) => n.tag === 'textarea' && n.oninput)[0]
  box.value = 'smaller'; box.oninput()
  r.buttons('Send feedback')[0].onclick()
  assert.deepEqual(r.calls.at(-1).slice(2), [false, { feedback: 'smaller' }])
})

test('composer: Enter sends, an empty line does not, the stop button shows while a turn runs', () => {
  const r = viewRig()
  r.view.render(run([STARTED]))
  const ta = r.root.all((n) => n.tag === 'textarea')[0]
  ta.value = '  '; ta.onkeydown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  assert.equal(r.calls.filter((c) => c[0] === 'onPrompt').length, 0)
  ta.value = 'do it'; ta.onkeydown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  assert.deepEqual(r.calls.at(-1), ['onPrompt', 'do it']); assert.equal(ta.value, '')
  ta.value = 'two\nlines'; ta.onkeydown({ key: 'Enter', shiftKey: true, preventDefault() {} })
  assert.equal(r.calls.filter((c) => c[0] === 'onPrompt').length, 1)
  assert.equal(r.find('stop')[0].hidden, true)
  r.view.render(run([{ type: 'turn_start', turn_id: 't', prompt_index: 1 }], run([STARTED])))
  assert.equal(r.find('stop')[0].hidden, false); assert.equal(r.find('send')[0].disabled, true)
  r.find('stop')[0].onclick(); assert.equal(r.calls.at(-1)[0], 'onInterrupt')
})

test('hostile model text and file names are rendered as text, never markup', () => {
  const r = viewRig()
  const evil = '<img src=x onerror=alert(1)>'
  r.view.render(run([STARTED, { type: 'assistant', text: evil }, { type: 'tree', path: '.', entries: [{ name: evil, type: 'file' }] }]))
  assert.ok(r.texts().includes(evil)); assert.ok(r.texts().includes(evil) && r.root.all((n) => n.tag === 'img').length === 0)
  assert.equal(diffBlock('+' + evil).children[0].textContent, '+' + evil)
})

test('the file tree loads a folder on first expand and inserts a file path into the composer', () => {
  const r = viewRig()
  let st = run([STARTED, { type: 'tree', path: '.', entries: [{ name: 'src', type: 'dir' }, { name: 'a.py', type: 'file' }] }])
  r.view.render(st)
  r.find('trow').find((n) => n.textContent.includes('src')).onclick()
  assert.deepEqual(r.calls.at(-1), ['onTree', 'src'])
  r.find('trow').find((n) => n.textContent === 'a.py').onclick()
  assert.equal(r.root.all((n) => n.tag === 'textarea')[0].value, 'a.py ')
})

test('rewind chooser appears only when idle and sends the chosen scope; conflicts offer an overwrite', () => {
  const r = viewRig()
  let st = run([{ type: 'turn_start', turn_id: 't', prompt_index: 1 }, { type: 'turn_end', reason: 'done', usage: {}, prompt_index: 1 }], addUser(run([STARTED]), 'go', 'p1'))
  r.view.render(st)
  r.buttons('Rewind...')[0].onclick()
  r.buttons('Files only')[0].onclick()
  assert.deepEqual(r.calls.at(-1), ['onRewind', 1, 'files', false])
  st = reduce(st, { type: 'rewound', prompt_index: 1, scope: 'files', restored: [], deleted: [], conflicts: ['x.txt'] })
  r.view.render(st)
  r.buttons('Overwrite them anyway')[0].onclick()
  assert.deepEqual(r.calls.at(-1), ['onRewind', 1, 'files', true])
  r.view.render(run([{ type: 'turn_start', turn_id: 't2', prompt_index: 2 }], st))
  assert.equal(r.buttons('Rewind...').length, 0)                                       // not during a turn
})

test('mode selector hides bypass unless the backend allows it', () => {
  const r = viewRig()
  r.view.render(run([STARTED]))
  const sel = r.find('mode')[0]
  assert.equal(sel.children.find((o) => o.value === 'bypass').hidden, true)
  r.view.render(run([{ ...STARTED, bypass_allowed: true }]))
  assert.equal(sel.children.find((o) => o.value === 'bypass').hidden, false)
  assert.deepEqual(MODES, ['default', 'acceptEdits', 'plan', 'bypass'])
})

// ── main-process module ──────────────────────────────────────────────────────────
test('agent ws url and page config come from settings, nothing hardcoded', () => {
  assert.equal(C.agentWsUrl('http://127.0.0.1:8000/'), 'ws://127.0.0.1:8000/api/agent/ws')
  assert.equal(C.agentWsUrl('https://nova.local:9000'), 'wss://nova.local:9000/api/agent/ws')
  const eff = settings.sanitize({ agent: { defaultMode: 'plan', workspace: 'D:\\ws' } })
  assert.deepEqual(C.pageConfig({ httpBase: 'http://127.0.0.1:8123', eff }), { wsUrl: 'ws://127.0.0.1:8123/api/agent/ws', defaultMode: 'plan', workspace: 'D:\\ws', smoke: '' })
})

test('setting the workspace: success, backend refusal, unreachable, bad input', async () => {
  const calls = []
  const ok = async (url, o) => { calls.push([url, o.method, JSON.parse(o.body)]); return { ok: true, status: 200, json: async () => ({ workspace: 'D:\\ws' }) } }
  assert.deepEqual(await C.setWorkspaceOnBackend('http://127.0.0.1:8000/', ' D:\\ws ', ok), { ok: true, workspace: 'D:\\ws' })
  assert.deepEqual(calls[0], ['http://127.0.0.1:8000/api/agent/config', 'PUT', { workspace: 'D:\\ws' }])
  const refuse = async () => ({ ok: false, status: 400, json: async () => ({ detail: 'a drive root or the home folder cannot be a workspace' }) })
  assert.match((await C.setWorkspaceOnBackend('http://x', 'C:\\', refuse)).error, /drive root/)
  assert.equal((await C.setWorkspaceOnBackend('http://x', 'C:\\w', async () => { throw new Error('down') })).error, 'Could not reach the backend.')
  assert.equal((await C.setWorkspaceOnBackend('http://x', '', ok)).ok, false)
  assert.equal((await C.setWorkspaceOnBackend('http://x', 'x'.repeat(300), ok)).ok, false)
  assert.match((await C.setWorkspaceOnBackend('http://x', 'C:\\w', async () => ({ ok: false, status: 500, json: async () => { throw new Error('html') } }))).error, /500/)
})

test('navigation inside the Code window is pinned to its own page', () => {
  const own = ['file:///app/dist/']
  assert.equal(C.allowNavigation('file:///app/dist/code.html', own), true)
  for (const u of ['https://evil.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) assert.equal(C.allowNavigation(u, own), false)
})

test('registerCode: the IPC handlers only answer the Code window, and a saved workspace is mirrored into the settings', async () => {
  const handlers = {}
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn } }
  const sender = { id: 'code' }
  let created = null
  class BW {
    constructor(o) { created = o; this.webContents = sender; this.listeners = {}; sender.on = () => {}; sender.setWindowOpenHandler = () => {} }
    isDestroyed() { return false } show() {} focus() {} loadFile() {} loadURL() {} on() {}
  }
  const saved = []
  const reg = C.registerCode({
    ipcMain, BrowserWindow: BW, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['D:\\picked'] }) }, DEV: false,
    getBase: () => 'http://127.0.0.1:8000', getEff: () => settings.sanitize({}), saveWorkspace: (p) => saved.push(p), distDir: 'C:\\app\\dist', preload: 'C:\\app\\code-preload.js',
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ workspace: 'D:\\picked' }) }), env: {},
  })
  assert.equal((await handlers[C.CONFIG_CHANNEL]()).wsUrl, 'ws://127.0.0.1:8000/api/agent/ws')
  assert.equal(await handlers[C.PICK_CHANNEL]({ sender }), null)                         // no window open yet: refused
  reg.open()
  assert.deepEqual([created.webPreferences.sandbox, created.webPreferences.contextIsolation, created.webPreferences.nodeIntegration], [true, true, false])
  assert.equal(await handlers[C.PICK_CHANNEL]({ sender }), 'D:\\picked')
  assert.equal(await handlers[C.PICK_CHANNEL]({ sender: { id: 'other' } }), null)        // another page cannot use it
  assert.deepEqual(await handlers[C.SET_WS_CHANNEL]({ sender }, 'D:\\picked'), { ok: true, workspace: 'D:\\picked' })
  assert.deepEqual(saved, ['D:\\picked'])
  assert.equal((await handlers[C.SET_WS_CHANNEL]({ sender: { id: 'other' } }, 'D:\\x')).ok, false)
})

// ── settings ─────────────────────────────────────────────────────────────────────
test('agent settings: defaults, validation, bypass is not selectable, workspace is cleaned', () => {
  assert.deepEqual(settings.DEFAULTS.agent, { defaultMode: 'default', workspace: '' })
  assert.deepEqual(settings.sanitize(settings.DEFAULTS), settings.DEFAULTS)
  assert.equal(settings.sanitize({ agent: { defaultMode: 'bypass' } }).agent.defaultMode, 'default')
  assert.equal(settings.sanitize({ agent: { defaultMode: 'acceptEdits' } }).agent.defaultMode, 'acceptEdits')
  assert.equal(settings.sanitize({ agent: { workspace: 'D:\\a"b' } }).agent.workspace, '')
  assert.equal(settings.sanitize({ agent: { workspace: ' D:\\work ' } }).agent.workspace, 'D:\\work')
})

test('a settings file saved before P13 seeds agent.defaultMode from autonomy.mode once', () => {
  assert.equal(settings.sanitize({ autonomy: { mode: 'auto' } }).agent.defaultMode, 'acceptEdits')
  assert.equal(settings.sanitize({ autonomy: { mode: 'plan' } }).agent.defaultMode, 'plan')
  assert.equal(settings.sanitize({ autonomy: { mode: 'ask' } }).agent.defaultMode, 'default')
  assert.equal(settings.sanitize({ autonomy: { mode: 'auto' }, agent: { defaultMode: 'plan' } }).agent.defaultMode, 'plan')      // an explicit choice wins
  const patched = settings.applyPatch(settings.sanitize({ autonomy: { mode: 'auto' } }), { agent: { workspace: 'D:\\w' } })
  assert.deepEqual(patched.agent, { defaultMode: 'acceptEdits', workspace: 'D:\\w' })
})

test('the settings panel has the Code agent rows and no leftover autonomy placeholder', () => {
  const sec = SECTIONS.find((s) => s.title === 'Code agent')
  assert.deepEqual(sec.fields.map((f) => f.path), ['agent.defaultMode', 'agent.workspace'])
  assert.ok(!SECTIONS.some((s) => s.fields.some((f) => f.path === 'autonomy.mode')))
  assert.equal(getPath(settings.DEFAULTS, 'agent.defaultMode'), 'default')
  assert.deepEqual(patchFor('agent.defaultMode', 'plan'), { agent: { defaultMode: 'plan' } })
  assert.ok(!sec.fields[0].options.some(([v]) => v === 'bypass'))
})

// ── P14: hooks, sub-agents, checkpoints in the window ────────────────────────────
import { wiringLine } from '../src/code/model.js'

const HOOKS = { type: 'hooks', enabled: true, user: [{ event: 'Stop', matcher: '', command: 'echo u', timeout: 10, source: 'user' }],
  project: [{ event: 'PreToolUse', matcher: 'write', command: 'echo p', timeout: 10, source: 'project' }], trusted: false, pending_trust: true, hash: 'abc123' }

test('hooks, agents, checkpoints and the rewind preview are stored; a new session clears them', () => {
  let s = run([STARTED, HOOKS, { type: 'agents', items: [{ name: 'reviewer', description: 'reads', tools: ['read'], source: 'user' }, { nope: 1 }] },
    { type: 'checkpoints', items: [{ prompt_index: 2, files: ['a.txt'], count: 1 }, { bad: true }] },
    { type: 'rewind_preview', prompt_index: 2, restore: ['a.txt'], delete: [], conflicts: ['b.txt'] }])
  assert.equal(s.hooks.pending_trust, true); assert.equal(s.hooks.project[0].command, 'echo p'); assert.equal(s.hooks.hash, 'abc123')
  assert.deepEqual(s.agents.map((a) => a.name), ['reviewer']); assert.equal(s.checkpoints.length, 1); assert.deepEqual(s.preview.conflicts, ['b.txt'])
  s = reduce(s, { ...STARTED, session_id: 's2' })
  assert.deepEqual([s.hooks, s.agents, s.checkpoints, s.preview, s.hookRuns], [null, [], [], null, 0])
})

test('hook runs are counted; only blocked or failed ones become transcript notices', () => {
  let s = run([STARTED, { type: 'hook', event: 'PreToolUse', tool: 'shell', blocked: false, failed: false, output: '' }])
  assert.equal(s.hookRuns, 1); assert.equal(s.items.length, 0)
  s = run([{ type: 'hook', event: 'PreToolUse', tool: 'write', blocked: true, failed: false, output: 'no writes today' },
    { type: 'hook', event: 'Stop', blocked: false, failed: true, timed_out: true, output: '' }], s)
  assert.equal(s.hookRuns, 3)
  assert.match(s.items[0].text, /Hook PreToolUse \(write\) blocked: no writes today/); assert.match(s.items[1].text, /Hook Stop timed out/)
})

test('a prompt stopped by a hook ends the turn with a notice', () => {
  const s = run([STARTED, { type: 'turn_start', turn_id: 't', prompt_index: 1 }, { type: 'turn_end', turn_id: 't', reason: 'blocked', text: 'not now', usage: {}, prompt_index: 0 }])
  assert.match(s.items.at(-1).text, /A hook stopped that prompt: not now/); assert.equal(s.turn.running, false)
})

test('wiring line: active hooks, hooks waiting for trust, disabled hooks, sub-agents', () => {
  assert.equal(wiringLine(run([STARTED])), '')
  assert.equal(wiringLine(run([STARTED, HOOKS])), '1 hook active  ·  1 project hook waiting for your trust')
  assert.equal(wiringLine(run([STARTED, { ...HOOKS, trusted: true, pending_trust: false }])), '2 hooks active')
  assert.equal(wiringLine(run([STARTED, { ...HOOKS, enabled: false }])), 'hooks are turned off')
  assert.equal(wiringLine(run([STARTED, { type: 'agents', items: [{ name: 'a' }, { name: 'b' }] }])), 'sub-agents: a, b')
})

test('P14 message builders', () => {
  assert.deepEqual(A.hooksTrust('h', true), { v: 1, type: 'hooks_trust', hash: 'h', trust: true })
  assert.deepEqual(A.hooksTrust('h', 0), { v: 1, type: 'hooks_trust', hash: 'h', trust: false })
  assert.deepEqual(A.checkpoints(), { v: 1, type: 'checkpoints' })
  assert.deepEqual(A.rewindPreview(3), { v: 1, type: 'rewind_preview', prompt_index: 3 })
})

test('the hooks card lists the project commands, trusts the exact hash, and can be left off', () => {
  const r = viewRig()
  r.view.render(run([STARTED, HOOKS]))
  assert.ok(r.texts().some((t) => /hooks that run commands on your PC/.test(t)))
  assert.ok(r.texts().includes('PreToolUse [write]: echo p'))
  r.buttons('Trust these hooks')[0].onclick()
  assert.deepEqual(r.calls.at(-1), ['onHooksTrust', 'abc123', true])
  r.buttons('Keep them off')[0].onclick()
  assert.equal(r.find('card').filter((n) => n.className.includes('hooks')).length, 0)           // dismissed for this set
  r.view.render(run([{ ...HOOKS, hash: 'changed' }], run([STARTED])))                           // an edited set asks again
  assert.equal(r.buttons('Trust these hooks').length, 1)
  r.view.render(run([{ ...HOOKS, trusted: true, pending_trust: false }], run([STARTED])))
  assert.equal(r.buttons('Trust these hooks').length, 0)
})

test('the Changes list opens the rewind chooser, asks for a preview and shows what would change', () => {
  const r = viewRig()
  let st = run([STARTED, { type: 'checkpoints', items: [{ prompt_index: 1, files: ['a.txt'], count: 1 }, { prompt_index: 2, files: ['b.py', 'c.py', 'd.py'], count: 3 }] }])
  r.view.render(st)
  const rows = r.find('cp')
  assert.deepEqual(rows.map((n) => n.textContent), ['Prompt 2: b.py, c.py +1', 'Prompt 1: a.txt'])
  rows[0].onclick()
  assert.deepEqual(r.calls.at(-1), ['onRewindPreview', 2])
  assert.ok(r.texts().includes('Checking what would change...'))
  st = reduce(st, { type: 'rewind_preview', prompt_index: 2, restore: ['b.py'], delete: ['c.py'], conflicts: ['d.py'] })
  r.view.render(st)
  assert.ok(r.texts().includes('Restores: b.py') && r.texts().includes('Deletes: c.py'))
  assert.ok(r.texts().some((t) => t.startsWith('Changed since the agent left them') && t.endsWith('d.py')))
  r.buttons('Files only')[0].onclick()
  assert.deepEqual(r.calls.at(-1), ['onRewind', 2, 'files', false])
})

test('the footer shows hooks and sub-agents', () => {
  const r = viewRig()
  r.view.render(run([STARTED, HOOKS, { type: 'agents', items: [{ name: 'reviewer' }] }]))
  assert.ok(r.find('foot')[0].textContent.includes('1 hook active') && r.find('foot')[0].textContent.includes('sub-agents: reviewer'))
})
