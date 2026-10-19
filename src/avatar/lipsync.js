// Lip-sync from the playing audio: loudness (RMS) sets how far the mouth opens, the spectrum decides the vowel shape.
//   low band  (~150-600 Hz)  strong, rest weak          -> ou / oh   (rounded, small first formant)
//   mid band  (~600-1400 Hz) strong                      -> aa        (open, large first formant)
//   high band (~1.4-4 kHz)   strong relative to the rest -> ee / ih   (spread, high second formant)
// This is an approximation, not phoneme alignment, but it follows the voice's energy closely enough to read as speech.
const BANDS = { low: [150, 600], mid: [600, 1400], high: [1400, 4000] }
const ATTACK = 0.55         // fraction of the gap closed per frame while opening (fast)
const RELEASE = 0.22        // ... while closing (slower, so the mouth does not flutter)
const GATE = 0.012          // RMS below this is silence
const GAIN = 9            // RMS -> mouth opening

export function createLipSync({ analyser, apply }) {
  const time = new Float32Array(analyser.fftSize)
  const freq = new Uint8Array(analyser.frequencyBinCount)
  const cur = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
  let rms = 0

  function bandEnergy(sr, [lo, hi]) {
    const binHz = sr / 2 / freq.length
    const a = Math.max(1, Math.floor(lo / binHz))
    const b = Math.min(freq.length - 1, Math.ceil(hi / binHz))
    let sum = 0
    for (let i = a; i <= b; i++) sum += freq[i] / 255
    return sum / Math.max(1, b - a + 1)
  }

  function ease(key, target) {
    cur[key] += (target - cur[key]) * (target > cur[key] ? ATTACK : RELEASE)
    if (cur[key] < 0.003) cur[key] = 0
  }

  return {
    // Call once per frame; sampleRate is the AudioContext's output rate.
    update(sampleRate) {
      analyser.getFloatTimeDomainData(time)
      let s = 0
      for (let i = 0; i < time.length; i++) s += time[i] * time[i]
      rms = Math.sqrt(s / time.length)
      const target = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
      if (rms > GATE) {
        analyser.getByteFrequencyData(freq)
        const l = bandEnergy(sampleRate, BANDS.low)
        const m = bandEnergy(sampleRate, BANDS.mid)
        const h = bandEnergy(sampleRate, BANDS.high)
        const total = l + m + h + 1e-6
        const open = Math.min(1, (rms - GATE) * GAIN)
        const pl = l / total, pm = m / total, ph = h / total
        target.aa = open * Math.min(1, pm * 2.2)
        target.ou = open * Math.max(0, pl - 0.3) * 1.6
        target.oh = open * Math.max(0, pl - 0.2) * Math.min(1, pm * 1.8) * 1.3
        target.ee = open * Math.max(0, ph - 0.12) * 2.4
        target.ih = open * Math.max(0, ph - 0.08) * Math.min(1, pm * 1.6) * 1.8
      }
      let peak = 0
      for (const k of Object.keys(cur)) {
        ease(k, Math.min(1, target[k]))
        peak = Math.max(peak, cur[k])
      }
      // Never let the sum of shapes distort the face: cap at 1 total.
      const sum = Object.values(cur).reduce((a, b) => a + b, 0)
      const scale = sum > 1 ? 1 / sum : 1
      const out = {}
      for (const k of Object.keys(cur)) out[k] = cur[k] * scale
      apply(out)
      return { rms, mouth: peak, shapes: out }
    },
    // Close the mouth (silence / interrupt).
    reset() { for (const k of Object.keys(cur)) cur[k] = 0; apply({ ...cur }) },
  }
}
