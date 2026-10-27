// An orb that stands in for the avatar on the desktop. It offers the same small surface the overlay uses for the VRM avatar
// (update / render / lookAtNormalized / setExpression / setVisemes / setMouth / alphaAt), so the lip-sync, the mood controller and the
// click-through hit test drive it unchanged: the sound swells it, her mood tints it, the cursor nudges its highlight.
//
// `el` is the orb's element. It is styled by CSS variables only (--tint, --glow, --hx, --hy) and a transform, so this module needs no layout.

const TINTS = {
  neutral: [139, 92, 246],
  happy: [236, 110, 170],
  relaxed: [120, 130, 240],
  sad: [70, 120, 230],
  surprised: [60, 200, 230],
  angry: [230, 80, 80],
}
const MIN_SIZE = 48

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))

// Tint: neutral violet, blended towards the active moods. The moods are averaged by strength; the strongest total (capped at 1) says how far
// from neutral the orb goes.
export function tintFor(moods) {
  let r = 0, g = 0, b = 0, total = 0
  for (const [name, rgb] of Object.entries(TINTS)) {
    if (name === 'neutral') continue
    const w = clamp01(moods[name])
    r += rgb[0] * w; g += rgb[1] * w; b += rgb[2] * w; total += w
  }
  if (total <= 0) return TINTS.neutral.slice()
  const strength = Math.min(1, total)
  const n = TINTS.neutral
  return [Math.round(n[0] * (1 - strength) + (r / total) * strength), Math.round(n[1] * (1 - strength) + (g / total) * strength), Math.round(n[2] * (1 - strength) + (b / total) * strength)]
}

// How open the "mouth" is for a set of viseme weights: the loudest shape, so any speech sound moves the orb.
export function levelOf(shapes) {
  const s = shapes || {}
  return clamp01(Math.max(s.aa || 0, (s.oh || 0) * 0.85, (s.ou || 0) * 0.75, (s.ee || 0) * 0.7, (s.ih || 0) * 0.7))
}

export function createOrb(el, { size = 120 } = {}) {
  const moods = {}
  let level = 0, shown = 0, t = 0, look = { x: 0, y: 0 }
  let px = Math.max(MIN_SIZE, Math.round(size))
  el.style.width = px + 'px'
  el.style.height = px + 'px'

  return {
    setSize(next) {
      px = Math.max(MIN_SIZE, Math.round(next))
      el.style.width = px + 'px'
      el.style.height = px + 'px'
    },
    size: () => px,
    setExpression(name, value) { moods[name] = clamp01(value) },
    setMouth(v) { level = clamp01(v) },
    setVisemes(shapes) { level = levelOf(shapes) },
    // The cursor, as -1..1 across the window (y up): the highlight drifts a little towards it, so the orb seems to notice you.
    lookAtNormalized(nx, ny) { look = { x: Math.max(-1, Math.min(1, nx || 0)), y: Math.max(-1, Math.min(1, ny || 0)) } },
    update(dt) {
      t += dt
      shown += (level - shown) * (level > shown ? 0.55 : 0.2)       // opens fast, settles slowly (same feel as the mouth)
      if (shown < 0.004) shown = 0
    },
    render() {
      const breathe = Math.sin(t * 1.6) * 0.025
      el.style.transform = `scale(${(1 + breathe + shown * 0.4).toFixed(3)})`
      const [r, g, b] = tintFor(moods)
      el.style.setProperty('--tint', `${r}, ${g}, ${b}`)
      el.style.setProperty('--glow', (shown + 0.05 * (1 + Math.sin(t * 1.6))).toFixed(3))
      el.style.setProperty('--hx', (35 + look.x * 9).toFixed(1) + '%')
      el.style.setProperty('--hy', (30 - look.y * 9).toFixed(1) + '%')
    },
    // 255 on the orb, 0 elsewhere (what the avatar's per-pixel alpha is used for: is the cursor over her). Window-relative CSS pixels.
    alphaAt(x, y) {
      const r = el.getBoundingClientRect()
      const radius = Math.min(r.width, r.height) / 2
      if (!(radius > 0)) return 0
      const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2)
      return Math.hypot(dx, dy) <= radius ? 255 : 0
    },
  }
}
