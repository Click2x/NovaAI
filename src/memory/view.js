// Draws the memory window from a state object. Text always goes in through textContent, never as HTML: a remembered sentence came from a
// conversation and must not be able to put markup on the page.
import { KINDS, ago, groupFacts, headline, kindOf, sourceLabel } from './model.js'

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids) if (kid) n.append(kid)
  return n
}

export function kindSelect(select) {
  select.replaceChildren(...KINDS.map((k) => el('option', { value: k.id, text: k.label })))
}

// state: { facts, query, editing (id|null), error, notice: {text, undo?}|null, offline, autoLearn, confirmClear, now }
// on: { edit(id), cancel(), save(id, text, kind), remove(id), undo(), dismiss() }
export function render(root, refs, state, on) {
  const groups = groupFacts(state.facts, state.query)
  const shown = groups.reduce((n, g) => n + g.facts.length, 0)
  refs.headline.textContent = state.offline ? 'I cannot reach my memory right now.' : headline(state.facts.length, shown, state.query)
  refs.learn.checked = !!state.autoLearn
  refs.clear.textContent = state.confirmClear ? 'Yes, forget everything' : 'Forget everything'
  refs.clear.classList.toggle('sure', !!state.confirmClear)
  refs.clear.disabled = !state.facts.length

  const n = state.error ? { text: state.error, error: true } : state.notice
  refs.notice.hidden = !n
  refs.notice.className = n && n.error ? 'error' : ''
  refs.notice.replaceChildren()
  if (n) {
    refs.notice.append(el('span', { text: n.text }))
    if (n.undo) refs.notice.append(el('button', { class: 'btn small', type: 'button', text: 'Undo', onclick: on.undo }))
  }

  const list = []
  if (state.offline) list.push(el('p', { class: 'empty', text: 'My backend is not answering. It starts with the app; try again in a moment.' }))
  else if (!shown) list.push(el('p', { class: 'empty', text: state.facts.length ? 'Nothing matches that search.' : 'Tell me something above, or just talk to me: I will keep what matters.' }))
  for (const g of groups) {
    list.push(el('div', { class: 'group' }, el('h2', { text: g.label }), ...g.facts.map((f) => (f.id === state.editing ? editRow(f, on) : factRow(f, state.now, on)))))
  }
  refs.list.replaceChildren(...list)
}

function factRow(f, now, on) {
  const meta = [sourceLabel(f.source), ago(f.updated, now)].filter(Boolean).join(' - ')
  return el('div', { class: 'fact' },
    el('div', { class: 'what' }, el('span', { text: f.text }), el('span', { class: 'meta', text: meta })),
    el('div', { class: 'acts' },
      el('button', { class: 'btn small', type: 'button', text: 'Edit', onclick: () => on.edit(f.id) }),
      el('button', { class: 'btn small quiet', type: 'button', text: 'Delete', 'aria-label': `Delete: ${f.text}`, onclick: () => on.remove(f.id) })))
}

function editRow(f, on) {
  const input = el('input', { type: 'text', maxlength: 400, value: f.text, 'aria-label': 'What I remember' })
  input.value = f.text
  const kind = el('select', { 'aria-label': 'What kind of thing is it' })
  kindSelect(kind)
  kind.value = kindOf(f)
  const save = () => on.save(f.id, input.value, kind.value)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') on.cancel() })
  queueMicrotask(() => input.focus())
  return el('div', { class: 'fact editing' }, input, kind,
    el('div', { class: 'acts' },
      el('button', { class: 'btn small primary', type: 'button', text: 'Save', onclick: save }),
      el('button', { class: 'btn small quiet', type: 'button', text: 'Cancel', onclick: on.cancel })))
}
