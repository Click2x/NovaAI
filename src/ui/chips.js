// Tool chips: small labels under the speech bubble showing what Nova is doing besides talking ("Searching the web", "Looking at your screen").
// A chip appears when the backend sends `tool{turn_id,name}`, and goes away when her first sentence of the turn arrives or the turn ends.
const LABELS = {
  screen: 'Looking at your screen',
  web_search: 'Searching the web',
  fetch_page: 'Reading a page',
  get_weather: 'Checking the weather',
  create_note: 'Writing a note',
  generate_image: 'Making an image',
  write_file: 'Writing a file',
  create_pdf: 'Making a PDF',
  get_calendar: 'Checking your calendar',
  add_calendar_event: 'Adding to your calendar',
  get_emails: 'Checking your email',
  drive_search: 'Searching your Drive',
  ask_claude: 'Asking Claude',
  control_media: 'Controlling media',
  get_system_info: 'Checking the system',
}

export function chipLabel(name) {
  const key = String(name || '').trim()
  if (!key) return 'Working on it'
  if (LABELS[key]) return LABELS[key]
  const words = key.replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1) + '...'
}

// `el` is the container; `doc` is injectable so the logic can be tested without a DOM.
export function createChips(el, doc = typeof document !== 'undefined' ? document : null) {
  const active = new Map()         // chip key -> element

  function render() {
    el.classList.toggle('show', active.size > 0)
  }

  return {
    // `status` 'end' removes the chip; anything else (including a missing status) shows it.
    tool({ turn_id, name, status }) {
      const key = `${turn_id}:${name}`
      if (status === 'end') return this.remove(key)
      if (active.has(key)) return
      const chip = doc.createElement('span')
      chip.className = 'chip'
      chip.textContent = chipLabel(name)
      el.appendChild(chip)
      active.set(key, chip)
      render()
    },
    remove(key) {
      const chip = active.get(key)
      if (!chip) return
      if (chip.remove) chip.remove()
      active.delete(key)
      render()
    },
    // First sentence of the turn, or the turn ended: whatever she was doing is done.
    clear() {
      for (const key of [...active.keys()]) this.remove(key)
    },
    labels() { return [...active.values()].map((c) => c.textContent) },
  }
}
