// State of the chat window (pure, tested with node --test). One list of messages; the page renders it with textContent only.
// Events are the desktop protocol's (backend/api/desktop.py): history{messages,has_more}, turn_start, sentence, turn_end, proactive, error.
export const MAX_MESSAGES = 300

export function initialState() {
  return { messages: [], hasMore: false, oldestId: null, net: 'connecting', turn: null, nextLocal: 1 }
}

const clip = (list) => (list.length > MAX_MESSAGES ? list.slice(list.length - MAX_MESSAGES) : list)
const text = (v) => (typeof v === 'string' ? v : '')

// What the user typed: shown at once, marked local until the backend's turn starts.
export function addUser(s, turnId, msg) {
  return { ...s, messages: clip([...s.messages, { key: 'u' + s.nextLocal, role: 'user', text: text(msg), turnId }]), nextLocal: s.nextLocal + 1 }
}

export function applyEvent(s, ev) {
  if (!ev || typeof ev.type !== 'string') return s
  switch (ev.type) {
    case 'history': {
      const rows = (Array.isArray(ev.messages) ? ev.messages : []).filter((m) => m && text(m.text)).map((m) => ({
        key: 'h' + m.id, id: Number.isInteger(m.id) ? m.id : null, role: m.sender === 'user' ? 'user' : 'nova', text: text(m.text),
      }))
      const known = new Set(s.messages.map((m) => m.key))
      const fresh = rows.filter((r) => !known.has(r.key))
      const oldest = rows.length && Number.isInteger(rows[0].id) ? rows[0].id : s.oldestId
      return { ...s, messages: clip([...fresh, ...s.messages]), hasMore: !!ev.has_more, oldestId: oldest }
    }
    case 'turn_start':
      return { ...s, turn: ev.turn_id, messages: clip([...s.messages, { key: 't' + ev.turn_id, role: 'nova', text: '', turnId: ev.turn_id, pending: true }]) }
    case 'sentence': {
      const t = text(ev.text)
      if (!t) return s
      return {
        ...s,
        messages: s.messages.map((m) => (m.turnId === ev.turn_id && m.role === 'nova' ? { ...m, text: m.text ? m.text + ' ' + t : t } : m)),
      }
    }
    case 'turn_end':
      return {
        ...s,
        turn: s.turn === ev.turn_id ? null : s.turn,
        // an interrupted turn that said nothing is dropped; otherwise it is final
        messages: s.messages.flatMap((m) => {
          if (m.turnId !== ev.turn_id || m.role !== 'nova') return [m]
          if (!m.text && ev.interrupted) return []
          return [{ ...m, pending: false, id: Number.isInteger(ev.message_id) ? ev.message_id : m.id }]
        }),
      }
    case 'proactive':
      return text(ev.text) ? { ...s, messages: clip([...s.messages, { key: 'p' + (ev.id || s.nextLocal), role: 'nova', text: text(ev.text), id: Number.isInteger(ev.message_id) ? ev.message_id : null }]), nextLocal: s.nextLocal + 1 } : s
    case 'error':
      return { ...s, turn: null, messages: clip([...s.messages.filter((m) => !(m.pending && !m.text)), { key: 'e' + s.nextLocal, role: 'note', text: 'Something went wrong: ' + text(ev.message).slice(0, 200) }]), nextLocal: s.nextLocal + 1 }
    default:
      return s
  }
}

export function setNet(s, status) {
  return s.net === status ? s : { ...s, net: status }
}
