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
  chat: { mode: 'companion', nsfw: false },   // persona mode and NSFW for chat from the overlay; NSFW stays off until the user turns it on (roadmap D4)
  autonomy: { mode: 'ask' },        // legacy (phase 1 placeholder): only read once, to seed agent.defaultMode when no `agent` section was saved yet
  agent: { defaultMode: 'default', workspace: '' },   // P13 Code window: permission mode a new session starts in, and the folder it works in (also sent to the backend's ~/.nova/settings.json). bypass is never offered here: it needs bypassAllowed in that user file (roadmap D5)
  app: { autostart: false, updateFolder: '', onboardingDone: false, onboardingDismissed: false },   // onboarding*: the guided setup finished / was put off with "do this later" (the tray can always reopen it)
    // updateFolder: where newer 'Nova Setup x.y.z.exe' files are looked for (updates.js); empty = off
  home: { url: 'auto' },            // 'auto' = <backend.url>/app/ when it answers, else the Vite dev server (see home.js); or any http(s) URL
  backend: { url: 'http://127.0.0.1:8000', startScript: '', controlUrl: 'http://127.0.0.1:8765' },
  models: { agentSwap: 'always', agentModel: '', chatReloadMinutes: 5 },   // GPU swap policy (roadmap D10), applied by the backend arbiter; agentModel '' = the backend's default
  proactive: { speak: 'off', quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' },   // P8 (roadmap D12): say her own messages aloud? off by default; quiet hours silence and hide pop-ups (cards wait in the centre)
  display: { avatar: true, chat: false, chatSide: 'auto', vrm: '', style: 'orb', orbPercent: 10 },   // style: what she looks like on the desktop, a small orb (default) or the VRM avatar; orbPercent: the orb's diameter as a percentage of the screen width (it sits in the corner)   // avatar: show the overlay at all (off = Nova keeps running, tray/hotkeys/chat window still work); chat: the chat window by her; chatSide: which side of the shared origin it opens on
  placement: { lastDisplay: null, byDisplay: {} },   // see placement.js: the ONE origin both the avatar and the chat window are placed from
})

const AUTONOMY_MODES = ['ask', 'plan', 'auto']
const AGENT_MODES = ['default', 'acceptEdits', 'plan']
const AUTONOMY_TO_AGENT = { ask: 'default', plan: 'plan', auto: 'acceptEdits' }   // the old three-way setting -> agent.defaultMode
const AGENT_SWAPS = ['always', 'never']
const CHAT_MODES = ['companion', 'friend', 'assistant', 'buddy']   // same as backend/api/desktop.py CHAT_MODES
const ECHO_MODES = ['speakers', 'headphones']
const SPEAK_MODES = ['off', 'when_visible_and_not_fullscreen']
const SCOPES = ['window', 'screen']
const CHAT_SIDES = ['auto', 'left', 'right']
const LOOKS = ['orb', 'avatar']
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

