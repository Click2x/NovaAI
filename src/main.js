import { createAvatar } from './avatar/avatar.js'
import { createOrb } from './ui/orb.js'
import { createLayout } from './ui/layout.js'
import { createExpressionController } from './avatar/expression.js'
import { createSocket } from './net/socket.js'
import { createEvents } from './net/events.js'
import { createBubble } from './ui/bubble.js'
import { createInput } from './ui/input.js'
import { createRadial } from './ui/radial.js'
import { createLatency } from './ui/latency.js'
import { createChips } from './ui/chips.js'
import { createPacer } from './ui/pacing.js'
import { createActions, createMediaCard, createDrawer, createHeard } from './ui/continuity.js'
import { createNotifier, cardFromNotify, cardFromConfirm, cardsFromCatchup, CONFIRM_TEXT } from './ui/notify.js'
import { decideProactive } from './ui/speakrule.js'
import { createLipSync } from './avatar/lipsync.js'
import { createPlayer } from './voice/player.js'
import { createVoiceState } from './voice/state.js'
import { createVad, wavStream, micStream } from './voice/vad.js'

const canvas = document.getElementById('stage')
const statusEl = document.getElementById('status')
const HIT_ALPHA = 16        // pixels at least this opaque count as "on the avatar"
const CLICK_SLOP_PX = 4     // pointer movement below this on release counts as a click, not a drag

const state = { cursor: null, interactive: false, dragging: false, net: 'connecting', turn: null, audioTurn: null }
const smokeLog = (line) => { try { window.nova.smokeLog(line) } catch {} }   // test hook, a no-op unless NOVA_SMOKE_LOG is set

window.nova.onDebug((on) => document.body.classList.toggle('debug', on))
window.nova.onCursor((c) => { state.cursor = c })

function setInteractive(on) {
  if (on === state.interactive) return
  state.interactive = on
  window.nova.setInteractive(on)
}

