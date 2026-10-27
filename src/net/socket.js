// Connection to the Nova backend (protocol v1, see backend/api/desktop.py). Reconnects with backoff.
const PROTOCOL = 1

export function createSocket({ url, onEvent, onStatus, onAudio, onOpen }) {
  let ws = null
  let attempt = 0
  let timer = null
  let closed = false

  function connect() {
    onStatus('connecting')
    try {
      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
    } catch (err) {
      return schedule()
    }
    ws.onopen = () => {
      attempt = 0
      send({ type: 'hello', client: 'novaai-desktop' })
      onStatus('online')
      onOpen && onOpen()
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { decodeAudio(e.data); return }
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg && msg.v === PROTOCOL) onEvent(msg)
    }
    ws.onclose = () => { schedule() }
    ws.onerror = () => { try { ws.close() } catch {} }
  }

  // Binary frame: [u32 LE header_len][JSON header][int16 PCM]
  function decodeAudio(buf) {
    if (!onAudio || !(buf instanceof ArrayBuffer) || buf.byteLength < 4) return
    const n = new DataView(buf).getUint32(0, true)
    if (4 + n > buf.byteLength) return
    let header
    try { header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) } catch { return }
    if (header.kind !== 'audio' || header.fmt !== 's16le') return
    const bytes = buf.byteLength - 4 - n
    const pcm = new Int16Array(buf.slice(4 + n, 4 + n + (bytes - (bytes % 2))))   // slice: Int16Array needs an aligned offset
    onAudio(header, pcm)
  }

  // Backoff 1, 2, 4, 8, 15 s. `onStatus('offline', { attempt, retryMs })` tells the app when the next try is, so it can say so.
  function schedule() {
    if (closed) return
    clearTimeout(timer)
    const retryMs = Math.min(1000 * 2 ** attempt, 15000)
    attempt++
    onStatus('offline', { attempt, retryMs })
    timer = setTimeout(connect, retryMs)
  }

  // Try again now (tray "retry now"). Does nothing while a connection is open or being opened.
  function retryNow() {
    if (closed || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return
    clearTimeout(timer)
    connect()
  }

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ v: PROTOCOL, ...msg }))
    return true
  }

  connect()
  return {
    send,
    retryNow,
    sendText(text) {
      const turn_id = 't' + Date.now().toString(36)
      return send({ type: 'user_text', turn_id, text, source: 'typed' }) ? turn_id : null
    },
    // Speech cut out by the VAD: [u32 LE header_len][JSON header][int16 PCM, 16 kHz mono]. Goes to the local backend only.
    sendUtterance(turn_id, purpose, pcm) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      const head = new TextEncoder().encode(JSON.stringify({ v: PROTOCOL, kind: 'utterance', turn_id, purpose, sr: 16000, fmt: 's16le' }))
      const out = new Uint8Array(4 + head.length + pcm.byteLength)
      new DataView(out.buffer).setUint32(0, head.length, true)
      out.set(head, 4)
      out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 4 + head.length)
      ws.send(out)
      return true
    },
    // Active window (title already dropped for private windows) and the answer to a capture_request.
    window(w) { send({ type: 'window', ...w }) },
    screen(turn_id, shot) { send({ type: 'screen', turn_id, app: shot.app, title: shot.title, jpeg_b64: shot.jpeg_b64 }) },
    screenDenied(turn_id, reason) { send({ type: 'screen_denied', turn_id, reason }) },
    interrupt(turn_id) { send({ type: 'interrupt', turn_id }) },
    playback(p) { send({ type: 'playback', ...p }) },
    settings(s) { send({ type: 'settings', ...s }) },
    history(before_id, limit = 30) { return send({ type: 'history', before_id, limit }) },
    feedback(message_id, rating, notes) { return send({ type: 'feedback', message_id, rating, notes }) },
    react(message_id, emoji) { return send({ type: 'react', message_id, emoji }) },
    close() { closed = true; clearTimeout(timer); if (ws) ws.close() },
  }
}
