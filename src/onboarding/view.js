// DOM for the setup page. Every string that came from the backend goes in through textContent; no innerHTML anywhere.
import { progress, summary } from './model.js'

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'value') el[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  return el
}

const button = (text, onClick, opts = {}) => h('button', { class: 'btn' + (opts.primary ? ' primary' : '') + (opts.quiet ? ' quiet' : ''), onClick, disabled: !!opts.disabled, title: opts.title }, text)

export function createView(root, A) {
  // A: actions { begin, confirmPlan, setOrigin, retryInstall, checkOllama, openOllama, say, skipMeet, hearVoice, chooseVoice, chooseSafety, keepAvatar, pickAvatar,
  //              finish, later, tryAgain, toggleMic, toggleMute, redo }
  const dots = root.querySelector('#dots')
  const caption = root.querySelector('#caption')
  const transcript = root.querySelector('#transcript')
  const panel = root.querySelector('#panel')
  const err = root.querySelector('#error')
  const micBtn = root.querySelector('#mic')
  const muteBtn = root.querySelector('#mute')
  const laterBtn = root.querySelector('#later')
  let panelKey = ''
  let field = null
  let safetyDraft = { mode: 'standard', adult: false }

  root.querySelector('#later').addEventListener('click', () => A.later())
  micBtn.addEventListener('click', () => A.toggleMic())
  muteBtn.addEventListener('click', () => A.toggleMute())

  function renderDots(status) {
    const p = progress(status)
    dots.textContent = ''
    p.labels.forEach((label, i) => dots.append(h('span', { class: 'dot' + (i < p.index ? ' done' : i === p.index ? ' now' : ''), title: label })))
  }

  function renderTranscript(s) {
    const near = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40
    transcript.textContent = ''
    for (const m of s.history.slice(-30)) transcript.append(h('div', { class: 'line ' + m.who, text: m.text }))
    if (near) transcript.scrollTop = transcript.scrollHeight
  }

  function offlinePanel(s) {
    const b = s.backend || {}
    const again = h('div', { class: 'row' }, button('Look again', () => A.tryAgain(), { primary: true }))
    if (b.state === 'failed') {
      return h('div', { class: 'card' },
        h('h2', { text: "My built-in backend would not start" }),
        h('p', { text: b.reason ? `The reason: ${b.reason}.` : 'It stopped before it was ready.' }),
        h('p', { class: 'hint', text: 'Security software sometimes blocks it. Allowing NovaAI and novaai-server.exe and then looking again usually fixes that.' }),
        b.logFile ? h('p', { class: 'hint', text: `Its log: ${b.logFile}` }) : null,
        again)
    }
    if (b.state === 'starting') {
      return h('div', { class: 'card' },
        h('h2', { text: 'Waking up my backend' }),
        h('p', { text: 'The first start takes a little while. I will carry on the moment it answers.' }),
        again)
    }
    return h('div', { class: 'card' },
      h('h2', { text: "I can't reach my backend" }),
      h('p', { text: 'I need a small program running on this computer to think with. Open a terminal in the Nova.Ai folder and start it:' }),
      h('pre', { class: 'code', text: 'cd backend\npip install -r requirements.txt\npython -m novaai serve' }),
      h('p', { class: 'hint', text: 'I will keep looking, and carry on the moment I find it.' }),
      again)
  }

  function planCard(s) {
    const plan = s.plan
    const hw = s.status && s.status.hardware
    const kids = []
    if (hw) kids.push(h('p', { class: 'hint', text: `${hw.gpu_name || 'No graphics card'}${hw.vram_gb ? ` · ${hw.vram_gb} GB` : ''} · ${hw.ram_gb} GB memory` }))
    if (plan && plan.voice) {
      kids.push(h('div', { class: 'model' }, h('b', { text: 'Voice' }), h('span', { text: `${plan.voice.family}${plan.voice.variant === 'abliterated' ? ' (uncensored)' : ''}` }), h('small', { text: plan.voice.tag })))
      if (plan.tools && plan.tools.tag !== plan.voice.tag) kids.push(h('div', { class: 'model' }, h('b', { text: 'Tools' }), h('span', { text: `${plan.tools.family} · ${plan.tools.origin || 'community'}${plan.tools.variant === 'abliterated' ? ' (uncensored)' : ''}` }), h('small', { text: plan.tools.tag })))
      kids.push(h('p', { class: 'hint', text: plan.download_gb > 0 ? `About ${plan.download_gb} GB to download.` : 'Nothing to download.' }))
    }
    return kids
  }

  function stepWelcome(s) {
    return h('div', { class: 'card center' }, h('h2', { text: 'Hi, I\'m Nova' }), h('p', { text: 'Let me get set up and meet you. It takes a few minutes, and everything stays on this computer.' }),
      h('div', { class: 'row' }, button('Begin', () => A.begin(), { primary: true, disabled: s.busy })))
  }

  function stepMachine(s) {
    const origin = (s.settings && s.settings.models && s.settings.models.tools_origin) || 'any'
    const sel = h('select', { onChange: (e) => A.setOrigin(e.target.value) },
      ...[['any', 'No preference'], ['US', 'American models'], ['CN', 'Chinese models']].map(([v, l]) => h('option', { value: v, text: l, ...(v === origin ? { selected: true } : {}) })))
    return h('div', { class: 'card' }, h('h2', { text: 'What I\'ll install' }), ...planCard(s),
      h('label', { class: 'field' }, h('span', { text: 'Tool-using model' }), sel),
      h('div', { class: 'row' }, button('Sounds good', () => A.confirmPlan(), { primary: true, disabled: s.busy || !(s.plan && s.plan.voice) })))
  }

  function stepInstall(s) {
    const st = s.install
    const kids = [h('h2', { text: st.state === 'needs_ollama' ? 'I need Ollama' : st.state === 'error' ? 'That did not work' : 'Waking up' })]
    if (st.state === 'needs_ollama') {
      kids.push(h('p', { text: 'Ollama runs my models on your computer. Install it, start it, and I will carry on.' }),
        h('div', { class: 'row' }, button('Get Ollama', () => A.openOllama()), button('I installed it', () => A.checkOllama(), { primary: true })))
    } else if (st.state === 'error') {
      kids.push(h('p', { class: 'hint', text: (s.status && s.status.install && s.status.install.error) || 'Something went wrong while downloading.' }), h('div', { class: 'row' }, button('Try again', () => A.retryInstall(), { primary: true })))
    } else {
      kids.push(h('div', { class: 'bar' }, h('i', { style: `width:${st.percent}%` })), h('p', { class: 'hint', text: st.state === 'done' ? 'Ready.' : `${st.percent}%` }))
    }
    return h('div', { class: 'card' }, ...kids)
  }

  function stepMeet(s) {
    field = field || h('input', { type: 'text', placeholder: 'Type, or press the microphone and talk to me', autocomplete: 'off', onKeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { const t = field.value.trim(); if (t) { field.value = ''; A.say(t) } } } })
    field.disabled = !!s.busy
    const miss = (s.status && s.status.missing) || []
    return h('div', { class: 'card' }, h('h2', { text: 'Tell me about you' }), field,
      h('div', { class: 'row' }, button('Skip ahead', () => A.skipMeet(), { quiet: true, disabled: s.busy || !(s.status && s.status.name) , title: 'Needs at least your name' })),
      miss.length && s.history.length > 4 ? h('p', { class: 'hint', text: 'Still curious about: ' + miss.slice(0, 3).join(', ') }) : null)
  }

  function stepVoice(s) {
    const cur = s.status && s.status.voice
    return h('div', { class: 'card' }, h('h2', { text: 'How should I sound?' }),
      h('div', { class: 'voices' }, ...s.voices.map((v) => h('div', { class: 'voice' + (v.id === cur ? ' cur' : '') },
        h('div', {}, h('b', { text: v.label }), h('small', { text: v.feel })),
        h('div', { class: 'row' }, button('Hear', () => A.hearVoice(v), { quiet: true }), button('This one', () => A.chooseVoice(v.id), { primary: true, disabled: s.busy }))))),
      h('div', { class: 'row' }, button('Keep the default', () => A.chooseVoice(cur || 'af_heart'), { quiet: true })))
  }

  function stepSafety(s) {
    const d = safetyDraft
    const radio = (mode, title, text) => h('label', { class: 'choice' + (d.mode === mode ? ' on' : '') },
      h('input', { type: 'radio', name: 'safety', checked: d.mode === mode, onChange: () => { d.mode = mode; panelKey = ''; A.rerender() } }), h('div', {}, h('b', { text: title }), h('small', { text })))
    const needsAdult = d.mode !== 'standard'
    return h('div', { class: 'card' }, h('h2', { text: 'Safety' }),
      radio('standard', 'Keep the filter on', 'I will not help with things that hurt people or break the law, and I will check in if you are struggling.'),
      radio('relaxed', 'Allow adult content', 'Explicit adult conversation is allowed. Everything else stays on.'),
      radio('off', 'Turn the filter off', 'No category limits, and I switch to my uncensored models.'),
      h('p', { class: 'hint', text: 'Two limits never change: nothing sexual involving children, and nothing that helps make weapons that could kill many people.' }),
      needsAdult ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.adult, onChange: (e) => { d.adult = e.target.checked; panelKey = ''; A.rerender() } }), h('span', { text: 'I am 18 or older' })) : null,
      h('div', { class: 'row' }, button(d.mode === 'off' ? 'Turn the filter off' : 'Continue', () => A.chooseSafety(d.mode, d.adult), { primary: true, disabled: s.busy || (needsAdult && !d.adult) })))
  }

  function stepAvatar(s) {
    return h('div', { class: 'card' }, h('h2', { text: 'How I look' }), h('p', { text: 'On your desktop I am a small glowing orb in the corner of your screen. It pulses when I speak. If you would rather have an avatar, you can use your own: any VRM file.' }),
      h('div', { class: 'row' }, button('Use my own avatar...', () => A.pickAvatar(), { disabled: s.busy }), button('Keep the orb', () => A.keepAvatar(), { primary: true, disabled: s.busy })))
  }

  function stepDone(s) {
    const rows = summary(s.settings)
    return h('div', { class: 'card' }, h('h2', { text: 'All set' }),
      rows.length ? h('dl', { class: 'sum' }, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])) : null,
      h('p', { class: 'hint', text: 'You can read, change or delete all of this later in settings.' }),
      s.install.state === 'running' ? h('p', { class: 'hint', text: `Still downloading my models: ${s.install.percent}%. You can start now; I will be ready when it finishes.` }) : null,
      h('div', { class: 'row' }, button('Start using Nova', () => A.finish(), { primary: true })))
  }

  const steps = { welcome: stepWelcome, machine: stepMachine, install: stepInstall, meet: stepMeet, voice: stepVoice, safety: stepSafety, avatar: stepAvatar, done: stepDone }

  return {
    render(s) {
      err.textContent = s.error || ''
      err.hidden = !s.error
      caption.textContent = s.caption
      caption.dataset.emotion = s.emotion
      micBtn.hidden = !(s.status && s.status.step === 'meet') || !s.mic.available
      micBtn.classList.toggle('on', s.mic.on)
      micBtn.classList.toggle('hearing', s.mic.hearing)
      micBtn.title = s.mic.on ? 'Microphone on. Click to turn it off' : 'Talk to me with your microphone'
      muteBtn.textContent = s.muted ? 'Voice off' : 'Voice on'
      laterBtn.hidden = s.phase === 'ready' && s.status && s.status.step === 'done'
      if (s.phase === 'boot') { panel.textContent = ''; panelKey = 'boot'; return }
      if (s.phase === 'offline') {
        const key = 'offline:' + ((s.backend && s.backend.state) || 'none') + ':' + ((s.backend && s.backend.reason) || '')
        if (panelKey !== key) { panel.textContent = ''; panel.append(offlinePanel(s)); panelKey = key }
        dots.textContent = ''
        return
      }
      renderDots(s.status)
      const step = s.status.step
      transcript.hidden = step !== 'meet'          // the conversation is only shown while we are talking; every other step is just her subtitle
      if (step === 'meet') renderTranscript(s)
      const key = [step, s.busy, s.install.state, s.install.percent, s.voices.length, s.plan && s.plan.download_gb, s.status.voice, (s.settings && s.settings.models && s.settings.models.tools_origin) || '', s.status.name, s.status.missing && s.status.missing.length].join('|')
      if (key === panelKey) return
      const refocus = document.activeElement === field
      panelKey = key
      panel.textContent = ''
      if (step !== 'meet') field = null
      panel.append((steps[step] || stepWelcome)(s))
      if (refocus && field) field.focus()
      else if (step === 'meet' && field && !s.busy) field.focus()
    },
  }
}
