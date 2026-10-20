// Tray menu as a registry of sections, so a phase adds its entries with registerTraySection() instead of editing one big template.
//
// A section is a function (ctx) -> array of Electron menu items (or nothing). Sections are ordered by `order`; a separator goes between
// two sections whose order differs in the tens digit, so 10 and 11 sit in one group ("Nova") and 40 starts the next ("Services").
// Quit is appended by buildTemplate. A section that throws is skipped (and reported) so one broken entry never loses the whole menu.
// Pure logic: main.js builds `ctx` and hands the template to Electron's Menu.
const SECTION = Object.freeze({ NOVA: 10, VOICE: 20, SCREEN: 30, SERVICES: 40, CODE: 50, DEBUG: 60 })

function createTrayRegistry() {
  const sections = []   // { order, fn, seq }
  let seq = 0

  function registerTraySection(order, fn) {
    if (typeof order !== 'number' || !Number.isFinite(order)) throw new TypeError('tray section order must be a number')
    if (typeof fn !== 'function') throw new TypeError('tray section must be a function')
    sections.push({ order, fn, seq: seq++ })
    return () => { const i = sections.findIndex((s) => s.fn === fn); if (i >= 0) sections.splice(i, 1) }
  }

  // `onError(err, section)` is called for a section that threw.
  function buildTemplate(ctx, { quit, onError } = {}) {
    const out = []
    let lastGroup = null
    for (const s of [...sections].sort((a, b) => a.order - b.order || a.seq - b.seq)) {
      let items
      try { items = s.fn(ctx) } catch (err) { if (onError) onError(err, s); continue }
      if (!Array.isArray(items) || !items.length) continue
      const group = Math.floor(s.order / 10)
      if (out.length && group !== lastGroup) out.push({ type: 'separator' })
      lastGroup = group
      out.push(...items)
    }
    if (quit) { if (out.length) out.push({ type: 'separator' }); out.push({ label: 'Quit', click: quit }) }
    return out
  }

  return { registerTraySection, buildTemplate, count: () => sections.length }
}

const shared = createTrayRegistry()

module.exports = { SECTION, createTrayRegistry, registerTraySection: shared.registerTraySection, buildTemplate: shared.buildTemplate }
