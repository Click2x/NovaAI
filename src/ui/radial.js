// Radial menu around the avatar (right-click on her). Items sit on a circle around the click point; the geometry is pure (tested with
// node --test), the DOM part only builds buttons with textContent. The buttons carry class "hot" so they take the mouse (src/main.js overHot).

export const RADIAL_ITEMS = [
  { id: 'talk', label: 'Talk', icon: '\u{1F4AC}' },
  { id: 'chat', label: 'Chat window', icon: '\u{1F5E8}' },
  { id: 'home', label: 'Home', icon: '\u{1F3E0}' },
  { id: 'code', label: 'Code', icon: '\u{2328}' },
  { id: 'settings', label: 'Settings', icon: '\u{2699}' },
  { id: 'lock', label: 'Lock or unlock the layout', icon: '\u{1F512}' },
  { id: 'hide', label: 'Hide avatar', icon: '\u{1F648}' },
]

const BTN = 44   // button size in px (must match #radial .rbtn in index.html)

// Centres of `n` buttons on a circle of `radius` around (cx, cy), starting at the top and going clockwise. The ring centre is moved so the
// whole ring stays inside the w x h window, and the radius shrinks if the window is too small for it.
export function ringLayout(n, cx, cy, radius, w, h, size = BTN) {
  const half = size / 2
  const r = Math.max(half, Math.min(radius, (Math.min(w, h) - size) / 2))
  const ox = Math.min(Math.max(cx, r + half), Math.max(r + half, w - r - half))
  const oy = Math.min(Math.max(cy, r + half), Math.max(r + half, h - r - half))
  const out = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    out.push({ x: Math.round(ox + r * Math.cos(a)), y: Math.round(oy + r * Math.sin(a)) })
  }
  return { centre: { x: Math.round(ox), y: Math.round(oy) }, radius: r, points: out }
}

// A fan of `n` buttons around a fixed centre (the orb), on an arc from `fromDeg` to `toDeg` (screen angles: 180 is left, 270 is up). The radius
// is at least `radius` and grows until neighbours do not touch; every button is kept inside the w x h window. So the menu surrounds the
// orb instead of covering it.
export function arcLayout(n, cx, cy, radius, w, h, { fromDeg = 180, toDeg = 300, size = BTN } = {}) {
  const half = size / 2
  const span = ((toDeg - fromDeg) * Math.PI) / 180
  const r = n > 1 ? Math.max(radius, ((n - 1) * (size + 6)) / Math.abs(span)) : radius
  const points = []
  for (let i = 0; i < n; i++) {
    const a = ((fromDeg * Math.PI) / 180) + (n > 1 ? (span * i) / (n - 1) : span / 2)
    points.push({ x: Math.round(Math.min(Math.max(cx + r * Math.cos(a), half), w - half)), y: Math.round(Math.min(Math.max(cy + r * Math.sin(a), half), h - half)) })
  }
  return { centre: { x: Math.round(cx), y: Math.round(cy) }, radius: r, points }
}

// `root` is the #radial element. onPick(id) is called once with the chosen item and the menu closes. Items can be hidden per state
// (`items` filter), e.g. "Hide avatar" is always shown, but a caller may drop entries that make no sense.
export function createRadial(root, { onPick, items = RADIAL_ITEMS, radius = 96 } = {}) {
  let open = false
  const close = () => {
    open = false
    root.classList.remove('show')
    root.textContent = ''
  }
  return {
    isOpen: () => open,
    // `fan` ({ cx, cy, radius }) puts the buttons on an arc around that point (the orb) instead of a ring around the click.
    open(x, y, w = window.innerWidth, h = window.innerHeight, fan = null) {
      root.textContent = ''
      const { points } = fan ? arcLayout(items.length, fan.cx, fan.cy, fan.radius, w, h) : ringLayout(items.length, x, y, radius, w, h)
      items.forEach((it, i) => {
        const b = document.createElement('button')
        b.className = 'rbtn'
        b.title = it.label
        b.setAttribute('aria-label', it.label)
        b.dataset.id = it.id
        b.style.left = points[i].x - BTN / 2 + 'px'
        b.style.top = points[i].y - BTN / 2 + 'px'
        b.textContent = it.icon
        b.addEventListener('click', (e) => { e.stopPropagation(); close(); onPick && onPick(it.id) })
        root.append(b)
      })
      root.classList.add('show')
      open = true
    },
    close,
  }
}
