// Nova Desktop settings: schema, validation, merge, env overrides and persistence. Pure logic (the file system is injected) so it
// can be tested with `node --test`; main.js owns the one instance and the IPC.
//
// Two layers: `stored` is what the user chose (settings.json under userData); `effective` is stored with the env-var overrides
// applied on top. Env vars (NOVA_TTS, NOVA_ECHO_MODE, ...) stay as overrides and test hooks: they win while set, are never
// written to the file, and the settings panel shows those fields as locked.
const path = require('path')

const VERSION = 1

const DEFAULT_PHRASES = { wake: ['hey nova'], stop: ['nova stop'], sleep: ['goodnight nova'] }   // same as keyword_spotter.DEFAULT_PHRASES

const DEFAULTS = Object.freeze({
  version: VERSION,
  voice: { tts: true, voice: 'af_heart', speed: 1.0, fastModel: false },
  listen: { micOn: true, micDeviceId: '', echoMode: 'speakers', words: DEFAULT_PHRASES },
  screen: { looks: true, scope: 'window', trackWindow: true },
  autonomy: { mode: 'ask' },        // placeholder: stored for the agent phase, nothing reads it yet
  app: { autostart: false },
  placement: { lastDisplay: null, byDisplay: {} },   // see placement.js
})

const AUTONOMY_MODES = ['ask', 'plan', 'auto']
const ECHO_MODES = ['speakers', 'headphones']
const SCOPES = ['window', 'screen']
const VOICE_RE = /^[a-z]{2}_[a-z0-9]{2,20}$/        // Kokoro ids: af_heart, bm_george
const WORD_KINDS = ['wake', 'stop', 'sleep']

const clone = (o) => JSON.parse(JSON.stringify(o))
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback)
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback)

// A phrase list from an array or a comma/newline separated string: 1-4 words each, at most 4 phrases, no duplicates.
// An empty or all-invalid list gives `fallback` (an empty field means "use the default").
function cleanPhrases(v, fallback) {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : null
  if (!parts) return fallback
  const out = []
  for (const p of parts) {
    if (typeof p !== 'string') continue
    const s = p.trim().replace(/\s+/g, ' ')
    const words = s ? s.split(' ').length : 0
    if (words < 1 || words > 4 || s.length > 40) continue
    if (!out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s)
    if (out.length === 4) break
  }
  return out.length ? out : fallback
}

function cleanSpeed(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.round(Math.min(2.0, Math.max(0.5, v)) * 100) / 100
}

function cleanPlacement(v, fallback) {
  if (!isObj(v)) return fallback
  const byDisplay = {}
  const src = isObj(v.byDisplay) ? v.byDisplay : fallback.byDisplay
  for (const [key, p] of Object.entries(src)) {
    if (isObj(p) && Number.isFinite(p.dx) && Number.isFinite(p.dy) && Object.keys(byDisplay).length < 16) {
      byDisplay[String(key).slice(0, 64)] = { dx: Math.round(p.dx), dy: Math.round(p.dy) }
    }
  }
  const last = typeof v.lastDisplay === 'string' && v.lastDisplay ? v.lastDisplay.slice(0, 64) : v.lastDisplay === null ? null : fallback.lastDisplay
  return { lastDisplay: last, byDisplay }
}

// Full, valid settings from anything: unknown keys are dropped, an invalid value keeps `base`'s value for that field.
function sanitize(input, base = DEFAULTS) {
  return clone(sanitizeRaw(input, base))
}
function sanitizeRaw(input, base) {
  const src = isObj(input) ? input : {}
  const b = base
  const voice = isObj(src.voice) ? src.voice : {}
  const listen = isObj(src.listen) ? src.listen : {}
  const words = isObj(listen.words) ? listen.words : {}
  const screen = isObj(src.screen) ? src.screen : {}
  const autonomy = isObj(src.autonomy) ? src.autonomy : {}
  const app = isObj(src.app) ? src.app : {}
  const outWords = {}
  for (const k of WORD_KINDS) outWords[k] = cleanPhrases(words[k], b.listen.words[k])
  return {
    version: VERSION,
    voice: {
      tts: bool(voice.tts, b.voice.tts),
      voice: typeof voice.voice === 'string' && VOICE_RE.test(voice.voice) ? voice.voice : b.voice.voice,
      speed: cleanSpeed(voice.speed, b.voice.speed),
      fastModel: bool(voice.fastModel, b.voice.fastModel),
    },
    listen: {
      micOn: bool(listen.micOn, b.listen.micOn),
      micDeviceId: typeof listen.micDeviceId === 'string' && listen.micDeviceId.length <= 256 ? listen.micDeviceId : b.listen.micDeviceId,
      echoMode: oneOf(listen.echoMode, ECHO_MODES, b.listen.echoMode),
      words: outWords,
    },
    screen: {
      looks: bool(screen.looks, b.screen.looks),
      scope: oneOf(screen.scope, SCOPES, b.screen.scope),
      trackWindow: bool(screen.trackWindow, b.screen.trackWindow),
    },
    autonomy: { mode: oneOf(autonomy.mode, AUTONOMY_MODES, b.autonomy.mode) },
    app: { autostart: bool(app.autostart, b.app.autostart) },
    placement: cleanPlacement(src.placement, b.placement),
  }
}

