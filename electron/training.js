// Phase 11: the tray "Training" entry - how many knowledge-pool pairs wait for review, from the backend's loopback-only
// GET /api/training/pending-count. Shown only while there is something to review (a zero count adds no tray clutter), and a click opens
// Home on the Training panel. Approving stays in the web app; nothing is changed from here.
const REFRESH_MS = 5 * 60 * 1000
const STALE_MS = 2 * 60 * 1000
const FETCH_TIMEOUT_MS = 4000
const ORDER = 17            // Nova group, after Notifications (16)
const PANEL = 'training'

function label(n) { return n === 1 ? 'Review 1 training pair...' : `Review ${n} training pairs...` }

// Response -> a non-negative integer, or null when it is not the shape we know.
function parseCount(body) {
  if (!body || typeof body !== 'object') return null
  const n = body.pending
  return Number.isInteger(n) && n >= 0 ? n : null
}

async function fetchPending(base, fetchFn = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetchFn(String(base).replace(/\/+$/, '') + '/api/training/pending-count', { signal: ctl.signal })
    return r.ok ? parseCount(await r.json()) : null
  } catch { return null } finally { clearTimeout(t) }
}

// deps: { registerTraySection, getBase, openHome, rebuildTray, fetchFn?, now?, setTimer?, clearTimer? }
function registerTraining(deps) {
  const { registerTraySection, getBase, openHome, rebuildTray, fetchFn, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval } = deps
  let count = null, at = 0, inflight = null, timer = null

  function refresh() {
    if (inflight) return inflight
    inflight = fetchPending(getBase(), fetchFn).then((n) => {
      const changed = n !== count
      count = n; at = now()
      if (changed) rebuildTray()
    }).finally(() => { inflight = null })
    return inflight
  }

  registerTraySection(ORDER, () => {
    if (now() - at > STALE_MS) refresh()      // the menu is built synchronously; a changed answer rebuilds it
    if (!count) return []                     // unknown (backend down) or nothing to review
    return [{ label: label(count), click: () => openHome(PANEL) }]
  })

  return {
    refresh,
    count: () => count,
    start() { if (!timer) { refresh(); timer = setTimer(refresh, REFRESH_MS); if (timer && timer.unref) timer.unref() } },
    stop() { if (timer) { clearTimer(timer); timer = null } },
  }
}

module.exports = { label, parseCount, fetchPending, registerTraining, ORDER, PANEL, REFRESH_MS }
