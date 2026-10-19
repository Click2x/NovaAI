import { createAvatar } from './avatar/avatar.js'

const canvas = document.getElementById('stage')
const statusEl = document.getElementById('status')
const HIT_ALPHA = 16 // pixels at least this opaque count as "on the avatar"

const state = { cursor: null, interactive: false, dragging: false }

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

  // Drag the avatar by grabbing it. Pointer events only arrive while the window is interactive.
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.interactive) return
    state.dragging = true
    canvas.setPointerCapture(e.pointerId)
    window.nova.dragStart()
  })
  const endDrag = () => {
    if (!state.dragging) return
    state.dragging = false
    window.nova.dragEnd()
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  let last = performance.now()
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    avatar.update(dt)
    avatar.render()

    const c = state.cursor
    if (c) {
      avatar.lookAtNormalized((c.x / c.w) * 2 - 1, 1 - (c.y / c.h) * 2)
      // Stay interactive for the whole drag; otherwise only while the cursor is over avatar pixels.
      const over = c.x >= 0 && c.y >= 0 && c.x < c.w && c.y < c.h && avatar.alphaAt(c.x, c.y) >= HIT_ALPHA
      setInteractive(state.dragging || over)
      statusEl.textContent = `cursor ${Math.round(c.x)},${Math.round(c.y)}  ${state.interactive ? 'AVATAR' : 'click-through'}`
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

boot()
