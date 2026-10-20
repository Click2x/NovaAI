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
  { title: 'Chat', fields: [
    { path: 'chat.mode', type: 'select', label: 'Chat mode', options: [['companion', 'Companion'], ['friend', 'Friend'], ['assistant', 'Assistant'], ['buddy', 'Buddy']],
      hint: 'The persona she uses for chat from the overlay (same modes as the web app).' },
    { path: 'chat.nsfw', type: 'bool', label: 'Allow NSFW', hint: 'Off by default. Applies to what she says in the overlay. Story and NSFW history is never shown in the overlay either way.' },
  ] },
  { title: 'Notifications', fields: [
    { path: 'proactive.speak', type: 'select', label: 'Say her own messages aloud', options: [['off', 'Never (show only)'], ['when_visible_and_not_fullscreen', 'When she is visible and nothing is fullscreen']],
      hint: 'Reminders and messages she starts herself always show as a bubble or a card. Speaking them is off unless you turn it on here; it also needs "Speak replies aloud".' },
    { path: 'proactive.quietEnabled', type: 'bool', label: 'Quiet hours', hint: 'During quiet hours nothing is spoken and nothing pops up; notifications wait behind the bell. Reminders you asked for still reach your phone as before.' },
    { path: 'proactive.quietStart', type: 'text', label: 'Quiet from', placeholder: '22:00', hint: '24-hour time, HH:MM.' },
    { path: 'proactive.quietEnd', type: 'text', label: 'Quiet until', placeholder: '08:00', hint: '24-hour time, HH:MM. A start later than the end wraps past midnight.' },
  ] },
  { title: 'Autonomy', fields: [
    { path: 'autonomy.mode', type: 'select', label: 'When she acts on her own', options: [['ask', 'Ask before acting'], ['plan', 'Plan first, then ask'], ['auto', 'Act without asking']],
      hint: 'Placeholder: saved for the agent phase, nothing uses it yet.' },
  ] },
  { title: 'Models', fields: [
    { path: 'models.agentSwap', type: 'select', label: 'Agent tasks use the big model', options: [['always', 'Always swap to it'], ['never', 'Never swap (use the chat model)']],
      hint: 'Before an agent task the GPU swaps from the chat model to the agent model. Takes effect on the next agent task.' },
    { path: 'models.agentModel', type: 'text', label: 'Agent model', placeholder: 'backend default (Qwen3.6 27B)', hint: 'An Ollama model tag. Empty = the backend default (NOVA_AGENT_MODEL).' },
    { path: 'models.chatReloadMinutes', type: 'range', label: 'Reload chat model after idle', min: 0, max: 60, step: 1, decimals: 0, unit: ' min',
      hint: 'How long the GPU stays idle after an agent task before the chat model is loaded again. 0 = never; the next chat message loads it.' },
  ] },
  { title: 'Home and backend', fields: [
    { path: 'home.url', type: 'text', label: 'Home window address', placeholder: 'auto',
      hint: "auto = the backend's /app page if it answers, else the Vite dev server (127.0.0.1:5173). Or any http(s) address. Applies the next time Home opens." },
    { path: 'backend.url', type: 'text', label: 'Backend address', placeholder: 'http://127.0.0.1:8000', hint: 'Used for the connection, the health line and auto Home. Restart the app to reconnect elsewhere.' },
    { path: 'backend.startScript', type: 'text', label: 'Start script', placeholder: 'C:\\scripts\\start_nova.ps1', hint: 'Run by the tray item "Start Nova services" (PowerShell, hidden). Never run automatically.' },
    { path: 'backend.controlUrl', type: 'text', label: 'Control page', placeholder: 'http://127.0.0.1:8765', hint: 'Opened by the tray item "Open control page".' },
  ] },
  { title: 'App', fields: [
    { path: 'app.autostart', type: 'bool', label: 'Start with Windows', hint: 'Takes effect in the installed app; a run from source only stores the choice.' },
    { path: 'app.updateFolder', type: 'text', label: 'Update folder', placeholder: 'D:\\Nova\\installers',
      hint: 'A folder where you keep newer "Nova Setup x.y.z.exe" files. The tray item "Check for update..." looks there (no network) and shows the file; it never installs anything. Empty = off.' },
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
