// Phase 10: the tray "Today" glance - the next few calendar events, from the backend's loopback-only GET /api/google/agenda.
// Shows nothing while Google is not connected or the backend is unreachable, so the menu never carries a dead entry.
// Only titles and times are read (the endpoint returns no descriptions and nothing from mail).
const SHOW = 3
const TITLE_MAX = 40
const REFRESH_MS = 5 * 60 * 1000
const STALE_MS = 2 * 60 * 1000
const FETCH_TIMEOUT_MS = 4000
const ORDER = 15

const pad = (n) => String(n).padStart(2, '0')
const short = (s, n = TITLE_MAX) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t }

// Menu lines for an agenda response: { authenticated, events:[{title,start,all_day,today}] } -> [{ label, enabled:false }] (empty = hide the section).
// Today's events that have not started are listed (all-day ones first as "All day"); with none left, one "nothing more today" line.
function glanceLines(agenda, now = new Date()) {
  if (!agenda || agenda.authenticated !== true || !Array.isArray(agenda.events)) return []
  const rows = []
  for (const e of agenda.events) {
    if (!e || !e.today || typeof e.title !== 'string') continue
    if (e.all_day) { rows.push({ at: -1, text: `All day  ${short(e.title)}` }); continue }
    const d = new Date(e.start)
    if (Number.isNaN(d.getTime()) || d.getTime() < now.getTime()) continue
    rows.push({ at: d.getTime(), text: `${pad(d.getHours())}:${pad(d.getMinutes())}  ${short(e.title)}` })
  }
  rows.sort((a, b) => a.at - b.at)
  if (!rows.length) return [{ label: 'Today: nothing more on the calendar', enabled: false }]
  const lines = rows.slice(0, SHOW).map((r) => ({ label: r.text, enabled: false }))
  if (rows.length > SHOW) lines.push({ label: `+${rows.length - SHOW} more today`, enabled: false })
  return lines
}

async function fetchAgenda(base, fetchFn = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchFn(String(base).replace(/\/+$/, '') + '/api/google/agenda?days=1&limit=15', { signal: ctl.signal })
    return r.ok ? await r.json() : null
  } catch { return null } finally { clearTimeout(t) }
}

// deps: { registerTraySection, SECTION, getBase, openHome, rebuildTray, fetchFn?, now?, setTimer?, clearTimer? }
function registerToday(deps) {
  const { registerTraySection, getBase, openHome, rebuildTray, fetchFn, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval } = deps
  let agenda = null, at = 0, inflight = null, timer = null

  function refresh() {
    if (inflight) return inflight
    inflight = fetchAgenda(getBase(), fetchFn).then((a) => { agenda = a; at = now(); rebuildTray() }).finally(() => { inflight = null })
    return inflight
  }

  registerTraySection(ORDER, () => {
    if (now() - at > STALE_MS) refresh()      // the menu is built synchronously; the answer arrives and rebuilds it
    const lines = glanceLines(agenda, new Date(now()))
    return lines.length ? [...lines, { label: 'Open agenda...', click: () => openHome('agenda') }] : []
  })

  return {
    refresh,
    start() { if (!timer) { refresh(); timer = setTimer(refresh, REFRESH_MS); if (timer && timer.unref) timer.unref() } },
    stop() { if (timer) { clearTimer(timer); timer = null } },
  }
}

module.exports = { glanceLines, fetchAgenda, registerToday, ORDER, SHOW, REFRESH_MS }