async function boot() {
  let config = await window.nova.getConfig()   // re-read when the settings change (see the settings handler below)
  // What she looks like: a small orb by default (it swells with her voice, no model to load), or the VRM avatar when the user chose one.
  const orbMode = config.display.style !== 'avatar' || !config.display.hasAvatar      // no avatar file chosen: the orb
  const orbEl = document.getElementById('orb')
  const grab = orbMode ? orbEl : canvas        // the element that is dragged, clicked and right-clicked
  const sizeOrb = (px) => document.body.style.setProperty('--orb', px + 'px')
  document.body.classList.toggle('orb', orbMode)
  let avatar
  if (orbMode) {
    avatar = createOrb(orbEl, { size: config.display.orbPx })
    sizeOrb(avatar.size())
  } else {
    try {
      avatar = await createAvatar(canvas, 'nova-asset://avatar.vrm')
    } catch (err) {
      statusEl.textContent = 'avatar failed: ' + err.message
      document.body.classList.add('debug')
      console.error(err)
      return
    }
  }

  const expression = createExpressionController(avatar)
  const bubble = createBubble(document.getElementById('bubble'))
  const latency = createLatency(document.getElementById('latency'))
  const chips = createChips(document.getElementById('chips'))
  const events = createEvents()
  let socket = null

  // ── phase 7: bubble text paced by playback, media card, thumbs/reactions, history drawer, "heard you" ──
  const sendMsg = (m) => socket && socket.send(m)
  const pacer = createPacer({
    show: (text) => { bubble.setText(text); smokeLog(`bubble ${JSON.stringify(text.slice(-80))}`) },
    onDone: () => bubble.fadeSoon(),
  })
  const card = createMediaCard(document.getElementById('media'), { base: config.backendHttp })
  const actions = createActions(document.getElementById('actions'), { send: sendMsg })
  const drawer = createDrawer(document.getElementById('drawer'), { base: config.backendHttp, send: sendMsg })
  const heard = createHeard(document.getElementById('heard'))
  const histBtn = document.getElementById('histbtn')
  histBtn.onclick = () => { drawer.toggle(); histBtn.classList.toggle('open', drawer.visible()); if (drawer.visible()) card.hide() }

  // ── phase 8: notification centre (cards with buttons), yes/no for held tool calls, catch-up, speak rule ──
  const SEEN_KEY = 'nova.lastSeenMessageId'      // the newest chat message this app has shown or been told about (per install; only a convenience)
  const lastSeen = () => { try { const v = Number(localStorage.getItem(SEEN_KEY)); return Number.isInteger(v) && v > 0 ? v : null } catch { return null } }
  const noteSeen = (id) => { if (!Number.isInteger(id) || id <= 0) return; try { if (id > (lastSeen() || 0)) localStorage.setItem(SEEN_KEY, String(id)) } catch {} }
  const notifier = createNotifier(document.getElementById('notes'), {
    send: sendMsg,
    onChange: (list) => { try { window.nova.notesState(list) } catch {} },
    local: (card, actionId) => {
      notifier.remove(card.id)
      if (card.kind === 'confirm') {
        // The buttons send the same words typed chat uses: a clear "yes" runs the held tool call, anything else cancels it (api/chat.py resolve_pending_confirmation).
        interruptSpeech()
        if (!sendText(CONFIRM_TEXT[actionId])) bubble.say("I can't reach the backend right now.")
        smokeLog(`confirm answered ${actionId}`)
      } else if (card.kind === 'catchup' && actionId === 'open' && !drawer.visible()) histBtn.click()
    },
  })
  window.nova.onNotesClear(() => notifier.clear())
  const popAllowed = () => decideProactive(config.proactive, { now: new Date() }).pop       // false during quiet hours: cards wait behind the bell
  // Things the user can move (and lock in place): grips appear above them while the layout is unlocked.
  const layout = createLayout(document, {
    els: { bubble: document.getElementById('bubble'), inputbox: document.getElementById('inputbox'), histbtn: document.getElementById('histbtn'), actions: document.getElementById('actions') },
    isLocked: () => !!config.display.layout.locked,
    save: (ui) => window.nova.settingsSet({ display: { layout: { ui } } }),
  })
  layout.apply(config.display.layout)
  const hotEls = [...document.querySelectorAll('.hot'), ...layout.grips]
  // Elements that take the mouse while the cursor is over them (shown ones only); everywhere else stays click-through.
  const overHot = (c) => hotEls.some((e) => {
    if (getComputedStyle(e).display === 'none') return false
    const r = e.getBoundingClientRect()
    return c.x >= r.left && c.x <= r.right && c.y >= r.top && c.y <= r.bottom
  })
  let lipsync = null
  let mouthPeak = 0

  // ── voice in: state machine + VAD (started further down, once the socket exists) ──
  const micEl = document.getElementById('mic')
  const voice = createVoiceState({ echoMode: config.echoMode }, {
    onChange: (s, from) => { micEl.className = (micEl.classList.contains('on') ? 'on ' : '') + s; smokeLog(`voice ${from}>${s}`) },
  })
  let vad = null
  let lastMouthLog = 0

  // ── voice: audio frames from the backend -> gapless player -> lip-sync ────
  const player = createPlayer({
    onPlayback: (p) => {
      socket && socket.playback(p)
      smokeLog(`playback ${p.state} turn=${p.turn_id} sentence=${p.sentence_id}`)
      if (p.state === 'start') pacer.started(p.turn_id, p.sentence_id)
      else pacer.ended(p.turn_id, p.sentence_id)
      if (p.state === 'start') voice.audioStarted()
      else setTimeout(() => { if (!player.isPlaying()) { state.audioTurn = null; voice.audioEnded() } }, 0)   // after the player dropped the finished clip
    },
    onFirstAudio: () => {
      latency.mark('heard')
      const snap = latency.snapshot()
      smokeLog(`heard first audio at ${Math.round(snap.heard)} ms after the text was sent`)
    },
  })

  // Stop talking now: tell the backend (cancels generation and drops queued sentences), silence the player, close the mouth.
  function interruptSpeech() {
    const turns = new Set([state.turn, state.audioTurn].filter(Boolean))
    if (!turns.size) return
    for (const t of turns) { if (socket) socket.interrupt(t); player.stop(t) }
    if (lipsync) lipsync.reset()
    voice.interrupted()
    smokeLog(`interrupt ${[...turns].join(',')}`)
  }

  // ── backend events: modules subscribe with events.on(type, fn) (src/net/events.js) ──
  events.on('turn_start', (m) => {
    state.turn = m.turn_id
    voice.turnStarted()
    bubble.startTurn()
    pacer.begin(m.turn_id, config.backendSettings.tts)     // with speech on, her words appear as she says them
    actions.hide()
  })
  events.on('turn_start', () => notifier.remove('confirm'))      // a new turn answers (or abandons) the held tool call
  events.on('sentence', (m) => {
    if (m.turn_id === latency.snapshot()?.turn_id) latency.mark('sentence')
    chips.clear()
    pacer.sentence(m.turn_id, m.sentence_id, m.text)
    expression.set(m.emotion)
  })
  events.on('turn_end', (m) => {
    if (m.metrics && m.turn_id === latency.snapshot()?.turn_id) {
      latency.metrics(m.metrics)
      smokeLog(`turn_end ${m.turn_id} interrupted=${m.interrupted} metrics=${JSON.stringify(m.metrics)}`)
    }
    pacer.finish(m.turn_id, m.interrupted)         // fades the bubble once the last sentence has been said
    chips.clear()
    if (m.media && card.show(m.media)) smokeLog(`media card ${JSON.stringify(Object.keys(m.media))}`)
    if (!m.interrupted) actions.show(m.message_id)
    noteSeen(m.message_id)
    if (state.turn === m.turn_id) state.turn = null
    voice.turnEnded()
  })
  events.on('media', (m) => { card.late(m.image_url); smokeLog(`media late message=${m.message_id}`) })
  events.on('history', (m) => { drawer.page(m); smokeLog(`history page ${(m.messages || []).length} has_more=${!!m.has_more}`) })
  events.on('feedback_ack', (m) => { actions.ack(m); drawer.ack(m); smokeLog(`feedback_ack ${m.message_id} ${m.rating}`) })
  events.on('react_ack', (m) => { actions.reacted(m); drawer.reacted(m); smokeLog(`react_ack ${m.message_id} ${(m.reactions || []).join('')}`) })
  events.on('transcript', (m) => onTranscript(m))
  // She saved something from what the user said (backend learn.py): say so, quietly, and point at where it can be changed.
  events.on('remembered', (m) => {
    const facts = (Array.isArray(m.facts) ? m.facts : []).map((f) => String(f && f.text || '').replace(/^the user\b/i, 'You').slice(0, 200)).filter(Boolean)
    if (!facts.length) return
    notifier.add({ id: 'mem-' + (m.turn_id || Date.now().toString(36)), kind: 'message', title: 'I will remember that', body: facts.join('\n') + '\n(Tray > What Nova remembers: change or delete anything.)', actions: [], local: true }, { pop: popAllowed() })
    smokeLog(`remembered ${facts.length}`)
  })
  events.on('tool', (m) => {
    chips.tool(m)
    smokeLog(`chip ${m.name} ${chips.labels().join('|')}`)
  })
  events.on('capture_request', (m) => onCaptureRequest(m))
  events.on('state', (m) => { if (m.phase === 'busy') smokeLog('state busy (gpu_busy)') })
  events.on('confirm', (m) => { const c = cardFromConfirm(m); if (c) { notifier.add(c); smokeLog(`confirm card ${m.tool}`) } })
  events.on('notify', (m) => {
    const c = cardFromNotify(m)
    if (c) { notifier.add(c, { pop: popAllowed() }); smokeLog(`notify ${c.kind} ${c.id} actions=${c.actions.map((a) => a.id).join(',')}`) }
  })
  events.on('notify_ack', (m) => { notifier.ack(m); smokeLog(`notify_ack ${m.id} ok=${m.ok}`) })
  events.on('catchup', (m) => {
    for (const c of cardsFromCatchup(m)) notifier.add(c, { pop: popAllowed() })
    noteSeen(m.latest_id)
    smokeLog(`catchup messages=${(m.messages || []).length} reviews=${(m.reviews || []).length} latest=${m.latest_id}`)
  })
  // A message she starts herself (reminder, outreach). The speak rule (user settings) decides whether it is also said aloud; quiet hours
  // keep it off the screen and put it behind the bell instead.
  events.on('proactive', async (m) => {
    noteSeen(m.message_id)
    const rule = config.proactive
    let fg = {}
    if (rule.speak !== 'off') { try { fg = await window.nova.foregroundState() } catch {} }
    const d = decideProactive(rule, { now: new Date(), visible: fg.visible, fullscreen: fg.fullscreen ?? null, ttsOn: !!config.backendSettings.tts, talking: player.isPlaying() || !!state.turn })
    smokeLog(`proactive ${d.reason} speak=${d.speak} pop=${d.pop}`)
    if (d.pop) {
      bubble.say(m.text)
      expression.set(m.emotion || 'neutral')
    } else {
      notifier.add({ id: 'msg-' + (m.id || Date.now().toString(36)), kind: 'message', title: 'Nova said', body: m.text, actions: [], local: true }, { pop: false })
    }
    if (d.speak && typeof m.id === 'string' && socket) {
      player.allow(m.id)
      socket.send({ type: 'speak', id: m.id, text: m.text })
    }
  })
  events.on('error', (m) => {
    if (m.code === 'tts_failed') { pacer.release(m.turn_id); return }      // text only from here: show what is waiting for audio
    if (m.code === 'stt_unavailable') { bubble.say("I can't hear you yet: speech recognition isn't installed on my backend. You can still type to me."); return }
    if (m.code === 'history_failed') drawer.failed()
    bubble.say('Something went wrong: ' + m.message)
  })
  events.on('hello_ack', (m) => { try { window.nova.backendVersion(m.backend_version) } catch {} })   // main compares it with the app version (electron/version.js)
  events.on('hello_ack', (m) => smokeLog(`hello_ack protocol=${m.protocol} backend=${m.backend_version || '-'} features=${(m.features || []).join(',')}`))

  // Binary audio frame -> player. Frames of an interrupted turn are dropped by the player.
  function onAudio(h, pcm) {
    state.audioTurn = h.turn_id
    if (h.turn_id === latency.snapshot()?.turn_id) latency.mark('frame')
    smokeLog(`audio turn=${h.turn_id} sentence=${h.sentence_id} samples=${pcm.length} sr=${h.sr} dur_ms=${h.dur_ms} tts_ms=${h.tts_ms} at=${h.t_ms}`)
    pacer.audio(h.turn_id, h.sentence_id, h.dur_ms)
    player.enqueue(h.turn_id, h.sentence_id, pcm, h.sr)
    if (!lipsync) lipsync = createLipSync({ analyser: player.analyser(), apply: (shapes) => avatar.setVisemes(shapes) })
  }

  // ── active window + screen looks: the main process tracks the window and takes the screenshot, only when the backend asks ──
  let lastWindow = null
  const sendWindow = () => { if (lastWindow && socket) socket.window(lastWindow) }
  const adoptWindow = (w) => {
    if (!w) { lastWindow = null; return }      // window tracking switched off
    lastWindow = w
    smokeLog(`window ${w.app} private=${w.private} title=${w.title === undefined ? '-' : JSON.stringify(w.title)}`)
    sendWindow()
  }
  window.nova.onWindow(adoptWindow)
  window.nova.getWindow().then(adoptWindow)
  setInterval(sendWindow, 30000)                       // the backend keeps only the latest; a refresh covers reconnects

  async function onCaptureRequest(m) {
    if (!config.screen) { socket.screenDenied(m.turn_id, 'off'); return }
    const shot = await window.nova.captureScreen()
    if (!shot.ok) { socket.screenDenied(m.turn_id, shot.reason === 'private' ? 'private' : shot.reason === 'off' ? 'off' : 'failed'); return }
    socket.screen(m.turn_id, shot)
    smokeLog(`screen sent turn=${m.turn_id} app=${shot.app} ${shot.width}x${shot.height} bytes=${shot.bytes}`)
  }

  // Settings (voice, speed, echo mode, wake words, screen) come from the settings file via the main process; they go out on every
  // (re)connect and whenever the user changes them.
  const sendVoiceSettings = () => socket.settings(config.backendSettings)

  // ── backend offline: say so once, keep the tray informed, offer a retry ──
  let wasOffline = false
  const onStatus = (status, info = {}) => {
    state.net = status
    window.nova.netStatus({ status, attempt: info.attempt || 0, retryMs: info.retryMs || 0 })
    if (status === 'offline' && !wasOffline) {
      wasOffline = true
      bubble.say("I can't reach my backend. I'll keep trying; the tray icon has a Retry now entry.", 10000)
    } else if (status === 'online' && wasOffline) {
      wasOffline = false
      bubble.say("I'm back.", 3000)
    }
  }
  window.nova.onRetry(() => socket && socket.retryNow())

  socket = createSocket({ url: config.backend, onEvent: events.emit, onAudio, onStatus, onOpen: () => { sendVoiceSettings(); setTimeout(sendWindow, 200); socket.send({ type: 'catchup', since_id: lastSeen() }) } })
  const sendText = (text) => {
    const id = socket.sendText(text)
    if (id) { latency.start(id); player.allow(id) }
    return id
  }

  // ── voice in: utterance -> backend (STT, keywords, echo filter) -> transcript -> state ──
  let sentAt = new Map()           // utterance turn_id -> { at, ms } so a command's latency is measured from the end of speech
  function onUtterance(pcm, ms) {
    const purpose = voice.purpose()
    const id = 'v' + Date.now().toString(36)
    const ok = socket.sendUtterance(id, purpose, pcm)
    smokeLog(`utterance ${id} purpose=${purpose} ms=${ms} sent=${ok}`)
    if (ok) {
      sentAt.set(id, { at: performance.now(), ms })
      if (sentAt.size > 20) sentAt.delete(sentAt.keys().next().value)
    }
  }
  function onTranscript(m) {
    const sent = sentAt.get(m.turn_id)
    smokeLog(`transcript ${m.turn_id} purpose=${m.purpose} text=${JSON.stringify(m.text)} keyword=${m.keyword || '-'} command=${JSON.stringify(m.command || '')} ignored=${m.ignored || '-'} score=${m.score ?? '-'} stt_ms=${m.stt_ms}`)
    if (m.keyword === 'stop') { interruptSpeech(); voice.interrupted(); return }
    if (m.keyword === 'sleep') { interruptSpeech(); voice.sleep(); return }
    if (m.keyword === 'wake') voice.wake(!!m.command)
    if (m.keyword === 'wake' || (!m.ignored && m.purpose === 'command')) heard.show(m.keyword === 'wake' ? m.command : m.text)   // she heard you: shown before the model answers
    if (m.ignored) return
    const startsTurn = m.keyword === 'wake' ? !!m.command : m.purpose === 'command'
    if (!startsTurn) return
    // The backend has already replaced any running turn with this one; just silence the old audio here (no interrupt message: it would
    // cancel the new turn).
    for (const t of new Set([state.turn, state.audioTurn].filter((t) => t && t !== m.turn_id))) player.stop(t)
    if (lipsync) lipsync.reset()
    player.allow(m.turn_id)
    latency.start(m.turn_id, { backdateMs: sent ? performance.now() - sent.at : 0, stt: m.stt_ms, speechMs: m.audio_ms })
  }
  // The chosen microphone, else the system default (a device that was unplugged must not leave her deaf).
  async function pickedMic() {
    const id = config.micDeviceId
    if (!id) return micStream()
    try { return await micStream(id) } catch (err) {
      smokeLog(`microphone ${id} unavailable (${err && err.name}), using the default`)
      return micStream()
    }
  }
  let voiceBusy = false
  async function startVoice() {
    if (!config.voiceIn) { voice.setEnabled(false); return }
    if (vad || voiceBusy) return
    voiceBusy = true
    voice.setEnabled(true)
    const getStream = config.smokeWavs
      ? () => wavStream(Array.from({ length: config.smokeWavs }, (_, i) => () => window.nova.smokeWav(i)),
        { gapMs: config.smokeWavGapMs, onPlay: (i, d) => smokeLog(`smoke wav ${i} playing ${d.toFixed(2)}s`) })
      : pickedMic
    try {
      const made = await createVad({
        assetBase: new URL('./vad/', location.href).href,
        getStream,
        onSpeechStart: () => smokeLog('vad speech start'),
        onMisfire: () => smokeLog('vad misfire'),
        onUtterance,
      })
      await made.start()
      vad = made
      micEl.classList.add('on')
      micEl.className = 'on ' + voice.state()
      smokeLog('voice in: microphone open')
    } catch (err) {
      smokeLog('voice in unavailable: ' + (err && err.message || err))
      console.error('voice in unavailable', err)
    } finally { voiceBusy = false }
  }
  async function stopVoice() {
    voice.setEnabled(false)
    micEl.className = ''
    if (!vad) return
    const old = vad
    vad = null
    try { await old.pause(); await old.destroy() } catch {}
    smokeLog('voice in: microphone closed')
  }
  setInterval(() => voice.tick(), 1000)
  startVoice()

  // A setting changed (settings panel or tray): re-read the effective settings and apply what differs.
  window.nova.onSettingsChanged(async () => {
    const prev = config
    config = await window.nova.getConfig()
    smokeLog(`settings applied ${JSON.stringify(config.backendSettings)} mic=${config.voiceIn} device=${config.micDeviceId || 'default'}`)
    voice.setEchoMode(config.echoMode)
    layout.apply(config.display.layout)
    if (orbMode && config.display.orbPx !== prev.display.orbPx) { avatar.setSize(config.display.orbPx); sizeOrb(avatar.size()) }
    if (socket) sendVoiceSettings()
    if (!config.voiceIn) await stopVoice()
    else if (!vad || prev.micDeviceId !== config.micDeviceId) { await stopVoice(); await startVoice() }
  })

  // Tell the backend whether the user is at the PC (OS idle time), every 30 s and right after connecting.
  const reportPresence = async () => socket.send({ type: 'presence', idle_seconds: await window.nova.idleSeconds() })
  setInterval(reportPresence, 30000)
  setTimeout(reportPresence, 1500)

  // ── input box ─────────────────────────────────────────────────────────────
  const input = createInput({
    box: document.getElementById('inputbox'),
    field: document.getElementById('field'),
    onSubmit: (text) => {
      interruptSpeech()
      if (!sendText(text)) bubble.say("I can't reach the backend right now.")
    },
    onOpen: () => setInteractive(true),
    onClose: () => window.nova.inputClosed(),
  })
  window.nova.onOpenInput(() => input.show())
  window.nova.onInterrupt(interruptSpeech)
  if (config.autoSay) setTimeout(() => sendText(config.autoSay), 2500)
  if (config.smokeUi) {      // test hook (NOVA_SMOKE_UI): click the thumbs/reaction/history controls the way a user would
    const ui = config.smokeUi.split(',')
    const click = (sel, i) => { const b = document.querySelectorAll(sel)[i]; smokeLog(`smoke click ${sel}[${i}] ${b ? b.title : 'missing'}`); b && b.click() }
    if (ui.includes('rate')) setTimeout(() => click('#actions .rb', 0), 5000)
    if (ui.includes('react')) setTimeout(() => click('#actions .rb', 2), 5500)
    if (ui.includes('drawer')) setTimeout(() => click('#histbtn', 0), 6000)
    if (ui.includes('bg')) document.body.style.background = 'linear-gradient(160deg, #2b2652, #15121f)'      // screenshots: the overlay is transparent, so give the capture a backdrop
    if (ui.includes('input')) setTimeout(() => input.show(), 5000)
    if (ui.includes('radial')) setTimeout(() => openRadial(0, 0), 5000)
  }

  // ── radial menu: right-click on her. "Talk" is handled here; everything else is the main process's (windows, hiding the avatar) ──
  const radialEl = document.getElementById('radial')
  const radial = createRadial(radialEl, {
    onPick: (id) => {
      smokeLog(`radial ${id}`)
      if (id === 'talk') input.show()
      else window.nova.radial(id)
    },
  })
  radialEl.addEventListener('click', () => radial.close())          // a click outside the buttons closes it
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && radial.isOpen()) radial.close() })
  // With the orb the menu fans out around it, so it never covers it; with the avatar it opens where she was clicked.
  const openRadial = (x, y) => {
    if (orbMode) { const r = orbEl.getBoundingClientRect(); radial.open(x, y, window.innerWidth, window.innerHeight, { cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: avatar.size() / 2 + 38 }) }
    else radial.open(x, y)
  }
  grab.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!state.interactive || state.dragging) return
    openRadial(e.clientX, e.clientY)
  })

  // ── drag by grabbing the avatar; a click without movement opens the input ─
  let downAt = null
  grab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.interactive) return
    state.dragging = !config.display.layout.locked      // locked: a press can still be a click, but nothing is dragged
    downAt = { x: e.screenX, y: e.screenY }
    grab.setPointerCapture(e.pointerId)
    if (state.dragging) window.nova.dragStart()
  })
  const endDrag = (e) => {
    if (!downAt) return
    if (state.dragging) { state.dragging = false; window.nova.dragEnd() }
    const moved = downAt ? Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) : Infinity
    downAt = null
    if (e.type === 'pointerup' && moved < CLICK_SLOP_PX) {
      if (player.isPlaying()) interruptSpeech()      // a click while she is talking stops her
      else input.show()
    }
  }
  grab.addEventListener('pointerup', endDrag)
  grab.addEventListener('pointercancel', endDrag)

  // ── frame loop ────────────────────────────────────────────────────────────
  let last = performance.now()
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    expression.update(dt)
    if (lipsync) {
      const r = lipsync.update(player.sampleRate() || 48000)
      mouthPeak = Math.max(mouthPeak, r.mouth)
      if (player.isPlaying() && now - lastMouthLog > 250) {
        smokeLog(`mouth peak=${mouthPeak.toFixed(2)} rms=${r.rms.toFixed(3)} aa=${r.shapes.aa.toFixed(2)} ih=${r.shapes.ih.toFixed(2)} ou=${r.shapes.ou.toFixed(2)} ee=${r.shapes.ee.toFixed(2)} oh=${r.shapes.oh.toFixed(2)}`)
        mouthPeak = 0
        lastMouthLog = now
      }
    }
    avatar.update(dt)
    avatar.render()
    layout.tick()

    const c = state.cursor
    if (c) {
      avatar.lookAtNormalized((c.x / c.w) * 2 - 1, 1 - (c.y / c.h) * 2)
      // Stay interactive while dragging or typing; otherwise only while the cursor is over avatar pixels.
      const over = c.x >= 0 && c.y >= 0 && c.x < c.w && c.y < c.h && avatar.alphaAt(c.x, c.y) >= HIT_ALPHA
      setInteractive(state.dragging || layout.dragging() || input.isOpen() || radial.isOpen() || over || overHot(c))
      statusEl.textContent = `${state.net}  cursor ${Math.round(c.x)},${Math.round(c.y)}  ${state.interactive ? 'AVATAR' : 'click-through'}`
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

boot()
