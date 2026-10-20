// Overlay surfaces for phase 7: the media card (a picture or clip she made), the thumbs/reaction strip under her last reply, the history
// drawer and the "heard you" cue. Everything from the backend goes into the page through textContent or a checked URL, never innerHTML.
// `mediaSrc` and `timeLabel` are pure and tested with node --test; the create* functions need a DOM.

// Where a picture or clip is loaded from: only the backend's own image/video routes (relative paths), or a small inline image.
export function mediaSrc(base, value) {
  if (typeof value !== 'string' || !value) return null
  if (/^\/api\/(images|videos)\/[A-Za-z0-9_\-./?=&]+$/.test(value) && !value.includes('..') && /^https?:\/\//.test(base || '')) return base.replace(/\/+$/, '') + value
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) return value
  return null
}

export function timeLabel(iso, now = new Date()) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm
}

const REACTIONS = ['❤️', '😂', '👍']

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

// Buttons for one reply: thumbs up/down (a rating is saved once) and a few reactions (toggle). Returns { root, rated(rating), reacted(list) }.
function rateButtons({ onRate, onReact }) {
  const root = el('div', 'rate')
  const up = el('button', 'rb', '👍'); up.title = 'Good response'
  const down = el('button', 'rb', '👎'); down.title = 'Bad response'
  up.onclick = () => onRate('up')
  down.onclick = () => onRate('down')
  root.append(up, down)
  const heart = {}
  for (const e of REACTIONS.filter((x) => x !== '👍')) {
    const b = el('button', 'rb', e)
    b.title = 'React ' + e
    b.onclick = () => onReact(e)
    heart[e] = b
    root.append(b)
  }
  return {
    root,
    rated(rating) {
      up.classList.toggle('on', rating === 'up'); down.classList.toggle('on', rating === 'down')
      up.disabled = down.disabled = !!rating
    },
    reacted(list) { for (const [e, b] of Object.entries(heart)) b.classList.toggle('on', (list || []).includes(e)) },
  }
}

// The strip under her last reply: appears when a turn ends with a saved message, goes after `lingerMs`.
export function createActions(root, { send, lingerMs = 25000 }) {
  let id = null
  let timer = null
  const buttons = rateButtons({
    onRate: (r) => id && send({ type: 'feedback', message_id: id, rating: r }),
    onReact: (e) => id && send({ type: 'react', message_id: id, emoji: e }),
  })
  root.append(buttons.root)
  return {
    show(messageId) {
      if (!Number.isInteger(messageId) || messageId <= 0) return
      id = messageId
      buttons.rated(null); buttons.reacted([])
      root.classList.add('show')
      clearTimeout(timer)
      timer = setTimeout(() => this.hide(), lingerMs)
    },
    hide() { root.classList.remove('show'); id = null },
    ack(m) { if (m.message_id === id) buttons.rated(m.rating) },
    reacted(m) { if (m.message_id === id) buttons.reacted(m.reactions) },
    current: () => id,
  }
}

// The card for a picture or clip she made. `pending` shows a placeholder until the picture lands (story scenes finish in the background).
export function createMediaCard(root, { base, lingerMs = 60000 }) {
  let timer = null
  const body = el('div', 'mbody')
  const cap = el('div', 'mcap')
  const close = el('button', 'mclose', '×')
  close.title = 'Close'
  close.onclick = () => hide()
  root.append(close, body, cap)

  function hide() { clearTimeout(timer); root.classList.remove('show'); body.replaceChildren() }
  function put(node, caption) {
    body.replaceChildren(node)
    cap.textContent = caption
    root.classList.add('show')
    clearTimeout(timer)
    timer = setTimeout(hide, lingerMs)
  }
  function image(src) {
    const img = el('img'); img.alt = 'A picture from Nova'; img.src = src
    img.onerror = () => { cap.textContent = 'The picture could not be loaded.' }
    return img
  }
  return {
    // media: the turn_end `media` object. Returns whether anything was shown.
    show(media) {
      if (!media) return false
      const vid = mediaSrc(base, media.video_url)
      const img = mediaSrc(base, media.image_url || media.image_data)
      if (vid) {
        const v = el('video'); v.src = vid; v.controls = true; v.loop = true; v.muted = true; v.playsInline = true
        put(v, 'A clip from Nova')
        v.play().catch(() => {})
        return true
      }
      if (img) { put(image(img), 'A picture from Nova'); return true }
      if (media.pending_image) { put(el('div', 'mwait', 'Making the picture...'), 'It will show up here when it is ready.'); return true }
      return false
    },
    // A picture that finished after its turn (the `media` message).
    late(imageUrl) {
      const src = mediaSrc(base, imageUrl)
      if (src) put(image(src), 'A picture from Nova')
    },
    hide,
    visible: () => root.classList.contains('show'),
  }
}

