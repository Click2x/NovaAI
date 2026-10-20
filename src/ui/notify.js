// Phase 8: the notification centre in the overlay - cards for things that need a decision or a glance (an Idle Mind thought to approve, a reminder
// to mark done or snooze, an alert, a tool call waiting for yes/no, messages that arrived while the app was closed).
// Everything that comes from the backend goes in through textContent, never innerHTML. The card builders and `visibleCards` are pure and
// tested with node --test; createNotifier needs a DOM.

export const MAX_CARDS = 30
export const MAX_SHOWN = 3
const ID_RE = /^[A-Za-z0-9_.:-]{1,40}$/

const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n)

function cleanActions(list, max = 3) {
  const out = []
  for (const a of Array.isArray(list) ? list : []) {
    if (a && typeof a.id === 'string' && ID_RE.test(a.id) && typeof a.label === 'string' && a.label.trim()) out.push({ id: a.id, label: text(a.label, 24) })
    if (out.length === max) break
  }
  return out
}

// A `notify` message from the backend -> a card, or null if it is unusable. Its buttons are sent back as notify_action.
export function cardFromNotify(m) {
  if (!m || typeof m.id !== 'string' || !ID_RE.test(m.id) || typeof m.kind !== 'string' || !ID_RE.test(m.kind)) return null
  const title = text(m.title, 120)
  if (!title) return null
  const ref = m.ref && typeof m.ref === 'object' && !Array.isArray(m.ref) ? m.ref : undefined
  return { id: m.id, kind: m.kind, title, body: text(m.body, 600), actions: cleanActions(m.actions), ref, local: false }
}

// A `confirm` message (a tool call is held and waits for yes/no) -> a card whose buttons answer in ordinary chat text.
// The wording is what the backend's free-text path understands (_TOOL_CONFIRM_YES_RE: a clear yes runs it, anything else cancels).
export const CONFIRM_TEXT = Object.freeze({ yes: 'yes', no: 'no' })
export function cardFromConfirm(m) {
  if (!m || typeof m.turn_id !== 'string') return null
  const what = text(m.description, 300) || text(m.tool, 80).replace(/_/g, ' ')
  if (!what) return null
  return { id: 'confirm', kind: 'confirm', title: 'Nova wants to ' + what, body: '', actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], local: true }
}

// The `catchup` answer -> cards: one for the messages that arrived while the app was closed, one per Idle Mind thought still waiting.
export function cardsFromCatchup(res) {
  const out = []
  const msgs = res && Array.isArray(res.messages) ? res.messages.filter((x) => x && typeof x.text === 'string' && x.text.trim()) : []
  if (msgs.length) {
    const last = msgs[msgs.length - 1]
    out.push({
      id: 'catchup', kind: 'catchup', local: true,
      title: msgs.length === 1 ? 'A message while you were away' : `${msgs.length} messages while you were away`,
      body: text(last.text, 300), actions: [{ id: 'open', label: 'Open history' }, { id: 'dismiss', label: 'Dismiss' }],
    })
  }
  for (const r of res && Array.isArray(res.reviews) ? res.reviews : []) {
    if (!r || !Number.isInteger(r.item_id) || r.item_id <= 0 || typeof r.text !== 'string' || !r.text.trim()) continue
    out.push({ id: `review-${r.item_id}`, kind: 'outreach_review', local: false, title: 'Nova wants to say something', body: text(r.text, 600),
      actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], ref: { item_id: r.item_id } })
  }
  return out
}

// Which cards are on screen: the newest MAX_SHOWN that arrived out loud; every card (up to `limit`) while the list is expanded.
export function visibleCards(cards, expanded, limit = 6) {
  const list = expanded ? cards : cards.filter((c) => !c.quiet)
  return list.slice(-(expanded ? limit : MAX_SHOWN))
}

function el(tag, cls, t) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (t !== undefined) n.textContent = t
  return n
}

// root: a container (class "hot"); send(msg) goes to the backend; local(card, actionId) handles cards with local: true
// (confirm: sends yes/no as chat text; catchup: opens the drawer or dismisses). onChange(list) reports [{ id, title }] to the tray.
export function createNotifier(root, { send, local, onChange = () => {}, lingerMs = 2500, setTimer = setTimeout }) {
  let cards = []
  let expanded = false
  const bell = el('button', 'rb bell', '')
  bell.title = 'Notifications'
  const list = el('div', 'notelist')
  root.append(list, bell)

  function render() {
    list.textContent = ''
    for (const c of visibleCards(cards, expanded)) {
      const card = el('div', 'note ' + c.kind)
      const close = el('button', 'mclose', '×')
      close.title = 'Dismiss'
      close.onclick = () => remove(c.id)
      card.append(close, el('div', 'ntitle', c.title))
      if (c.body) card.append(el('div', 'nbody', c.body))
      if (c.status) card.append(el('div', 'nstatus', c.status))
      else if (c.actions.length) {
        const row = el('div', 'nacts')
        for (const a of c.actions) {
          const b = el('button', 'rb', a.label)
          b.disabled = !!c.pending
          b.onclick = () => act(c, a.id)
          row.append(b)
        }
        card.append(row)
      }
      list.append(card)
    }
    bell.textContent = cards.length ? `🔔 ${cards.length}` : ''
    bell.classList.toggle('show', cards.length > 0)
    root.classList.toggle('show', cards.length > 0)
    onChange(cards.map((c) => ({ id: c.id, title: c.title })))
  }

  function act(card, actionId) {
    if (card.pending) return
    if (card.local) { if (local) local(card, actionId); return }
    card.pending = true
    if (!send({ type: 'notify_action', id: card.id, kind: card.kind, action: actionId, ref: card.ref })) { card.pending = false; card.status = "Can't reach the backend"; render(); linger(card.id) ; return }
    render()
  }

  function linger(id) { setTimer(() => { const c = cards.find((x) => x.id === id); if (c && c.status) remove(id) }, lingerMs) }

  function remove(id) {
    const n = cards.length
    cards = cards.filter((c) => c.id !== id)
    if (cards.length !== n) render()
  }

  bell.onclick = () => { expanded = !expanded; render() }

  return {
    // pop false = quiet hours: the card waits behind the bell instead of appearing.
    add(card, { pop = true } = {}) {
      if (!card) return
      const prev = cards.findIndex((c) => c.id === card.id)
      const next = { ...card, quiet: !pop }
      if (prev >= 0) cards[prev] = next
      else { cards.push(next); if (cards.length > MAX_CARDS) cards.shift() }
      render()
    },
    // The backend's answer to a button: show its message briefly, then drop the card (a refused press is dropped too - the item is gone or decided).
    ack(m) {
      const c = cards.find((x) => x.id === m.id)
      if (!c) return
      c.pending = false
      c.status = text(m.message, 120) || (m.ok ? 'Done' : 'That did not work')
      render()
      linger(c.id)
    },
    remove,
    clear() { cards = []; expanded = false; render() },
    has: (id) => cards.some((c) => c.id === id),
    count: () => cards.length,
    items: () => cards.map((c) => ({ id: c.id, title: c.title })),
  }
}
