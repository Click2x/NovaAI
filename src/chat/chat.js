// The chat window's page: its own connection to the desktop WebSocket (text only: speech is switched off for this connection, the avatar
// window does the talking), history on open, a message list and an input. Every backend string goes in through textContent.
import { createSocket } from '../net/socket.js'
import { createEvents } from '../net/events.js'
import { initialState, addUser, applyEvent, setNet } from './model.js'

const $ = (id) => document.getElementById(id)
const list = $('list')
const field = $('field')
const statusEl = $('status')

async function boot() {
  const config = await window.novaChat.getConfig()
  let state = initialState()
  let socket = null
  const events = createEvents()

  function render() {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    list.textContent = ''
    if (state.hasMore) {
      const more = document.createElement('button')
      more.className = 'more'
      more.textContent = 'Load older'
      more.onclick = () => socket && socket.history(state.oldestId)
      list.append(more)
    }
    for (const m of state.messages) {
      const row = document.createElement('div')
      row.className = 'msg ' + m.role + (m.pending ? ' pending' : '')
      row.textContent = m.text || (m.pending ? '...' : '')
      list.append(row)
    }
    if (atBottom) list.scrollTop = list.scrollHeight
    statusEl.textContent = state.net === 'online' ? '' : state.net === 'offline' ? 'Backend offline, retrying...' : 'Connecting...'
    field.disabled = false
  }
  const apply = (fn) => { state = fn(state); render() }

  for (const type of ['history', 'turn_start', 'sentence', 'turn_end', 'proactive', 'error']) events.on(type, (m) => apply((s) => applyEvent(s, m)))

  socket = createSocket({
    url: config.wsUrl,
    onEvent: events.emit,
    onStatus: (status) => apply((s) => setNet(s, status)),
    onOpen: () => {
      socket.settings({ ...config.backendSettings, tts: false })        // this connection never gets audio
      socket.history(null)
    },
  })

  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    const t = field.value.trim()
    if (!t) return
    const id = socket.sendText(t)
    if (!id) { statusEl.textContent = "Can't reach the backend right now."; return }
    field.value = ''
    apply((s) => addUser(s, id, t))
  })

  // The header moves this window on its own (the main process keeps the spot as an offset from the avatar, so it still follows her). Locked: it stays.
  const head = $('head')
  let locked = !!config.locked
  const paintLock = () => { head.style.cursor = locked ? 'default' : 'grab'; head.title = locked ? 'The layout is locked' : 'Drag to move' }
  paintLock()
  window.novaChat.onLocked((v) => { locked = v; paintLock() })
  let from = null
  head.addEventListener('pointerdown', (e) => {
    if (locked || e.button !== 0 || e.target.closest('button')) return
    from = { x: e.screenX, y: e.screenY }
    head.setPointerCapture(e.pointerId)
    window.novaChat.drag('start')
  })
  head.addEventListener('pointermove', (e) => { if (from) window.novaChat.drag('move', e.screenX - from.x, e.screenY - from.y) })
  const endDrag = (e) => {
    if (!from) return
    window.novaChat.drag('end', e.screenX - from.x, e.screenY - from.y)
    from = null
    if (head.hasPointerCapture(e.pointerId)) head.releasePointerCapture(e.pointerId)
  }
  head.addEventListener('pointerup', endDrag)
  head.addEventListener('pointercancel', endDrag)

  $('close').onclick = () => window.novaChat.close()
  const toggleAvatar = $('avatar')
  const paintAvatar = (visible) => { toggleAvatar.textContent = visible ? 'Hide avatar' : 'Show avatar' }
  paintAvatar(config.avatarVisible)
  toggleAvatar.onclick = () => window.novaChat.toggleAvatar()
  window.novaChat.onAvatarVisible(paintAvatar)
  render()
  field.focus()
}

boot()