// A partial settings object applied on top of `current` (deep merge by section, then validated). Phrase lists and byDisplay are replaced
// per key, not merged element-wise.
function applyPatch(current, patch) {
  if (!isObj(patch)) return clone(current)
  const merged = clone(current)
  for (const [section, value] of Object.entries(patch)) {
    if (section === 'version' || !isObj(value) || !isObj(merged[section])) continue
    for (const [k, v] of Object.entries(value)) {
      if (isObj(v) && isObj(merged[section][k])) merged[section][k] = { ...merged[section][k], ...v }
      else merged[section][k] = v
    }
  }
  return sanitize(merged, current)
}

// Env vars that override settings. Returns { patch, locked } where `locked` lists dotted paths ("voice.tts") the panel must disable.
function envOverrides(env = {}) {
  const patch = {}
  const locked = []
  const set = (section, key, value) => {
    patch[section] = patch[section] || {}
    patch[section][key] = value
    locked.push(`${section}.${key}`)
  }
  const has = (name) => env[name] !== undefined && env[name] !== ''
  if (has('NOVA_TTS')) set('voice', 'tts', env.NOVA_TTS !== '0')
  if (has('NOVA_VOICE')) set('voice', 'voice', env.NOVA_VOICE)
  if (has('NOVA_VOICE_SPEED') && Number(env.NOVA_VOICE_SPEED)) set('voice', 'speed', Number(env.NOVA_VOICE_SPEED))
  if (has('NOVA_FAST_MODEL')) set('voice', 'fastModel', env.NOVA_FAST_MODEL === '1')
  if (has('NOVA_VOICE_IN')) set('listen', 'micOn', env.NOVA_VOICE_IN !== '0')
  if (has('NOVA_ECHO_MODE') && ECHO_MODES.includes(env.NOVA_ECHO_MODE)) set('listen', 'echoMode', env.NOVA_ECHO_MODE)
  if (has('NOVA_WAKE_WORDS')) {
    try {
      const w = JSON.parse(env.NOVA_WAKE_WORDS)
      if (isObj(w)) set('listen', 'words', w)
    } catch { /* ignore a bad override */ }
  }
  if (has('NOVA_SCREEN')) set('screen', 'looks', env.NOVA_SCREEN !== '0')
  if (has('NOVA_SCREEN_SCOPE') && SCOPES.includes(env.NOVA_SCREEN_SCOPE)) set('screen', 'scope', env.NOVA_SCREEN_SCOPE)
  if (has('NOVA_WINDOW_TRACK')) set('screen', 'trackWindow', env.NOVA_WINDOW_TRACK !== '0')
  return { patch, locked }
}

// Stored settings with the env overrides on top.
function effective(stored, env = {}) {
  const { patch, locked } = envOverrides(env)
  const base = sanitize(stored)
  const merged = clone(base)
  for (const [section, vals] of Object.entries(patch)) for (const [k, v] of Object.entries(vals)) merged[section][k] = v
  return { settings: sanitize(merged, base), locked }
}

// What the backend wants in its `settings` message (backend/api/desktop.py apply_settings).
function toBackend(eff) {
  return {
    tts: eff.voice.tts,
    voice: eff.voice.voice,
    speed: eff.voice.speed,
    fast_model: eff.voice.fastModel,
    screen: eff.screen.looks && eff.screen.trackWindow,   // without window tracking there is nothing to check privacy against, so no looks
    echo_mode: eff.listen.echoMode,
    wake_words: clone(eff.listen.words),
  }
}

// ── persistence ─────────────────────────────────────────────────────────────────
// `fs` is injected. A missing file gives defaults; a file that is not valid JSON is kept as settings.bad.json and replaced by defaults.
function loadFrom(fs, file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return { settings: clone(DEFAULTS), status: 'missing' } }
  try {
    const parsed = JSON.parse(text)
    if (!isObj(parsed)) throw new Error('not an object')
    return { settings: sanitize(parsed), status: 'ok' }
  } catch {
    try { fs.writeFileSync(path.join(path.dirname(file), 'settings.bad.json'), text) } catch { /* best effort */ }
    return { settings: clone(DEFAULTS), status: 'corrupt' }
  }
}

// Write to a temporary file, then rename, so a crash never leaves half a file.
function saveTo(fs, file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
  fs.renameSync(tmp, file)
}

// The login item: `app` is Electron's app (injectable). Only a packaged app registers itself; an unpackaged run would register a bare
// electron.exe that starts with no project.
function applyAutostart(app, enabled, packaged) {
  if (!packaged) return { applied: false, reason: 'unpackaged' }
  app.setLoginItemSettings({ openAtLogin: !!enabled })
  return { applied: true }
}

module.exports = { VERSION, DEFAULTS, DEFAULT_PHRASES, AUTONOMY_MODES, ECHO_MODES, SCOPES, sanitize, applyPatch, envOverrides, effective, toBackend, cleanPhrases, loadFrom, saveTo, applyAutostart }
