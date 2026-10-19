// Gapless sentence player. The backend sends one PCM clip per sentence (int16, 24 kHz); each is scheduled to start exactly where the
// previous one ends, so there is no gap between sentences. Reports playback{turn_id,sentence_id,state} so the backend knows what was
// actually spoken, and exposes an AnalyserNode for the lip-sync.
export function createPlayer({ onPlayback, onFirstAudio } = {}) {
  let ctx = null
  let analyser = null
  let gain = null
  let nextTime = 0
  let queue = []              // { turn_id, sentence_id, source, startAt, endAt, started, ended }
  let timer = null
  let blocked = new Set()     // turn ids that were interrupted: late frames for them are dropped

  function ensure() {
    if (ctx) return ctx
    ctx = new AudioContext({ latencyHint: 'interactive' })
    gain = ctx.createGain()
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024                   // 43 ms window at 24 kHz-ish output rates; fast enough for visemes
    analyser.smoothingTimeConstant = 0.2
    gain.connect(analyser)
    analyser.connect(ctx.destination)
    return ctx
  }

  function pump() {
    if (!ctx) return
    const now = ctx.currentTime
    for (const item of queue) {
      if (!item.started && now >= item.startAt) {
        item.started = true
        onPlayback && onPlayback({ turn_id: item.turn_id, sentence_id: item.sentence_id, state: 'start' })
        if (!pump.firstSeen.has(item.turn_id)) { pump.firstSeen.add(item.turn_id); onFirstAudio && onFirstAudio(item.turn_id) }
      }
      if (item.started && !item.ended && now >= item.endAt) finish(item)
    }
    queue = queue.filter((i) => !i.ended)
    if (!queue.length) { clearInterval(timer); timer = null }
  }
  pump.firstSeen = new Set()

  function finish(item) {
    item.ended = true
    onPlayback && onPlayback({ turn_id: item.turn_id, sentence_id: item.sentence_id, state: 'end' })
  }

  return {
    // pcm: Int16Array (or ArrayBuffer of s16le), sr: sample rate.
    enqueue(turn_id, sentence_id, pcm, sr = 24000) {
      if (blocked.has(turn_id)) return
      const c = ensure()
      if (c.state === 'suspended') c.resume()
      const i16 = pcm instanceof Int16Array ? pcm : new Int16Array(pcm)
      if (!i16.length) return
      const buf = c.createBuffer(1, i16.length, sr)
      const ch = buf.getChannelData(0)
      for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768
      const source = c.createBufferSource()
      source.buffer = buf
      source.connect(gain)
      const startAt = Math.max(nextTime, c.currentTime + 0.03)   // 30 ms of headroom for the first clip
      source.start(startAt)
      nextTime = startAt + buf.duration
      queue.push({ turn_id, sentence_id, source, startAt, endAt: nextTime, started: false, ended: false })
      if (!timer) timer = setInterval(pump, 20)
    },
    // Barge-in: silence now. Sentences that had started are reported as ended; queued ones never start. Later frames of this turn are ignored.
    stop(turn_id) {
      if (turn_id) blocked.add(turn_id)
      if (blocked.size > 20) blocked = new Set([...blocked].slice(-10))
      for (const item of queue) {
        try { item.source.stop() } catch {}
        try { item.source.disconnect() } catch {}
        if (item.started && !item.ended) finish(item)
      }
      queue = []
      nextTime = 0
      clearInterval(timer)
      timer = null
    },
    // Allow a new turn's audio (ids are unique per turn, so this only matters if a client reuses ids).
    allow(turn_id) { blocked.delete(turn_id) },
    isPlaying: () => queue.length > 0,
    analyser: () => { ensure(); return analyser },
    sampleRate: () => (ctx ? ctx.sampleRate : 0),
    state: () => (ctx ? ctx.state : 'none'),
  }
}
