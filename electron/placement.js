// Where the avatar window sits, per display. Pure functions over Electron `Display`-shaped objects ({ id, workArea: {x,y,width,height} }),
// all in DIPs (what BrowserWindow bounds use), so a different resolution or scale factor on the same monitor does not move her off screen.
//
// A position is remembered as an offset from the bottom-right corner of that display's work area: { dx, dy } = how far the window's
// right and bottom edges are from the work area's right and bottom edges. Anchoring to a corner keeps her at the same place relative to
// the taskbar when the resolution changes; the result is always clamped so the whole window stays inside the work area.
const DEFAULT_OFFSET = { dx: 24, dy: 0 }

const displayKey = (d) => String(d.id)
const right = (r) => r.x + r.width
const bottom = (r) => r.y + r.height

// The display that holds `point`, else the nearest one by distance to its work area.
function pickDisplay(displays, point) {
  if (!displays.length) return null
  let best = null
  let bestDist = Infinity
  for (const d of displays) {
    const w = d.workArea
    const dx = Math.max(w.x - point.x, 0, point.x - (right(w) - 1))
    const dy = Math.max(w.y - point.y, 0, point.y - (bottom(w) - 1))
    const dist = Math.hypot(dx, dy)
    if (dist < bestDist) { best = d; bestDist = dist }
  }
  return best
}

// Bounds for a window of `size` on `workArea`, from a saved offset (default: bottom-right with a small margin). Never larger than the work area.
function boundsFor(workArea, size, offset) {
  const o = offset && Number.isFinite(offset.dx) && Number.isFinite(offset.dy) ? offset : DEFAULT_OFFSET
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const x = Math.min(Math.max(right(workArea) - width - o.dx, workArea.x), right(workArea) - width)
  const y = Math.min(Math.max(bottom(workArea) - height - o.dy, workArea.y), bottom(workArea) - height)
  return { x: Math.round(x), y: Math.round(y), width, height }
}

// The offset that reproduces `bounds` on `workArea`.
function offsetOf(workArea, bounds) {
  return { dx: Math.round(right(workArea) - right(bounds)), dy: Math.round(bottom(workArea) - bottom(bounds)) }
}

// Startup / display change: the display she was last on if it is still connected, else the primary; the saved offset for that display.
function resolve(displays, primary, placement, size) {
  const p = placement || { lastDisplay: null, byDisplay: {} }
  const display = (p.lastDisplay && displays.find((d) => displayKey(d) === p.lastDisplay)) || primary || displays[0]
  return { display, bounds: boundsFor(display.workArea, size, p.byDisplay[displayKey(display)]) }
}

// After a drag: which display holds the window centre, and the new placement with that display's offset remembered.
function remember(displays, placement, bounds) {
  const centre = { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) }
  const display = pickDisplay(displays, centre)
  if (!display) return placement
  const p = placement || { lastDisplay: null, byDisplay: {} }
  const key = displayKey(display)
  const byDisplay = { ...p.byDisplay, [key]: offsetOf(display.workArea, boundsFor(display.workArea, bounds, offsetOf(display.workArea, bounds))) }
  return { lastDisplay: key, byDisplay }
}

module.exports = { DEFAULT_OFFSET, displayKey, pickDisplay, boundsFor, offsetOf, resolve, remember }
