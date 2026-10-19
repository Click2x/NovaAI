// Emotion tags from the backend -> VRM expression presets, eased in and back to neutral.
// Blink and mouth shapes are driven elsewhere; this only owns the mood presets below.
const PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised']

const TARGETS = {
  neutral:   {},
  happy:     { happy: 0.8 },
  excited:   { happy: 1.0, surprised: 0.25 },
  caring:    { relaxed: 0.7, happy: 0.25 },
  sad:       { sad: 0.8 },
  surprised: { surprised: 0.9 },
  curious:   { surprised: 0.3, relaxed: 0.2 },
  angry:     { angry: 0.8 },
}

const EASE_PER_SEC = 6      // how quickly values chase their target
const HOLD_SECONDS = 4      // time after the last sentence before easing back to neutral

export function createExpressionController(avatar) {
  const current = Object.fromEntries(PRESETS.map((p) => [p, 0]))
  let target = {}
  let holdLeft = 0

  return {
    set(emotion) {
      target = TARGETS[emotion] || TARGETS.neutral
      holdLeft = HOLD_SECONDS
    },
    update(dt) {
      if (holdLeft > 0) {
        holdLeft -= dt
        if (holdLeft <= 0) target = {}
      }
      const k = 1 - Math.exp(-EASE_PER_SEC * dt)
      for (const p of PRESETS) {
        current[p] += ((target[p] || 0) - current[p]) * k
        avatar.setExpression(p, current[p] < 0.003 ? 0 : current[p])
      }
    },
  }
}
