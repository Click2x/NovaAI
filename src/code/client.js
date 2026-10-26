// Phase 13: the Code window's connection to the agent WebSocket (protocol v1, /api/agent/ws). Opens, sends `start`, keeps a ping going,
// reconnects with a growing delay after an unexpected drop (resuming the same session), and hands every parsed message to `onMessage`.
// WebSocket and timers are injected so node --test can drive it with a fake socket.
import * as A from './actions.js'

export const PING_MS = 25000
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000]

export function createClient({ url, WebSocketImpl = globalThis.WebSocket, onMessage, onState, startOptions, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval }) {
  let ws = null, wanted = false, tries = 0, retryTimer = null, pingTimer = null, resumeId = null, generation = 0

  function open() {
    clearTimer(retryTimer); retryTimer = null
    const mine = ++generation
    onState('connecting')
    let sock
    try { sock = new WebSocketImpl(url) } catch { onState('closed'); schedule(); return }
    ws = sock
    sock.onopen = () => {
      if (mine !== generation) return
      tries = 0
      onState('open')
      raw(A.start({ ...(startOptions ? startOptions() : {}), ...(resumeId ? { resume: resumeId } : {}) }))
      clearRepeat(pingTimer)
      pingTimer = setRepeat(() => raw(A.ping()), PING_MS)
      if (pingTimer && pingTimer.unref) pingTimer.unref()
    }
    sock.onmessage = (ev) => {
      if (mine !== generation) return
      let m
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
      if (m && typeof m === 'object' && m.type) {
        if (m.type === 'started' && typeof m.session_id === 'string') resumeId = m.session_id      // a drop resumes this session
        onMessage(m)
      }
    }
    sock.onclose = () => {
      if (mine !== generation) return
      clearRepeat(pingTimer); pingTimer = null
      ws = null
      onState('closed')
      schedule()
    }
    sock.onerror = () => {}                      // onclose follows
  }

  function schedule() {
    if (!wanted) return
    const delay = BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]
    tries++
    retryTimer = setTimer(open, delay)
  }

  function raw(obj) {
    if (!ws || ws.readyState !== 1) return false
    try { ws.send(JSON.stringify(obj)); return true } catch { return false }
  }

  return {
    connect() { wanted = true; tries = 0; open() },
    send: raw,
    // Drop the connection on purpose and open a new one: `resume` = a session id to continue, or null for a fresh session.
    restart(resume = null) {
      resumeId = resume
      generation++                                   // ignore events from the old socket
      clearRepeat(pingTimer); pingTimer = null
      if (ws) { try { ws.close() } catch { /* already closed */ } ws = null }
      wanted = true; tries = 0
      open()
    },
    close() {
      wanted = false; generation++
      clearTimer(retryTimer); clearRepeat(pingTimer)
      if (ws) { try { ws.close() } catch { /* already closed */ } ws = null }
      onState('closed')
    },
    sessionId: () => resumeId,
    isOpen: () => !!ws && ws.readyState === 1,
  }
}
