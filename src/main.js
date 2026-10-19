import { createAvatar } from './avatar/avatar.js'
import { createExpressionController } from './avatar/expression.js'
import { createSocket } from './net/socket.js'
import { createBubble } from './ui/bubble.js'
import { createInput } from './ui/input.js'

const canvas = document.getElementById('stage')
const statusEl = document.getElementById('status')
const HIT_ALPHA = 16        // pixels at least this opaque count as "on the avatar"
const CLICK_SLOP_PX = 4     // pointer movement below this on release counts as a click, not a drag

const state = { cursor: null, interactive: false, dragging: false, net: 'connecting', turn: null }

window.nova.onDebug((on) => document.body.classList.toggle('debug', on))
window.nova.onCursor((c) => { state.cursor = c })

function setInteractive(on) {
  if (on === state.interactive) return
  state.interactive = on
  window.nova.setInteractive(on)
}

async function boot() {
  let avatar
  try {
    avatar = await createAvatar(canvas, 'nova-asset://avatar.vrm')
  } catch (err) {
    statusEl.textContent = 'avatar failed: ' + err.message
    document.body.classList.add('debug')
    console.error(err)
    return
  }

  const expression = createExpressionController(avatar)
  const bubble = createBubble(document.getElementById('bubble'))

  // ── backend events ────────────────────────────────────────────────────────
  function onEvent(m) {
    switch (m.type) {
      case 'turn_start':
        state.turn = m.turn_id
        bubble.startTurn()
        break
      case 'sentence':
        bubble.addSentence(m.text)
        expression.set(m.emotion)
        break
      case 'turn_end':
        bubble.fadeSoon()
        if (state.turn === m.turn_id) state.turn = null
        break
      case 'proactive':
        bubble.say(m.text)
        expression.set(m.emotion || 'neutral')
        break
      case 'error':
        bubble.say('Something went wrong: ' + m.message)
        break
    }
  }

  const config = await window.nova.getConfig()
  const socket = createSocket({ url: config.backend, onEvent, onStatus: (s) => { state.net = s } })

  // Tell the backend whether the user is at the PC (OS idle time), every 30 s and right after connecting.
  const reportPresence = async () => socket.send({ type: 'presence', idle_seconds: await window.nova.idleSeconds() })
  setInterval(reportPresence, 30000)
  setTimeout(reportPresence, 1500)

  // ── input box ─────────────────────────────────────────────────────────────
  const input = createInput({
    box: document.getElementById('inputbox'),
    field: document.getElementById('field'),
    onSubmit: (text) => {
      if (state.turn) socket.interrupt(state.turn)
      if (!socket.sendText(text)) bubble.say("I can't reach the backend right now.")
    },
    onOpen: () => setInteractive(true),
    onClose: () => window.nova.inputClosed(),
  })
  window.nova.onOpenInput(() => input.show())
  if (config.autoSay) setTimeout(() => socket.sendText(config.autoSay), 2500)

  // ── drag by grabbing the avatar; a click without movement opens the input ─
  let downAt = null
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.interactive) return
    state.dragging = true
    downAt = { x: e.screenX, y: e.screenY }
    canvas.setPointerCapture(e.pointerId)
    window.nova.dragStart()
  })
  const endDrag = (e) => {
    if (!state.dragging) return
    state.dragging = false
    window.nova.dragEnd()
    const moved = downAt ? Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) : Infinity
    downAt = null
    if (e.type === 'pointerup' && moved < CLICK_SLOP_PX) input.show()
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  // ── frame loop ────────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    expression.update(dt)
    avatar.update(dt)
    avatar.render()

    const c = state.cursor
    if (c) {
      avatar.lookAtNormalized((c.x / c.w) * 2 - 1, 1 - (c.y / c.h) * 2)
      // Stay interactive while dragging or typing; otherwise only while the cursor is over avatar pixels.
      const over = c.x >= 0 && c.y >= 0 && c.x < c.w && c.y < c.h && avatar.alphaAt(c.x, c.y) >= HIT_ALPHA
      setInteractive(state.dragging || input.isOpen() || over)
      statusEl.textContent = `${state.net}  cursor ${Math.round(c.x)},${Math.round(c.y)}  ${state.interactive ? 'AVATAR' : 'click-through'}`
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

boot()
