import { createAvatar } from './avatar/avatar.js'
import { createExpressionController } from './avatar/expression.js'
import { createSocket } from './net/socket.js'
import { createBubble } from './ui/bubble.js'
import { createInput } from './ui/input.js'
import { createLatency } from './ui/latency.js'
import { createChips } from './ui/chips.js'
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
  let avatar
  try {
    avatar = await createAvatar(canvas, 'nova-asset://avatar.vrm')
  } catch (err) {
    statusEl.textContent = 'avatar failed: ' + err.message
    document.body.classList.add('debug')
    console.error(err)
    return
  }

  const expression = createExpressionController(avatar)
  const bubble = createBubble(document.getElementById('bubble'))
  const latency = createLatency(document.getElementById('latency'))
  const chips = createChips(document.getElementById('chips'))
  let socket = null
  let lipsync = null
  let mouthPeak = 0
  let config = await window.nova.getConfig()   // re-read when the settings change (see applySettings)

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

  // ── backend events ────────────────────────────────────────────────────────
  function onEvent(m) {
    switch (m.type) {
      case 'turn_start':
        state.turn = m.turn_id
        voice.turnStarted()
        bubble.startTurn()
        break
      case 'sentence':
        if (m.turn_id === latency.snapshot()?.turn_id) latency.mark('sentence')
        chips.clear()
        bubble.addSentence(m.text)
        expression.set(m.emotion)
        break
      case 'turn_end':
        if (m.metrics && m.turn_id === latency.snapshot()?.turn_id) {
          latency.metrics(m.metrics)
          smokeLog(`turn_end ${m.turn_id} interrupted=${m.interrupted} metrics=${JSON.stringify(m.metrics)}`)
        }
        bubble.fadeSoon()
        chips.clear()
        if (state.turn === m.turn_id) state.turn = null
        voice.turnEnded()
        break
      case 'transcript':
        onTranscript(m)
        break
      case 'tool':
        chips.tool(m)
        smokeLog(`chip ${m.name} ${chips.labels().join('|')}`)
        break
      case 'capture_request':
        onCaptureRequest(m)
        break
      case 'state':
        if (m.phase === 'busy') smokeLog('state busy (gpu_busy)')
        break
      case 'proactive':
        bubble.say(m.text)
        expression.set(m.emotion || 'neutral')
        break
      case 'error':
        bubble.say('Something went wrong: ' + m.message)
        break
    }
  }

  // Binary audio frame -> player. Frames of an interrupted turn are dropped by the player.
  function onAudio(h, pcm) {
    state.audioTurn = h.turn_id
    if (h.turn_id === latency.snapshot()?.turn_id) latency.mark('frame')
    smokeLog(`audio turn=${h.turn_id} sentence=${h.sentence_id} samples=${pcm.length} sr=${h.sr} dur_ms=${h.dur_ms} tts_ms=${h.tts_ms} at=${h.t_ms}`)
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

  socket = createSocket({ url: config.backend, onEvent, onAudio, onStatus, onOpen: () => { sendVoiceSettings(); setTimeout(sendWindow, 200) } })
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

  // ── drag by grabbing the avatar; a click without movement opens the input ─
  let downAt = null
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.interactive) return
    state.dragging = true
    downAt = { x: e.screenX, y: e.screenY }
    canvas.setPointerCapture(e.pointerId)
    window.nova.dragStart()
  })
  const endDrag = (e) => {
    if (!state.dragging) return
    state.dragging = false
    window.nova.dragEnd()
    const moved = downAt ? Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) : Infinity
    downAt = null
    if (e.type === 'pointerup' && moved < CLICK_SLOP_PX) {
      if (player.isPlaying()) interruptSpeech()      // a click while she is talking stops her
      else input.show()
    }
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

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

    const c = state.cursor
    if (c) {
      avatar.lookAtNormalized((c.x / c.w) * 2 - 1, 1 - (c.y / c.h) * 2)
      // Stay interactive while dragging or typing; otherwise only while the cursor is over avatar pixels.
      const over = c.x >= 0 && c.y >= 0 && c.x < c.w && c.y < c.h && avatar.alphaAt(c.x, c.y) >= HIT_ALPHA
      setInteractive(state.dragging || input.isOpen() || over)
      statusEl.textContent = `${state.net}  cursor ${Math.round(c.x)},${Math.round(c.y)}  ${state.interactive ? 'AVATAR' : 'click-through'}`
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

boot()
