// State of the setup page (pure, tested with node --test). The page renders from this and from nothing else it keeps in the DOM.
export const STEPS = ['welcome', 'machine', 'install', 'meet', 'voice', 'safety', 'avatar', 'done']
export const STEP_LABELS = {
  welcome: 'Hello', machine: 'My plan', install: 'Waking up', meet: 'You and me', voice: 'My voice', safety: 'Safety', avatar: 'My look', done: 'All set',
}
export const MAX_HISTORY = 80

export function initial() {
  return {
    phase: 'boot',            // boot | offline | ready
    status: null,             // the backend's /api/onboarding
    settings: null,           // the backend's /api/settings (what she has learned)
    plan: null,               // models she intends to use ({voice, tools, download, download_gb})
    voices: [],
    history: [],              // [{who: 'nova'|'you', text}]
    caption: '',
    emotion: 'neutral',
    busy: false,
    error: '',
    install: { state: 'idle', percent: 0, seen: 0 },
    mic: { on: false, available: true, hearing: false },
    muted: false,
    speaking: false,
  }
}

const clip = (list) => (list.length > MAX_HISTORY ? list.slice(list.length - MAX_HISTORY) : list)
const str = (v) => (typeof v === 'string' ? v : '')

export function reduce(s, a) {
  switch (a.type) {
    case 'offline': return { ...s, phase: 'offline', busy: false }
    case 'status': return { ...s, phase: 'ready', status: a.status, error: '' }
    case 'settings': return { ...s, settings: a.settings }
    case 'plan': return { ...s, plan: a.plan }
    case 'voices': return { ...s, voices: Array.isArray(a.voices) ? a.voices : [] }
    case 'busy': return { ...s, busy: !!a.busy }
    case 'error': return { ...s, error: str(a.message).slice(0, 300), busy: false }
    case 'caption': return { ...s, caption: str(a.text), emotion: str(a.emotion) || 'neutral' }
    case 'her_line': {
      const text = str(a.text).trim()
      if (!text) return s
      return { ...s, history: clip([...s.history, { who: 'nova', text }]) }
    }
    case 'user_line': {
      const text = str(a.text).trim()
      return text ? { ...s, history: clip([...s.history, { who: 'you', text }]) } : s
    }
    case 'speaking': return s.speaking === !!a.on ? s : { ...s, speaking: !!a.on }
    case 'install': {
      const i = a.install || {}
      return { ...s, install: { ...s.install, state: str(i.state) || s.install.state, percent: Number.isFinite(i.percent) ? Math.max(0, Math.min(100, i.percent)) : s.install.percent } }
    }
    case 'install_seen': return { ...s, install: { ...s.install, seen: a.seen } }
    case 'mic': return { ...s, mic: { ...s.mic, ...a.mic } }
    case 'muted': return { ...s, muted: !!a.muted }
    default: return s
  }
}

// New narration lines of an install status that have not been spoken yet.
export function newInstallLines(install, seen) {
  const lines = Array.isArray(install && install.lines) ? install.lines : []
  return { lines: lines.slice(seen), seen: lines.length }
}

// What the person sees as "step n of m" and which dots are done.
export function progress(status) {
  const i = STEPS.indexOf(status && status.step)
  return { index: i < 0 ? 0 : i, total: STEPS.length, labels: STEPS.map((id) => STEP_LABELS[id]) }
}

// A short summary of what she learned, for the last screen. Only what is really set.
export function summary(settings) {
  const s = settings || {}
  const u = s.user || {}, p = s.persona || {}
  const rows = []
  if (u.name) rows.push(['You', u.name + (u.pronouns ? ` (${u.pronouns})` : '')])
  if (s.nova && s.nova.name && s.nova.name !== 'Nova') rows.push(['You call me', s.nova.name])
  if (p.interests && p.interests.length) rows.push(['You like', p.interests.join(', ')])
  const vibe = []
  if (p.humor > 0.66) vibe.push('playful'); else if (p.humor < 0.34) vibe.push('earnest')
  if (p.directness > 0.66) vibe.push('blunt'); else if (p.directness < 0.34) vibe.push('gentle')
  if (p.warmth > 0.66) vibe.push('warm'); else if (p.warmth < 0.34) vibe.push('cool')
  if (p.formality > 0.66) vibe.push('polite'); else if (p.formality < 0.34) vibe.push('casual')
  if (vibe.length) rows.push(['My style', vibe.join(', ')])
  if (p.boundaries && p.boundaries.length) rows.push(['I will not', p.boundaries.join('; ')])
  return rows
}

// How far the orb swells for the sound that is playing: 0 (silence) .. 1, from the analyser's RMS. Quiet noise under the gate does nothing.
export function orbLevel(rms) {
  const v = Number.isFinite(rms) ? rms : 0
  return Math.max(0, Math.min(1, (v - 0.01) * 8))
}

// Mouth reading speed for lines spoken without audio: about 15 characters a second, at least 1.2 s.
export function readMs(text) {
  return Math.max(1200, Math.round(str(text).length * 66))
}
