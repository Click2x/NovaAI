// Bubble text paced by playback. The backend sends a sentence's text as soon as it exists; its audio comes later (synthesis) and plays one
// sentence at a time. Showing the text at once means the bubble runs ahead of her voice, so with speech on a sentence appears when it starts
// playing and its words come in across its playing time. Text for a sentence whose audio never comes (speech off, a failed synthesis, an empty
// clip) is shown without waiting. Pure logic: the clock is injected, `show(text)` receives everything visible so far.
export const HOLD_MS = 2500        // a sentence with no audio yet is shown after this long, if no audio has been heard in the turn
export const STALL_MS = 30000      // after the turn ended, this long with no playback event shows the rest and lets the bubble fade
export const WORD_SPAN = 0.8       // its words are spread over this share of the clip, so the last word is up before the voice stops

export function createPacer({ show, onDone = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, holdMs = HOLD_MS, stallMs = STALL_MS } = {}) {
  let turn = null          // { id, paced, items: [{id, text, dur, state: 'wait'|'live'|'done'}], audio, playing, finished, timers: Set }

  const clearAll = () => { if (turn) { for (const t of turn.timers) clearTimer(t); turn.timers.clear() } }
  const later = (fn, ms) => {
    const cur = turn
    const t = setTimer(() => { cur.timers.delete(t); if (turn === cur) fn() }, ms)
    cur.timers.add(t)
    return t
  }

  function render() {
    const parts = []
    for (const it of turn.items) {
      if (it.state === 'done') parts.push(it.text)
      else if (it.state === 'live') parts.push(it.shown)
    }
    show(parts.filter(Boolean).join(' '))
  }

  function reveal(it) {
    if (it.state === 'done') return
    it.state = 'done'
    it.shown = it.text
  }

  // Playback that never reports (a dropped clip) must not leave the bubble up forever.
  function armStall() {
    if (!turn) return
    if (turn.stall) { clearTimer(turn.stall); turn.timers.delete(turn.stall) }
    if (!turn.finished || turn.doneSent) return
    turn.stall = later(() => { for (const it of turn.items) reveal(it); turn.playing = 0; turn.items.forEach((i) => { i.dur = undefined }); maybeDone() }, stallMs)
  }

  function maybeDone() {
    if (!turn || !turn.finished || turn.playing > 0 || turn.doneSent) return
    if (turn.items.some((it) => it.state === 'wait' && it.dur !== undefined)) return     // audio is on its way for this one
    for (const it of turn.items) reveal(it)
    render()
    turn.doneSent = true
    onDone(turn.id)
  }

  const find = (id, sid) => (turn && turn.id === id ? turn.items.find((i) => i.id === sid) : undefined)

  return {
    // A new turn. `paced` false (speech off) shows every sentence as it arrives.
    begin(id, paced) {
      clearAll()
      turn = { id, paced: !!paced, items: [], audio: false, playing: 0, finished: false, doneSent: false, timers: new Set() }
      show('')
    },
    sentence(id, sid, text) {
      if (!turn || turn.id !== id) return
      const it = { id: sid, text, dur: undefined, state: 'wait', shown: '' }
      turn.items.push(it)
      if (!turn.paced) { reveal(it); render(); return }
      later(() => { if (it.state === 'wait' && !turn.audio) { reveal(it); render() } }, holdMs)
    },
    // The audio frame for a sentence arrived (its length is known).
    audio(id, sid, durMs) {
      const it = find(id, sid)
      if (!it) return
      turn.audio = true
      it.dur = Number.isFinite(durMs) && durMs > 0 ? durMs : 0
    },
    // The sentence started playing: earlier ones are complete, its words follow the clip.
    started(id, sid) {
      const it = find(id, sid)
      if (!it || !turn.paced) return
      for (const o of turn.items) { if (o === it) break; reveal(o) }
      turn.playing++
      armStall()
      it.state = 'live'
      const words = it.text.split(/\s+/).filter(Boolean)
      const n = words.length
      const span = (it.dur || 0) * WORD_SPAN
      const upTo = (k) => { it.shown = words.slice(0, k).join(' ') }
      upTo(span > 0 && n > 1 ? 1 : n)
      render()
      if (span > 0 && n > 1) {
        for (let k = 2; k <= n; k++) later(() => { if (it.state === 'live') { upTo(k); render() } }, ((k - 1) / n) * span)
      }
    },
    ended(id, sid) {
      const it = find(id, sid)
      if (!it || !turn.paced) return
      if (it.state !== 'done') reveal(it)
      turn.playing = Math.max(0, turn.playing - 1)
      render()
      armStall()
      maybeDone()
    },
    // The turn's last event. Sentences that never got audio are shown now; an interrupted turn keeps only what was already said.
    finish(id, interrupted) {
      if (!turn || turn.id !== id) return
      turn.finished = true
      if (interrupted) {
        clearAll()
        for (const it of turn.items) if (it.state === 'live') reveal(it)    // the backend counts a half-played sentence as said, so it stays whole
        turn.items = turn.items.filter((it) => it.state === 'done')
        render()
        turn.doneSent = true
        onDone(id)
        return
      }
      for (const it of turn.items) if (it.state === 'wait' && it.dur === undefined) reveal(it)
      render()
      armStall()
      maybeDone()
    },
    // Speech for this turn failed: stop waiting for it.
    release(id) {
      if (!turn || turn.id !== id) return
      turn.audio = false
      for (const it of turn.items) if (it.state === 'wait' && it.dur === undefined) reveal(it)
      render()
      maybeDone()
    },
    pending() { return !!turn && !turn.doneSent },
    stop() { clearAll(); turn = null },
  }
}
