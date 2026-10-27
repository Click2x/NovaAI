// The backend's REST API as seen by the setup page. Every call resolves (never throws): { ok:false, error } when the backend cannot be reached or
// answers with an error, so the page can show a calm message instead of breaking.
export function createApi(base, fetchFn = (...a) => globalThis.fetch(...a)) {
  const root = String(base || '').replace(/\/+$/, '')

  async function call(method, path, body, timeoutMs = 20000) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetchFn(root + path, {
        method, signal: ctl.signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let data = null
      try { data = await r.json() } catch { /* not JSON */ }
      if (!r.ok) return { ok: false, status: r.status, error: (data && (data.detail || data.error)) || `The backend answered ${r.status}.` }
      return data && typeof data === 'object' ? data : { ok: true }
    } catch {
      return { ok: false, offline: true, error: 'I cannot reach my backend.' }
    } finally { clearTimeout(t) }
  }

  return {
    base: root,
    status: () => call('GET', '/api/onboarding'),
    system: () => call('GET', '/api/system'),
    settings: () => call('GET', '/api/settings'),
    patchSettings: (patch) => call('PATCH', '/api/settings', patch),
    advance: (choice) => call('POST', '/api/onboarding/advance', { choice: choice || null }, 60000),
    say: (text) => call('POST', '/api/onboarding/say', { text }, 180000),          // a cold model can take a while
    installStatus: () => call('GET', '/api/onboarding/install'),
    startInstall: () => call('POST', '/api/onboarding/install', undefined),
    voices: () => call('GET', '/api/onboarding/voices'),
    setVoice: (voice, speed) => call('POST', '/api/onboarding/voice', { voice, speed: speed ?? null }),
    setSafety: (mode, adultConfirmed, confirm) => call('POST', '/api/onboarding/safety', { mode, adult_confirmed: !!adultConfirmed, confirm: !!confirm }, 60000),
    setAvatar: (avatar) => call('POST', '/api/onboarding/avatar', { avatar }),
    reset: () => call('POST', '/api/onboarding/reset', undefined),

    // Speech: WAV bytes of `text` in `voice`, or null when the backend has no voice (503) or is unreachable - the page then uses the system voice.
    async tts(text, voice, speed = 1) {
      const q = new URLSearchParams({ text: String(text).slice(0, 300), voice: voice || 'af_heart', speed: String(speed) })
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 30000)
      try {
        const r = await fetchFn(`${root}/api/tts/preview?${q}`, { signal: ctl.signal })
        return r.ok ? await r.arrayBuffer() : null
      } catch { return null } finally { clearTimeout(t) }
    },
    // Speech to text: raw 16 kHz mono int16 PCM in, text out ('' when nothing was understood, null when recognition is not available).
    async stt(pcm) {
      try {
        const r = await fetchFn(`${root}/api/stt`, { method: 'POST', body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) })
        if (r.status === 503) return null
        if (!r.ok) return ''
        const d = await r.json()
        return typeof d.text === 'string' ? d.text : ''
      } catch { return '' }
    },
  }
}