// The history drawer: older messages on demand, oldest at the top, newest at the bottom.
export function createDrawer(root, { base, send }) {
  const head = el('div', 'dhead')
  const title = el('span', 'dtitle', 'History')
  const close = el('button', 'mclose', '×'); close.title = 'Close'
  head.append(title, close)
  const list = el('div', 'dlist')
  const more = el('button', 'dmore', 'Load older')
  list.append(more)          // the button sits above the oldest row
  root.append(head, list)
  const rows = new Map()           // message id -> { buttons }
  let oldest = null
  let loading = false
  let hasMore = false

  const open = () => { root.classList.add('show'); if (!rows.size) request() }
  const hide = () => root.classList.remove('show')
  function request() {
    if (loading) return
    loading = true
    more.disabled = true
    send({ type: 'history', before_id: oldest || undefined, limit: 30 })
  }
  close.onclick = hide
  more.onclick = request

  function row(m) {
    const r = el('div', 'drow ' + (m.sender === 'user' ? 'u' : 'a'))
    const meta = el('div', 'dmeta', (m.sender === 'user' ? 'You' : 'Nova') + (m.timestamp ? '  ' + timeLabel(m.timestamp) : ''))
    r.append(meta)
    const img = mediaSrc(base, m.image_url)
    if (img) { const i = el('img', 'dimg'); i.loading = 'lazy'; i.src = img; i.alt = 'picture'; r.append(i) }
    const vid = mediaSrc(base, m.video_url)
    if (vid) { const v = el('video', 'dimg'); v.src = vid; v.controls = true; v.preload = 'metadata'; r.append(v) }
    if (m.text) r.append(el('div', 'dtext', m.text))
    if (m.sender !== 'user' && Number.isInteger(m.id)) {
      const b = rateButtons({ onRate: (x) => send({ type: 'feedback', message_id: m.id, rating: x }), onReact: (e) => send({ type: 'react', message_id: m.id, emoji: e }) })
      b.reacted(m.reactions)
      rows.set(m.id, b)
      r.append(b.root)
    }
    return r
  }

  return {
    open, hide, toggle() { root.classList.contains('show') ? hide() : open() },
    visible: () => root.classList.contains('show'),
    // The backend's `history` page: older rows go above what is shown.
    page(m) {
      loading = false
      const msgs = Array.isArray(m.messages) ? m.messages : []
      const before = list.scrollHeight
      const frag = document.createDocumentFragment()
      for (const x of msgs) frag.append(row(x))
      more.after(frag)
      if (msgs.length) oldest = msgs[0].id
      hasMore = !!m.has_more
      more.disabled = false
      more.style.display = hasMore ? 'block' : 'none'
      list.scrollTop = m.before_id ? list.scrollHeight - before : list.scrollHeight
    },
    ack(m) { const b = rows.get(m.message_id); if (b) b.rated(m.rating) },
    reacted(m) { const b = rows.get(m.message_id); if (b) b.reacted(m.reactions) },
    failed() { loading = false; more.disabled = false },
  }
}

// "Heard you": a short note near the microphone dot when speech was taken as a command or the wake word, so she does not look deaf while
// the model loads. `text` is what was heard (local only).
export function createHeard(root, { lingerMs = 1800 } = {}) {
  let timer = null
  return {
    show(text) {
      const t = String(text || '').trim()
      root.textContent = t ? `Heard: ${t.length > 60 ? t.slice(0, 57) + '...' : t}` : 'Heard you'
      root.classList.add('show')
      clearTimeout(timer)
      timer = setTimeout(() => root.classList.remove('show'), lingerMs)
    },
    hide() { clearTimeout(timer); root.classList.remove('show') },
  }
}
