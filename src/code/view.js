// Phase 13: the Code window's DOM. `createView(root, handlers)` returns { render(state), focusComposer(), insertText(text) }.
// Backend-supplied strings (model text, tool output, diffs, file names) only ever go in through textContent. Needs a DOM; the pure parts
// (model.js, actions.js) are what node --test covers, plus this file on a minimal fake DOM.
import { MODES, MODE_LABELS, currentApproval, toolTitle, statusLine, wiringLine } from './model.js'
import { approvalChoices, ruleNote, parseDiff, diffStat } from './actions.js'

const SHOW_ITEMS = 250

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined && text !== null) n.textContent = String(text)
  return n
}
const clear = (n) => { n.textContent = '' }
const baseName = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s }

export function diffBlock(diff) {
  const box = el('div', 'diff')
  for (const l of parseDiff(diff)) box.append(el('div', 'dl ' + l.kind, l.text || ' '))
  return box
}

export function createView(root, h) {
  const expanded = new Set(['.'])
  let last = null
  let followTail = true
  let denyOpen = null          // permission id whose deny-with-feedback box is open
  let rewindOpen = null        // prompt_index whose rewind chooser is open
  let draftFeedback = ''
  let hooksDeclined = null      // the hash of project hooks the user chose to leave off for now
  let sessKey = null, dockKey = null, sideKey = null, bannerKey = null      // skip rebuilding parts the user may be using (an open dropdown, a feedback box) when nothing in them changed

  // ── skeleton ────────────────────────────────────────────────────────────────
  clear(root)
  const header = el('header', 'bar')
  const wsBtn = el('button', 'ws'); wsBtn.title = 'Choose the folder the agent works in'
  wsBtn.onclick = () => h.onPickWorkspace()
  const modeSel = el('select', 'mode'); modeSel.title = 'Permission mode'
  for (const m of MODES) { const o = el('option', null, MODE_LABELS[m]); o.value = m; modeSel.append(o) }
  modeSel.onchange = () => h.onMode(modeSel.value)
  const sessSel = el('select', 'sessions'); sessSel.title = 'Earlier sessions in this folder'
  sessSel.onchange = () => { if (sessSel.value) h.onResume(sessSel.value) }
  const newBtn = el('button', 'newsess', 'New session'); newBtn.onclick = () => h.onNewSession()
  const status = el('span', 'status')
  header.append(wsBtn, modeSel, sessSel, newBtn, status)

  const body = el('div', 'body')
  const side = el('aside', 'tree')
  const mainCol = el('section', 'col')
  const log = el('div', 'log')
  log.onscroll = () => { followTail = log.scrollTop + log.clientHeight >= log.scrollHeight - 40 }
  const banner = el('div', 'banner')                 // project hooks waiting for trust
  const todos = el('div', 'todos')
  const dock = el('div', 'dock')                     // approval / plan card
  const composerBox = el('div', 'composer')
  const ta = el('textarea'); ta.rows = 3; ta.placeholder = 'Describe a task. Enter sends, Shift+Enter adds a line.'
  const send = el('button', 'send', 'Send')
  const stop = el('button', 'stop', 'Stop'); stop.hidden = true
  const meta = el('div', 'foot')
  const submit = () => { const t = ta.value.trim(); if (!t) return; if (h.onPrompt(t) !== false) ta.value = '' }
  send.onclick = submit
  stop.onclick = () => h.onInterrupt()
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }
  composerBox.append(ta, send, stop)
  mainCol.append(banner, log, todos, dock, composerBox, meta)
  body.append(side, mainCol)
  root.append(header, body)

  // ── pieces ──────────────────────────────────────────────────────────────────
  function treeNode(state, path, depth, into) {
    const t = state.tree[path]
    if (!t) { into.append(el('div', 'tleaf dim', 'loading...')); return }
    for (const e of t.entries) {
      const child = path === '.' ? e.name : path + '/' + e.name
      const row = el('div', 'trow ' + e.type)
      row.style.paddingLeft = (8 + depth * 12) + 'px'
      if (e.type === 'dir') {
        const open = expanded.has(child)
        row.textContent = (open ? '▾ ' : '▸ ') + e.name
        row.onclick = () => { if (open) expanded.delete(child); else { expanded.add(child); if (!state.tree[child]) h.onTree(child) } render(last) }
        into.append(row)
        if (open) treeNode(state, child, depth + 1, into)
      } else {
        row.textContent = e.name
        row.title = 'Insert this path into the message'
        row.onclick = () => insertText(child + ' ')
        into.append(row)
      }
    }
    if (t.truncated) into.append(el('div', 'tleaf dim', 'more files not shown'))
  }

  function toolRow(it) {
    const d = el('details', 'tool ' + it.status + (it.parent_id ? ' sub' : ''))
    const sum = el('summary')
    sum.append(el('span', 'dot'), el('span', 'tname', toolTitle(it)))
    if (it.result && it.result.diff) { const st = diffStat(it.result.diff); sum.append(el('span', 'stat add', '+' + st.add), el('span', 'stat del', '-' + st.del)) }
    if (it.status === 'denied') sum.append(el('span', 'tag', 'denied'))
    else if (it.status === 'failed') sum.append(el('span', 'tag bad', 'failed'))
    else if (it.status === 'interrupted') sum.append(el('span', 'tag', 'interrupted'))
    d.append(sum)
    if (it.result) {
      if (it.result.diff) d.append(diffBlock(it.result.diff))
      if (it.result.output) d.append(el('pre', 'out', it.result.output))
      if (it.result.duration_ms != null) d.append(el('div', 'dim', `${it.result.duration_ms} ms`))
    }
    return d
  }

  function rewindChooser(index, state) {
    const box = el('div', 'rewind')
    box.append(el('div', 'dim', `Go back to before prompt ${index}. Shell side effects are not undone.`))
    const pv = state.preview && state.preview.prompt_index === index ? state.preview : null
    if (pv) {
      const lines = []
      if (pv.restore.length) lines.push('Restores: ' + pv.restore.join(', '))
      if (pv.delete.length) lines.push('Deletes: ' + pv.delete.join(', '))
      if (pv.conflicts.length) lines.push('Changed since the agent left them (kept unless you overwrite): ' + pv.conflicts.join(', '))
      if (!lines.length) lines.push('No files changed from there on.')
      for (const l of lines) box.append(el('div', 'pv' + (l.startsWith('Changed') ? ' warn' : ''), l))
    } else box.append(el('div', 'dim', 'Checking what would change...'))
    for (const [scope, label] of [['both', 'Files and conversation'], ['files', 'Files only'], ['conversation', 'Conversation only']]) {
      const b = el('button', null, label); b.onclick = () => { rewindOpen = null; h.onRewind(index, scope, false) }; box.append(b)
    }
    return box
  }

  function userRow(it, state) {
    const row = el('div', 'msg user')
    row.append(el('div', 'who', 'You'), el('div', 'text', it.text))
    if (it.prompt_index != null && !state.turn.running) {
      const rb = el('button', 'link', 'Rewind...')
      rb.onclick = () => { rewindOpen = rewindOpen === it.prompt_index ? null : it.prompt_index; if (rewindOpen !== null) h.onRewindPreview(rewindOpen); render(last) }
      row.append(rb)
      if (rewindOpen === it.prompt_index) row.append(rewindChooser(it.prompt_index, state))
    }
    return row
  }

  function noticeRow(it) {
    const row = el('div', 'notice ' + (it.level || 'info'), it.text)
    if (it.conflicts && it.conflicts.length) {
      const list = el('ul')
      for (const c of it.conflicts.slice(0, 12)) list.append(el('li', null, typeof c === 'string' ? c : JSON.stringify(c)))
      row.append(list)
      const b = el('button', null, 'Overwrite them anyway')
      b.onclick = () => h.onRewind(it.rewind.prompt_index, it.rewind.scope, true)
      row.append(b)
    }
    return row
  }

  function approvalCard(req) {
    const card = el('div', 'card approve' + (req.tainted ? ' tainted' : ''))
    if (req.kind === 'question') {
      card.append(el('div', 'ctitle', 'Nova has a question'), el('div', 'cdesc', req.question))
      const row = el('div', 'crow')
      for (const o of req.options) { const b = el('button', null, o); b.onclick = () => h.onPermission(req, 'answer', o); row.append(b) }
      card.append(row)
      const inp = el('input'); inp.placeholder = 'Or type an answer'
      inp.onkeydown = (e) => { if (e.key === 'Enter' && inp.value.trim()) h.onPermission(req, 'answer', inp.value.trim()) }
      card.append(inp)
      return card
    }
    card.append(el('div', 'ctitle', 'Allow ' + (req.tool || 'this tool') + '?'))
    card.append(el('div', 'cdesc', req.description))
    if (req.reason) card.append(el('div', 'dim', req.reason))
    if (req.tainted) card.append(el('div', 'warn', 'Untrusted web content is in this session. Check this call carefully.'))
    if (req.diff) card.append(diffBlock(req.diff))
    card.append(el('div', 'dim rule', ruleNote(req)))
    const row = el('div', 'crow')
    for (const c of approvalChoices(req)) {
      const b = el('button', 'c-' + c.id, c.label)
      if (c.id === 'deny') b.onclick = () => { denyOpen = denyOpen === req.id ? null : req.id; render(last) }
      else b.onclick = () => h.onPermission(req, c.id)
      row.append(b)
    }
    card.append(row)
    if (denyOpen === req.id) {
      const fb = el('textarea'); fb.rows = 2; fb.placeholder = 'Tell Nova what to do instead (optional)'; fb.value = draftFeedback
      fb.oninput = () => { draftFeedback = fb.value }
      const go = el('button', 'c-deny', 'Send denial')
      go.onclick = () => { const t = draftFeedback.trim(); draftFeedback = ''; denyOpen = null; h.onPermission(req, 'deny', t) }
      card.append(fb, go)
    }
    return card
  }

  function planCard(plan) {
    const card = el('div', 'card plan')
    card.append(el('div', 'ctitle', 'Plan for review'), el('pre', 'planbody', plan.plan))
    const row = el('div', 'crow')
    const ok1 = el('button', null, 'Approve and ask before changes'); ok1.onclick = () => h.onPlan(plan, true, { mode: 'default' })
    const ok2 = el('button', null, 'Approve and accept edits'); ok2.onclick = () => h.onPlan(plan, true, { mode: 'acceptEdits' })
    const no = el('button', 'c-deny', 'Keep planning...')
    no.onclick = () => { denyOpen = denyOpen === plan.id ? null : plan.id; render(last) }
    row.append(ok1, ok2, no)
    card.append(row)
    if (denyOpen === plan.id) {
      const fb = el('textarea'); fb.rows = 2; fb.placeholder = 'What should change in the plan?'; fb.value = draftFeedback
      fb.oninput = () => { draftFeedback = fb.value }
      const go = el('button', null, 'Send feedback')
      go.onclick = () => { const t = draftFeedback.trim(); draftFeedback = ''; denyOpen = null; h.onPlan(plan, false, { feedback: t }) }
      card.append(fb, go)
    }
    return card
  }

  // ── render ──────────────────────────────────────────────────────────────────
  function render(state) {
    last = state
    wsBtn.textContent = state.session ? baseName(state.session.workspace) || state.session.workspace : 'Choose a folder...'
    wsBtn.title = state.session ? state.session.workspace : 'Choose the folder the agent works in'
    modeSel.value = state.mode
    for (const o of modeSel.children) o.hidden = o.value === 'bypass' && !(state.session && state.session.bypassAllowed)
    modeSel.disabled = !state.started
    const sk = state.sessions.map((s) => s.session_id).join(',')
    if (sk !== sessKey) {
      sessKey = sk
      clear(sessSel)
      const first = el('option', null, 'Earlier sessions...'); first.value = ''; sessSel.append(first)
      for (const s of state.sessions) { const o = el('option', null, `${(s.updated || '').slice(0, 16).replace('T', ' ')}  ${(s.first_prompt || '').slice(0, 50)}`); o.value = s.session_id; sessSel.append(o) }
    }
    status.textContent = statusLine(state) + (state.session && state.session.model ? '  ·  ' + state.session.model : '')
    status.className = 'status ' + state.conn

    const tk = JSON.stringify([state.tree, [...expanded], state.checkpoints, rewindOpen, state.preview, state.turn.running])
    if (tk !== sideKey) {
      sideKey = tk
      clear(side)
      side.append(el('div', 'thead', 'Files'))
      treeNode(state, '.', 0, side)
      if (state.checkpoints.length) {                       // P14: where the agent changed files; each is a rewind point
        side.append(el('div', 'thead', 'Changes'))
        const shownUsers = new Set(state.items.filter((i) => i.kind === 'user' && i.prompt_index != null).map((i) => i.prompt_index))
        for (const c of state.checkpoints.slice().reverse()) {
          const row = el('div', 'trow cp', `Prompt ${c.prompt_index}: ${c.files.slice(0, 2).join(', ')}${c.count > 2 ? ` +${c.count - 2}` : ''}`)
          row.title = c.files.join(', ')
          row.onclick = () => { if (state.turn.running) return; rewindOpen = rewindOpen === c.prompt_index ? null : c.prompt_index; if (rewindOpen !== null) h.onRewindPreview(rewindOpen); render(last) }
          side.append(row)
          if (rewindOpen === c.prompt_index && !shownUsers.has(c.prompt_index)) side.append(rewindChooser(c.prompt_index, state))     // not twice when its own message is on screen
        }
      }
    }
    const hk = state.hooks
    const bk = hk && hk.pending_trust && hk.hash !== hooksDeclined ? hk.hash : ''
    if (bk !== bannerKey) {
      bannerKey = bk
      clear(banner)
      if (bk) {
        const card = el('div', 'card hooks')
        card.append(el('div', 'ctitle', 'This folder has hooks that run commands on your PC'), el('div', 'dim', 'They run before and after tool calls, on prompts and at the end of a turn, without asking. Only trust them if you wrote them or read them.'))
        for (const x of hk.project) card.append(el('div', 'cdesc', `${x.event}${x.matcher ? ' [' + x.matcher + ']' : ''}: ${x.command}`))
        const row = el('div', 'crow')
        const yes = el('button', 'c-once', 'Trust these hooks'); yes.onclick = () => h.onHooksTrust(hk.hash, true)
        const no = el('button', null, 'Keep them off'); no.onclick = () => { hooksDeclined = hk.hash; render(last) }
        row.append(yes, no); card.append(row); banner.append(card)
      }
    }

    clear(log)
    if (state.error) log.append(el('div', 'notice error', `${state.error.message || state.error.code}${state.error.code === 'no_workspace' ? ' Choose a workspace folder to begin.' : ''}`))
    const shown = state.items.slice(-SHOW_ITEMS)
    if (state.items.length > shown.length) log.append(el('div', 'dim', `${state.items.length - shown.length} earlier items not shown`))
    for (const it of shown) {
      if (it.kind === 'user') log.append(userRow(it, state))
      else if (it.kind === 'assistant') { const r = el('div', 'msg assistant'); r.append(el('div', 'who', 'Nova'), el('div', 'text', it.text)); log.append(r) }
      else if (it.kind === 'tool') log.append(toolRow(it))
      else if (it.kind === 'notice') log.append(noticeRow(it))
    }
    if (state.turn.running && !state.permissions.length && !state.plan) log.append(el('div', 'working dim', state.gpu ? 'Waiting for the GPU...' : 'Working...'))
    if (followTail) log.scrollTop = log.scrollHeight

    clear(todos)
    if (state.todos.length) {
      todos.append(el('div', 'thead', 'Tasks'))
      for (const t of state.todos) todos.append(el('div', 'todo ' + t.status, (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▶ ' : '○ ') + t.content))
    }

    const req = currentApproval(state)
    const dk = [state.plan && state.plan.id, req && req.id, denyOpen, state.permissions.length].join('|')
    if (dk !== dockKey) {
      dockKey = dk
      clear(dock)
      if (state.plan) dock.append(planCard(state.plan))
      else if (req) {
        dock.append(approvalCard(req))
        if (state.permissions.length > 1) dock.append(el('div', 'dim', `${state.permissions.length - 1} more waiting`))
      }
    }

    const busy = state.turn.running
    ta.disabled = !state.started
    send.disabled = !state.started || busy
    stop.hidden = !busy
    clear(meta)
    const bits = []
    if (state.usage) bits.push(`last turn: ${state.usage.prompt_tokens ?? 0} in / ${state.usage.completion_tokens ?? 0} out tokens`)
    if (state.tainted) bits.push('untrusted web content in this session')
    const wiring = wiringLine(state)
    if (wiring) bits.push(wiring)
    meta.textContent = bits.join('  ·  ')
  }

  function insertText(text) {
    ta.value = ta.value + (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + text
    if (ta.focus) ta.focus()
  }
  return { render, insertText, focusComposer: () => ta.focus && ta.focus() }
}