// An http(s) URL without credentials or a trailing slash (backend.url, controlUrl); anything else keeps `fallback`.
function cleanHttpUrl(v, fallback) {
  if (typeof v !== 'string' || v.length > 300) return fallback
  let u
  try { u = new URL(v.trim()) } catch { return fallback }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return fallback
  return u.href.replace(/\/+$/, '')
}
// home.url: 'auto' (any case) or an http(s) URL. Keeps the path (e.g. /app/), so no slash is stripped.
function cleanHomeUrl(v, fallback) {
  if (typeof v !== 'string') return fallback
  if (v.trim().toLowerCase() === 'auto') return 'auto'
  if (v.length > 300) return fallback
  let u
  try { u = new URL(v.trim()) } catch { return fallback }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.href : fallback
}
// A file path for the start script: non-empty, one line, no control characters. Whether it exists is checked when it is run.
function cleanPath(v, fallback) {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  return t && t.length <= 260 && !/[\u0000-\u001f"]/.test(t) ? t : fallback
}

// A folder path that may be empty (empty clears it): one line, no control characters, no quotes.
function cleanFolder(v, fallback) {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  if (!t) return ''
  return t.length <= 260 && !/[\u0000-\u001f"]/.test(t) ? t : fallback
}

// The orb's size as a share of the screen width: 4 to 20 percent, whole numbers.
function cleanOrbPercent(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.round(Math.min(20, Math.max(4, v)))
}

// Path of a custom avatar: empty (use the bundled one) or one line ending in .vrm. Whether the file is usable is checked when it is loaded.
function cleanVrm(v, fallback) {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  if (!t) return ''
  return t.length <= 260 && /\.vrm$/i.test(t) && !/[\u0000-\u001f"]/.test(t) ? t : fallback
}

// An Ollama model tag: one line, no spaces or quotes. Empty means "the backend's default".
function cleanModelTag(v, fallback) {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  return t === '' || (t.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(t)) ? t : fallback
}
// Minutes before the chat model is loaded again after an agent swap: 0 (never; the next chat loads it) to 1440, one decimal.
function cleanMinutes(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.round(Math.min(1440, Math.max(0, v)) * 10) / 10
}

// A 24-hour clock time "HH:MM" (one or two digit hour); stored as zero-padded "HH:MM". Anything else keeps `fallback`.
function cleanClock(v, fallback) {
  const m = typeof v === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim()) : null
  return m ? m[1].padStart(2, '0') + ':' + m[2] : fallback
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
  const agent = isObj(src.agent) ? src.agent : {}
  const chat = isObj(src.chat) ? src.chat : {}
  const app = isObj(src.app) ? src.app : {}
  const home = isObj(src.home) ? src.home : {}
  const backend = isObj(src.backend) ? src.backend : {}
  const models = isObj(src.models) ? src.models : {}
  const proactive = isObj(src.proactive) ? src.proactive : {}
  const display = isObj(src.display) ? src.display : {}
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
    chat: { mode: oneOf(chat.mode, CHAT_MODES, b.chat.mode), nsfw: bool(chat.nsfw, b.chat.nsfw) },
    autonomy: { mode: oneOf(autonomy.mode, AUTONOMY_MODES, b.autonomy.mode) },
    agent: {
      // a file saved before P13 has no `agent` section: its autonomy.mode seeds the default mode once
      defaultMode: oneOf(agent.defaultMode, AGENT_MODES, !isObj(src.agent) && AUTONOMY_TO_AGENT[autonomy.mode] ? AUTONOMY_TO_AGENT[autonomy.mode] : b.agent.defaultMode),
      workspace: cleanFolder(agent.workspace, b.agent.workspace),
    },
    app: { autostart: bool(app.autostart, b.app.autostart), updateFolder: cleanFolder(app.updateFolder, b.app.updateFolder),
      onboardingDone: bool(app.onboardingDone, b.app.onboardingDone), onboardingDismissed: bool(app.onboardingDismissed, b.app.onboardingDismissed) },
    home: { url: cleanHomeUrl(home.url, b.home.url) },
    backend: {
      url: cleanHttpUrl(backend.url, b.backend.url),
      startScript: cleanPath(backend.startScript, b.backend.startScript),
      controlUrl: cleanHttpUrl(backend.controlUrl, b.backend.controlUrl),
    },
    models: {
      agentSwap: oneOf(models.agentSwap, AGENT_SWAPS, b.models.agentSwap),
      agentModel: cleanModelTag(models.agentModel, b.models.agentModel),
      chatReloadMinutes: cleanMinutes(models.chatReloadMinutes, b.models.chatReloadMinutes),
    },
    proactive: {
      speak: oneOf(proactive.speak, SPEAK_MODES, b.proactive.speak),
      quietEnabled: bool(proactive.quietEnabled, b.proactive.quietEnabled),
      quietStart: cleanClock(proactive.quietStart, b.proactive.quietStart),
      quietEnd: cleanClock(proactive.quietEnd, b.proactive.quietEnd),
    },
    display: {
      avatar: bool(display.avatar, b.display.avatar),
      chat: bool(display.chat, b.display.chat),
      chatSide: oneOf(display.chatSide, CHAT_SIDES, b.display.chatSide),
      vrm: cleanVrm(display.vrm, b.display.vrm),
      style: oneOf(display.style, LOOKS, b.display.style),
      orbPercent: cleanOrbPercent(display.orbPercent, b.display.orbPercent),
    },
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
  if (has('NOVA_CHAT_MODE') && CHAT_MODES.includes(env.NOVA_CHAT_MODE)) set('chat', 'mode', env.NOVA_CHAT_MODE)
  if (has('NOVA_NSFW')) set('chat', 'nsfw', env.NOVA_NSFW === '1')
  if (has('NOVA_HOME_URL')) set('home', 'url', env.NOVA_HOME_URL)
  if (has('NOVA_START_SCRIPT')) set('backend', 'startScript', env.NOVA_START_SCRIPT)
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

// The backend's HTTP origin the app talks to: NOVA_BACKEND (a ws:// URL, a test/override hook) wins over backend.url, so a run against a
// mock backend never polls the real one.
function backendHttpUrl(eff, env = {}) {
  if (env.NOVA_BACKEND) {
    try {
      const u = new URL(env.NOVA_BACKEND)
      return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
    } catch { /* fall through to the setting */ }
  }
  return eff.backend.url
}
function backendWsUrl(eff, env = {}) {
  if (env.NOVA_BACKEND) return env.NOVA_BACKEND
  return backendHttpUrl(eff, env).replace(/^http/, 'ws') + '/api/desktop/ws'
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
    mode: eff.chat.mode,
    nsfw: eff.chat.nsfw,
    gpu: gpuPolicy(eff),
  }
}

// The swap policy for the backend arbiter (PUT /api/system/models/policy takes the same object). An empty agentModel is left out so the
// backend keeps its own default (NOVA_AGENT_MODEL or the 27B tag).
function gpuPolicy(eff) {
  const m = eff.models
  const out = { agentSwap: m.agentSwap, chatReloadMinutes: m.chatReloadMinutes }
  if (m.agentModel) out.agentModel = m.agentModel
  return out
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

module.exports = { VERSION, DEFAULTS, DEFAULT_PHRASES, CHAT_SIDES, LOOKS, CHAT_MODES, AUTONOMY_MODES, AGENT_MODES, ECHO_MODES, SCOPES, SPEAK_MODES, cleanClock, sanitize, applyPatch, envOverrides, effective, toBackend, gpuPolicy, AGENT_SWAPS, backendHttpUrl, backendWsUrl, cleanPhrases, loadFrom, saveTo, applyAutostart }
