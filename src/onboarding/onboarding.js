// The setup page: wires the backend (api.js), the state (model.js), the screen (view.js), her voice (speaker.js) and an orb that
// swells with the sound while she speaks (no avatar during setup).
import { createVad } from '../voice/vad.js'
import { createApi } from './api.js'
import { initial, reduce, newInstallLines, orbLevel } from './model.js'
import { createSpeaker } from './speaker.js'
import { createView } from './view.js'

const $ = (id) => document.getElementById(id)

async function main() {
  const shell = window.novaSetup
  const config = await shell.config()
  const api = createApi(config.httpBase)
  let state = initial()
  let view = null
  let pollTimer = null, offlineTimer = null
  let voiceId = 'af_heart', speed = 1

  // ── audio: one context, one analyser; the lip-sync reads the analyser ──
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyser.connect(ctx.destination)

  function play(bytes, register) {
    return new Promise(async (resolve) => {
      let src = null
      const done = () => resolve()
      register(() => { try { src && src.stop() } catch { /* not started */ } done() })
      try {
        if (ctx.state === 'suspended') await ctx.resume()
        const buf = await ctx.decodeAudioData(bytes.slice(0))
        src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(analyser)
        src.onended = done
        src.start()
      } catch { done() }
    })
  }

  function systemSpeak(text, register) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis
      if (!synth) { resolve(); return }
      const u = new SpeechSynthesisUtterance(text)
      u.onend = u.onerror = () => resolve()
      register(() => { try { synth.cancel() } catch { /* ignore */ } resolve() })
      synth.speak(u)
    })
  }

  // The first request tells us whether the backend has a voice; if not, every line uses the system voice without asking again.
  let backendVoice = true
  const speaker = createSpeaker({
    synth: async (text) => {
      if (!backendVoice) return null
      const bytes = await api.tts(text, voiceId, speed)
      if (!bytes) backendVoice = false
      return bytes
    },
    play,
    system: window.speechSynthesis ? systemSpeak : null,
    isMuted: () => state.muted,
    onLine: (line) => {
      dispatch({ type: 'caption', text: line.text, emotion: line.emotion })
      dispatch({ type: 'her_line', text: line.text })
    },
    onState: (on) => {
      dispatch({ type: 'speaking', on })
      if (vad && state.mic.on) { if (on) vad.pause(); else vad.start() }        // she does not listen to herself
    },
  })

  const say = (lines) => speaker.say(lines)

  function dispatch(a) {
    state = reduce(state, a)
    if (view) view.render(state)
  }

  // ── the orb: swells with the sound that is playing; with the system voice (no waveform to read) it pulses on its own ──
  const orb = $('orb')
  const wave = new Float32Array(analyser.fftSize)
  let level = 0
  function frame() {
    analyser.getFloatTimeDomainData(wave)
    let sum = 0
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i]
    const target = orbLevel(Math.sqrt(sum / wave.length))
    level += (target - level) * (target > level ? 0.5 : 0.15)
    orb.style.setProperty('--level', level.toFixed(3))
    orb.classList.toggle('pulse', state.speaking && level < 0.02)
    requestAnimationFrame(frame)
  }

  // ── backend flow ──
  async function refresh() {
    const st = await api.status()
    if (st.ok === false) { goOffline(); return null }
    dispatch({ type: 'status', status: st })
    voiceId = st.voice || voiceId
    const set = await api.settings()
    if (set.ok !== false) dispatch({ type: 'settings', settings: set })
    return st
  }

  async function goOffline() {
    let backend
    try { backend = (await shell.config()).backend } catch {}   // the app may have started or failed the bundled backend since the page loaded
    dispatch({ type: 'offline', backend })
    clearTimeout(offlineTimer)
    offlineTimer = setTimeout(async () => { if (state.phase === 'offline') { if (await refresh()) resume() } }, 3000)
  }

  async function onResult(res, { speakLines = true } = {}) {
    if (!res || res.ok === false && res.offline) { goOffline(); return }
    if (res.ok === false && !res.step) { dispatch({ type: 'error', message: res.error || 'Something went wrong.' }); return }
    if (res.status) dispatch({ type: 'status', status: res.status })
    if (res.plan) dispatch({ type: 'plan', plan: res.plan })
    if (res.voices) dispatch({ type: 'voices', voices: res.voices })
    if (speakLines && res.lines) say(res.lines)
    const set = await api.settings()
    if (set.ok !== false) dispatch({ type: 'settings', settings: set })
    voiceId = (set.nova && set.nova.voice) || voiceId
    await enterStep(res.step || (state.status && state.status.step))
  }

  async function enterStep(step) {
    clearInterval(pollTimer)
    if (step === 'machine' && !state.plan) {
      const sys = await api.system()
      if (sys.ok !== false) dispatch({ type: 'plan', plan: sys.plan })
    }
    if (step === 'install') startInstallPolling()
    if (step === 'voice' && !state.voices.length) {
      const v = await api.voices()
      if (v.ok !== false) dispatch({ type: 'voices', voices: v.voices })
    }
  }

  function startInstallPolling() {
    clearInterval(pollTimer)
    const tick = async () => {
      const inst = await api.installStatus()
      if (inst.ok === false) { if (inst.offline) goOffline(); return }
      dispatch({ type: 'install', install: inst })
      const fresh = newInstallLines(inst, state.install.seen)
      if (fresh.lines.length) { dispatch({ type: 'install_seen', seen: fresh.seen }); say(fresh.lines) }
      if (inst.state === 'done') {
        clearInterval(pollTimer)
        await speaker.idle()
        await onResult(await api.advance())          // on to meeting her
      } else if (inst.state === 'error' || inst.state === 'needs_ollama') {
        clearInterval(pollTimer)
        dispatch({ type: 'status', status: { ...state.status } })
      }
    }
    pollTimer = setInterval(tick, 1000)
    tick()
  }

  // Follow a background download (not the main install: this never moves the setup on).
  let watchTimer = null
  function watchInstall() {
    clearInterval(watchTimer)
    watchTimer = setInterval(async () => {
      const inst = await api.installStatus()
      if (inst.ok === false) return
      dispatch({ type: 'install', install: inst })
      if (inst.state !== 'running') clearInterval(watchTimer)
    }, 2000)
  }

  async function resume() {
    const st = state.status
    if (!st) return
    if (st.done || st.step === 'done') { await enterStep('done'); return }
    if (st.step !== 'welcome') say([{ id: 'resume', text: 'Welcome back. Let\'s pick up where we left off.', emotion: 'warm' }])
    await enterStep(st.step)
  }

  // ── microphone: hands-free after she has finished speaking; her own voice is never listened to ──
  let vad = null
  async function micOn() {
    try {
      vad = vad || await createVad({
        assetBase: new URL('./vad/', location.href).href,
        onSpeechStart: () => dispatch({ type: 'mic', mic: { hearing: true } }),
        onMisfire: () => dispatch({ type: 'mic', mic: { hearing: false } }),
        onUtterance: async (pcm) => {
          dispatch({ type: 'mic', mic: { hearing: false } })
          if (state.speaking || state.busy) return
          const text = await api.stt(pcm)
          if (text === null) { dispatch({ type: 'mic', mic: { on: false, available: false } }); await vad.pause(); dispatch({ type: 'error', message: 'Speech recognition is not installed on the backend yet. You can type to me.' }); return }
          if (text) sendSay(text)
        },
      })
      await vad.start()
      dispatch({ type: 'mic', mic: { on: true } })
    } catch {
      dispatch({ type: 'mic', mic: { on: false, available: false } })
      dispatch({ type: 'error', message: 'I could not open the microphone. You can type to me.' })
    }
  }
  async function micOff() { if (vad) await vad.pause(); dispatch({ type: 'mic', mic: { on: false, hearing: false } }) }

  async function sendSay(text) {
    speaker.stop()
    dispatch({ type: 'user_line', text })
    dispatch({ type: 'busy', busy: true })
    const res = await api.say(text)
    dispatch({ type: 'busy', busy: false })
    await onResult(res)
  }

  // ── what the buttons do ──
  const A = {
    rerender: () => view.render(state),
    async begin() {
      if (ctx.state === 'suspended') await ctx.resume()
      dispatch({ type: 'busy', busy: true })
      const res = await api.advance()
      dispatch({ type: 'busy', busy: false })
      await onResult(res)
    },
    async confirmPlan() {
      dispatch({ type: 'busy', busy: true })
      const res = await api.advance('yes')
      dispatch({ type: 'busy', busy: false })
      await onResult(res)
    },
    async setOrigin(origin) {
      await api.patchSettings({ models: { tools_origin: origin } })
      const sys = await api.system()
      if (sys.ok !== false) dispatch({ type: 'plan', plan: sys.plan })
      const set = await api.settings()
      if (set.ok !== false) dispatch({ type: 'settings', settings: set })
    },
    retryInstall: async () => { await api.startInstall(); dispatch({ type: 'install', install: { state: 'running', percent: 0 } }); dispatch({ type: 'install_seen', seen: 0 }); startInstallPolling() },
    checkOllama: async () => { const res = await api.advance(); await onResult(res); startInstallPolling() },
    openOllama: () => shell.openExternal('https://ollama.com/download'),
    say: (text) => sendSay(text),
    async skipMeet() { speaker.stop(); dispatch({ type: 'busy', busy: true }); const res = await api.advance(); dispatch({ type: 'busy', busy: false }); await onResult(res) },
    async hearVoice(v) {
      speaker.stop()
      const prev = voiceId
      voiceId = v.id
      say([{ id: 'sample.' + v.id, text: v.sample, emotion: 'happy' }])
      await speaker.idle()
      voiceId = prev
    },
    async chooseVoice(id) {
      speaker.stop()
      dispatch({ type: 'busy', busy: true })
      const res = await api.setVoice(id)
      dispatch({ type: 'busy', busy: false })
      voiceId = id
      await onResult(res)
    },
    async chooseSafety(mode, adult) {
      speaker.stop()
      dispatch({ type: 'busy', busy: true })
      const res = await api.setSafety(mode, adult, mode !== 'standard')
      dispatch({ type: 'busy', busy: false })
      if (res.ok === false && res.lines) { say(res.lines); return }
      await onResult(res)
      if (res.needs_download) {            // the filter is off: her uncensored models are fetched in the background while setup goes on
        await api.startInstall()
        say([{ id: 'safety.fetch', text: 'I am fetching my uncensored models in the background. You can carry on.', emotion: 'neutral' }])
        watchInstall()
      }
    },
    async keepAvatar() {
      speaker.stop()
      dispatch({ type: 'busy', busy: true })
      const res = await api.advance()
      dispatch({ type: 'busy', busy: false })
      await onResult(res)
    },
    async pickAvatar() {
      const r = await shell.pickAvatar()
      if (r.canceled) return
      if (!r.ok) { dispatch({ type: 'error', message: r.error || 'I could not use that file.' }); return }
      await api.setAvatar(r.path)
      say([{ id: 'avatar.new', text: "Got it. That's how I'll look on your desktop.", emotion: 'happy' }])
    },
    finish: () => { speaker.stop(); shell.finish() },
    later: () => { speaker.stop(); shell.later() },
    async tryAgain() { const st = await refresh(); if (st) resume() },
    toggleMic: () => (state.mic.on ? micOff() : micOn()),
    toggleMute: () => { if (!state.muted) speaker.stop(); dispatch({ type: 'muted', muted: !state.muted }) },
  }

  view = createView(document.body, A)
  view.render(state)
  requestAnimationFrame(frame)
  const st = await refresh()
  if (st) resume()
  window.__setup = { get state() { return state }, A }          // test hook for the smoke run
}

main().catch((e) => { document.getElementById('error').textContent = 'Setup could not start: ' + (e && e.message); document.getElementById('error').hidden = false })
