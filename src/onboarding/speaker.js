// Speaks a queue of lines, one after another, and tells the page what is being said right now.
//
// The next line's audio is requested while the current one plays, so there is no gap between sentences. Three ways to speak a line:
//   1. the backend's voice  (synth -> bytes -> play), with lip-sync through the page's analyser
//   2. the system voice     (when the backend has no voice installed)
//   3. silently, for as long as it takes to read it (muted, or no voice available at all)
// `stop()` cuts the current line and drops the queue; lines said after a stop are not affected by it.
import { readMs } from './model.js'

export function createSpeaker({ synth, play, system, wait = (ms) => new Promise((r) => setTimeout(r, ms)), onLine, onState, isMuted = () => false }) {
  let queue = []
  let running = false
  let generation = 0
  let idleWaiters = []
  let stopCurrent = null

  const flushIdle = () => { const w = idleWaiters; idleWaiters = []; w.forEach((r) => r()) }

  async function speakOne(line, prefetched, gen) {
    if (isMuted()) { onLine(line); await wait(readMs(line.text)); return }
    const audio = await prefetched
    if (gen !== generation) return
    onLine(line)
    if (audio) {
      await play(audio, (stop) => { stopCurrent = stop })
    } else if (system) {
      await system(line.text, (stop) => { stopCurrent = stop })
    } else {
      await wait(readMs(line.text))
    }
    stopCurrent = null
  }

  async function run() {
    if (running) return
    running = true
    onState && onState(true)
    const gen = generation
    try {
      while (queue.length && gen === generation) {
        const line = queue.shift()
        const prefetch = () => (isMuted() ? Promise.resolve(null) : Promise.resolve(synth(line.text)).catch(() => null))
        const current = line.__audio || prefetch()
        const next = queue[0]
        if (next && !isMuted()) next.__audio = Promise.resolve(synth(next.text)).catch(() => null)     // start the next one now
        await speakOne(line, current, gen)
      }
    } finally {
      if (gen === generation) { running = false; onState && onState(false); flushIdle() }
    }
  }

  return {
    say(lines) {
      const clean = (Array.isArray(lines) ? lines : []).filter((l) => l && typeof l.text === 'string' && l.text.trim())
      queue.push(...clean.map((l) => ({ ...l })))
      run()
    },
    stop() {
      generation++
      queue = []
      if (stopCurrent) { try { stopCurrent() } catch { /* already finished */ } stopCurrent = null }
      if (running) { running = false; onState && onState(false) }
      flushIdle()
    },
    idle() { return running || queue.length ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve() },
    pending: () => queue.length + (running ? 1 : 0),
  }
}
