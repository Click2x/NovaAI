// Declarative description of the settings panel: which setting each control edits. Pure data and helpers (tested with node --test).
// `path` is a dotted path into the settings object (electron/settings.js); the panel renders `type` and sends `patchFor(path, value)`.
export const VOICES = [
  ['af_heart', 'Heart (US, default)'], ['af_bella', 'Bella (US)'], ['af_nicole', 'Nicole (US)'], ['af_sarah', 'Sarah (US)'], ['af_sky', 'Sky (US)'],
  ['am_adam', 'Adam (US, male)'], ['am_michael', 'Michael (US, male)'], ['bf_emma', 'Emma (UK)'], ['bf_isabella', 'Isabella (UK)'],
  ['bm_george', 'George (UK, male)'], ['bm_lewis', 'Lewis (UK, male)'],
]

export const SECTIONS = [
  { title: 'Voice', fields: [
    { path: 'voice.tts', type: 'bool', label: 'Speak replies aloud' },
    { path: 'voice.voice', type: 'select', label: 'Voice', options: VOICES },
    { path: 'voice.speed', type: 'range', label: 'Speed', min: 0.5, max: 2, step: 0.05 },
    { path: 'voice.fastModel', type: 'bool', label: 'Fast voice model', hint: 'Spoken turns use the quick no-think model (NOVA_VOICE_MODEL on the backend). Typed chat keeps the normal model.' },
  ] },
  { title: 'Listening', fields: [
    { path: 'listen.micOn', type: 'bool', label: 'Microphone on', hint: 'Off closes the microphone completely; typing still works.' },
    { path: 'listen.micDeviceId', type: 'mic', label: 'Microphone' },
    { path: 'listen.echoMode', type: 'select', label: 'Output', options: [['speakers', 'Speakers'], ['headphones', 'Headphones']],
      hint: 'Speakers: only the stop word interrupts her (her own voice reaches the mic). Headphones: any speech interrupts her.' },
    { path: 'listen.words.wake', type: 'words', label: 'Wake words', hint: 'Comma separated, up to 4 phrases of 1-4 words. Empty = default (hey nova).' },
    { path: 'listen.words.stop', type: 'words', label: 'Stop words', hint: 'Empty = default (nova stop).' },
    { path: 'listen.words.sleep', type: 'words', label: 'Sleep words', hint: 'Empty = default (goodnight nova).' },
  ] },
  { title: 'Screen', fields: [
    { path: 'screen.looks', type: 'bool', label: 'Allow screen looks', hint: 'Only when you ask ("look at my screen"). Private windows are never captured.' },
    { path: 'screen.scope', type: 'select', label: 'What she looks at', options: [['window', 'Active window only'], ['screen', 'Whole screen']],
      hint: 'Whole screen also shows other windows that are open next to the active one.' },
    { path: 'screen.trackWindow', type: 'bool', label: 'Track the active window', hint: 'Local only. Needed to tell which window is private; off also disables screen looks.' },
  ] },
  { title: 'Autonomy', fields: [
    { path: 'autonomy.mode', type: 'select', label: 'When she acts on her own', options: [['ask', 'Ask before acting'], ['plan', 'Plan first, then ask'], ['auto', 'Act without asking']],
      hint: 'Placeholder: saved for the agent phase, nothing uses it yet.' },
  ] },
  { title: 'App', fields: [
    { path: 'app.autostart', type: 'bool', label: 'Start with Windows', hint: 'Takes effect in the installed app; a run from source only stores the choice.' },
  ] },
]

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

// `listen.words.wake`, ['a'] -> { listen: { words: { wake: ['a'] } } }
export function patchFor(path, value) {
  const keys = path.split('.')
  return keys.reduceRight((acc, k) => ({ [k]: acc }), value)
}

// "Hey Nova,  ok nova" -> ['Hey Nova', 'ok nova'] (the main process validates again; an empty list means the default).
export const parseWords = (text) => String(text || '').split(/[,\n]/).map((p) => p.trim()).filter(Boolean)
export const formatWords = (list) => (Array.isArray(list) ? list.join(', ') : '')
