// Settings panel. Controls are built from fields.js; every change goes to the main process (which validates, saves and applies it)
// and the panel then redraws from what the main process says is in effect.
import { SECTIONS, getPath, patchFor, parseWords, formatWords } from './fields.js'

const form = document.getElementById('form')
const fileEl = document.getElementById('file')
let view = null
const controls = new Map()          // path -> { field, input, row, hint }
let mics = []

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props)
  for (const k of kids) e.append(k)
  return e
}

async function commit(path, value) {
  view = await window.nova.settingsSet(patchFor(path, value))
  draw()
}

function build() {
  form.textContent = ''
  controls.clear()
  for (const section of SECTIONS) {
    const sec = el('section', {}, el('h2', { textContent: section.title }))
    for (const field of section.fields) {
      const id = 'f-' + field.path.replace(/\./g, '-')
      const row = el('div', { className: 'row' }, el('label', { htmlFor: id, textContent: field.label }))
      let input
      if (field.type === 'bool') {
        input = el('input', { type: 'checkbox', id })
        input.addEventListener('change', () => commit(field.path, input.checked))
        row.append(input)
      } else if (field.type === 'select' || field.type === 'mic') {
        input = el('select', { id })
        input.addEventListener('change', () => commit(field.path, input.value))
        if (field.type === 'mic') {
          const refresh = el('button', { type: 'button', textContent: 'Refresh', title: 'List the microphones (asks Windows for the microphone once, to read their names)' })
          refresh.addEventListener('click', () => loadMics(true))
          row.append(el('span', { className: 'mic' }, input, refresh))
        } else row.append(input)
      } else if (field.type === 'range') {
        input = el('input', { type: 'range', id, min: field.min, max: field.max, step: field.step })
        const out = el('output', { htmlFor: id })
        input.addEventListener('input', () => { out.textContent = Number(input.value).toFixed(2) + 'x' })
        input.addEventListener('change', () => commit(field.path, Number(input.value)))
        row.append(el('span', { className: 'speed' }, input, out))
        input.out = out
      } else if (field.type === 'words') {
        input = el('input', { type: 'text', id })
        input.addEventListener('change', () => commit(field.path, parseWords(input.value)))
        row.append(input)
      }
      const hint = el('div', { className: 'hint', textContent: field.hint || '' })
      if (field.hint) row.append(hint)
      sec.append(row)
      controls.set(field.path, { field, input, row, hint })
    }
    form.append(sec)
  }
}

function draw() {
  if (!view) return
  const eff = view.effective
  for (const [path, c] of controls) {
    const v = getPath(eff, path)
    const { field, input, hint } = c
    if (field.type === 'bool') input.checked = !!v
    else if (field.type === 'range') { input.value = v; input.out.textContent = Number(v).toFixed(2) + 'x' }
    else if (field.type === 'words') input.value = formatWords(v)
    else if (field.type === 'mic') fillMics(input, v)
    else {
      if (!input.options.length) for (const [val, text] of field.options) input.append(el('option', { value: val, textContent: text }))
      // keep a stored value that is not in the list (e.g. a voice typed into settings.json) selectable
      if (v != null && ![...input.options].some((o) => o.value === v)) input.append(el('option', { value: v, textContent: v }))
      input.value = v
    }
    const locked = view.locked.includes(path) || (field.type === 'words' && view.locked.includes('listen.words'))
    input.disabled = locked
    if (locked) { hint.textContent = 'Set by environment variable; unset it to change this here.'; hint.className = 'hint lock'; c.row.append(hint) }
    else { hint.textContent = field.hint || ''; hint.className = 'hint'; if (!field.hint) hint.remove() }
  }
  fileEl.textContent = view.meta.file
}

function fillMics(select, current) {
  select.textContent = ''
  select.append(el('option', { value: '', textContent: 'System default' }))
  for (const m of mics) select.append(el('option', { value: m.deviceId, textContent: m.label || 'Microphone ' + m.deviceId.slice(0, 6) }))
  if (current && !mics.some((m) => m.deviceId === current)) select.append(el('option', { value: current, textContent: 'Saved device (not found right now)' }))
  select.value = current || ''
}

// Device names are hidden until the page has had microphone permission once, so "Refresh" opens the microphone briefly to read them.
async function loadMics(askPermission = false) {
  try {
    if (askPermission) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    }
    mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
  } catch (err) {
    console.warn('microphone list unavailable', err && err.message)
  }
  draw()
}

document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('Reset all settings to their defaults? (Her screen position is kept.)')) return
  view = await window.nova.settingsReset()
  draw()
})
window.nova.onSettingsChanged(async () => { view = await window.nova.settingsGet(); draw() })

build()
window.nova.settingsGet().then((v) => { view = v; draw(); loadMics(false) })
