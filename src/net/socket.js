// Connection to the Nova backend (protocol v1, see backend/api/desktop.py). Reconnects with backoff.
const PROTOCOL = 1

export function createSocket({ url, onEvent, onStatus }) {
  let ws = null
  let attempt = 0
  let timer = null
  let closed = false

  function connect() {
    onStatus('connecting')
    try {
      ws = new WebSocket(url)
    } catch (err) {
      return schedule()
    }
    ws.onopen = () => {
      attempt = 0
      send({ type: 'hello', client: 'nova-desktop' })
      onStatus('online')
    }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg && msg.v === PROTOCOL) onEvent(msg)
    }
    ws.onclose = () => { onStatus('offline'); schedule() }
    ws.onerror = () => { try { ws.close() } catch {} }
  }

  function schedule() {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000))
  }

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ v: PROTOCOL, ...msg }))
    return true
  }

  connect()
  return {
    send,
    sendText(text) {
      const turn_id = 't' + Date.now().toString(36)
      return send({ type: 'user_text', turn_id, text, source: 'typed' }) ? turn_id : null
    },
    interrupt(turn_id) { send({ type: 'interrupt', turn_id }) },
    close() { closed = true; clearTimeout(timer); if (ws) ws.close() },
  }
}
