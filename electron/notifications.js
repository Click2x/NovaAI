// Phase 8, main process: the tray "Notifications" section (what is waiting in the overlay's notification centre) and the
// "is something fullscreen in front" check the speak rule needs. The cards themselves live in the overlay (src/ui/notify.js); the renderer
// reports the list here over IPC so the tray can show a count, and "Clear all" goes back to it.
// Pure logic with injected Electron pieces, tested with node --test.
const ORDER = 16          // Nova group, below "Today" (15)
const SHOWN = 6
const TITLE_MAX = 46

const short = (s, n = TITLE_MAX) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t }

// Is the foreground window covering a whole display? `bounds` is the tracker's window rectangle, `display` Electron's display
// ({ bounds:{x,y,width,height}, scaleFactor }). The tracker reports physical pixels (get-windows may report DIPs), so either unit counts.
// A maximized window leaves the taskbar out and is smaller than the display, so it does not count; the desktop itself ("Program Manager")
// is a full-screen window but not a fullscreen app.
function isFullscreenWindow(win, display) {
  if (!win || !win.bounds || !display || !display.bounds) return null
  const app = String(win.app || '').toLowerCase()
  if (app === 'explorer' && /program manager|^$/i.test(String(win.title || ''))) return false
  const { width: w, height: h } = win.bounds
  const { width: dw, height: dh } = display.bounds
  const sf = display.scaleFactor || 1
  if (![w, h, dw, dh].every(Number.isFinite) || w <= 0 || h <= 0) return null
  const covers = (cw, ch) => w >= cw - 2 && h >= ch - 2
  return covers(dw, dh) || covers(Math.round(dw * sf), Math.round(dh * sf))
}

function trayLines(items) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return []
  const out = [{ label: `Notifications (${list.length})`, enabled: false }]
  for (const it of list.slice(0, SHOWN)) out.push({ label: '   ' + short(it && it.title), enabled: false })
  if (list.length > SHOWN) out.push({ label: `   +${list.length - SHOWN} more`, enabled: false })
  return out
}

// deps: { registerTraySection, rebuildTray, clear }  clear() asks the overlay to dismiss every card.
function registerNotifications(deps) {
  const { registerTraySection, rebuildTray, clear } = deps
  let items = []
  registerTraySection(ORDER, () => {
    const lines = trayLines(items)
    return lines.length ? [...lines, { label: 'Clear notifications', click: () => clear() }] : []
  })
  return {
    // The overlay's list: [{ id, title }]. Rebuilds the tray only when what it shows changed.
    setItems(next) {
      const clean = (Array.isArray(next) ? next : []).slice(0, 30).map((n) => ({ id: String((n && n.id) || ''), title: short(n && n.title) }))
      const same = clean.length === items.length && clean.every((n, i) => n.id === items[i].id && n.title === items[i].title)
      items = clean
      if (!same) rebuildTray()
    },
    count: () => items.length,
  }
}

module.exports = { ORDER, SHOWN, isFullscreenWindow, trayLines, registerNotifications }
