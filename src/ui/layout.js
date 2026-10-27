// Moving the overlay's own elements (the speech bubble, the text box, the History button, the action buttons) and locking them in place.
// Each element carries an offset { x, y } from its default spot, applied as the CSS variables --dx/--dy (index.html turns them into `translate`).
// While the layout is unlocked a small grip floats above each shown element; dragging the grip moves it, double-clicking the grip puts it back.
// Locked: no grips, nothing moves. The offsets are saved by the caller (`save(ui)`), the main process validates and stores them.

// The offset to use for `want`, so the element (size w x h, default position `base` = its rect with no offset) stays inside the vw x vh window.
export function clampOffset(want, base, size, vw, vh) {
  const range = (pos, len, max) => [-pos, Math.max(-pos, max - len - pos)]
  const [x0, x1] = range(base.left, size.w, vw)
  const [y0, y1] = range(base.top, size.h, vh)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { x: Math.round(Math.min(Math.max(num(want.x), x0), x1)) + 0, y: Math.round(Math.min(Math.max(num(want.y), y0), y1)) + 0 }
}

// Shown on screen: not display:none, not hidden, not faded out (the speech bubble fades rather than disappearing).
function defaultVisible(doc) {
  return (el) => {
    const cs = doc.defaultView.getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05
  }
}

// `els`: { id: element }. `doc`: the document (the grips are made and attached here). `isLocked()` and `save(ui)` come from the caller.
export function createLayout(doc, { els, isLocked, save, visible = defaultVisible(doc), viewport = () => ({ w: doc.defaultView ? doc.defaultView.innerWidth : 0, h: doc.defaultView ? doc.defaultView.innerHeight : 0 }) }) {
  let ui = {}                       // id -> { x, y }, only the moved ones
  let drag = null                   // { id, from: {x, y}, base: rect, size, start: {x, y} }
  const grips = {}
  const offsetOf = (id) => ui[id] || { x: 0, y: 0 }

  function paint(id) {
    const o = offsetOf(id)
    els[id].style.setProperty('--dx', o.x + 'px')
    els[id].style.setProperty('--dy', o.y + 'px')
  }

  for (const id of Object.keys(els)) {
    const g = doc.createElement('div')
    g.className = 'grip'
    g.title = 'Drag to move. Double-click to put it back.'
    g.addEventListener('pointerdown', (e) => {
      if (isLocked() || e.button !== 0) return
      const el = els[id]
      const r = el.getBoundingClientRect()
      const cur = offsetOf(id)
      drag = { id, from: { x: e.clientX, y: e.clientY }, base: { left: r.left - cur.x, top: r.top - cur.y }, size: { w: r.width, h: r.height }, start: { ...cur } }
      if (g.setPointerCapture) g.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    g.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== id) return
      const v = viewport()
      const want = { x: drag.start.x + (e.clientX - drag.from.x), y: drag.start.y + (e.clientY - drag.from.y) }
      ui[id] = clampOffset(want, drag.base, drag.size, v.w, v.h)
      paint(id)
    })
    const end = () => {
      if (!drag || drag.id !== id) return
      drag = null
      const o = offsetOf(id)
      if (!o.x && !o.y) delete ui[id]
      save({ ...ui })
    }
    g.addEventListener('pointerup', end)
    g.addEventListener('pointercancel', end)
    g.addEventListener('dblclick', () => {
      if (isLocked()) return
      delete ui[id]
      paint(id)
      save({ ...ui })
    })
    doc.body.append(g)
    grips[id] = g
  }

  return {
    grips: Object.values(grips),
    dragging: () => !!drag,
    offsets: () => ({ ...ui }),
    // The saved layout ({ locked, ui }) arrived (first load, or a setting changed): show it, and the lock state. Not while a grip is being dragged.
    apply(layout) {
      doc.body.classList.toggle('locked', !!(layout && layout.locked))
      if (drag) return
      ui = {}
      const saved = layout && layout.ui ? layout.ui : {}
      for (const id of Object.keys(els)) {
        const o = saved[id]
        if (o && Number.isFinite(o.x) && Number.isFinite(o.y) && (o.x || o.y)) ui[id] = { x: o.x, y: o.y }
        paint(id)
      }
    },
    // Every frame: put each grip just above its element, or hide it while the element is not shown (or the layout is locked).
    tick() {
      for (const [id, g] of Object.entries(grips)) {
        const el = els[id]
        const r = el.getBoundingClientRect()
        const shown = !isLocked() && r.width > 0 && r.height > 0 && visible(el)
        g.classList.toggle('show', shown)
        if (!shown) continue
        g.style.left = Math.max(0, Math.round(r.left + r.width / 2 - 17)) + 'px'
        g.style.top = (r.top >= 15 ? Math.round(r.top - 15) : Math.round(r.bottom + 3)) + 'px'      // above it, or below when it is at the top edge
      }
    },
  }
}
