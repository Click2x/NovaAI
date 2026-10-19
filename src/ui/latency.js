// Latency overlay for the Ctrl+Alt+D debug view. Times are milliseconds from the moment the user's text was sent.
//   first sentence  text of the first sentence arrived (model time to first sentence)
//   first frame     first audio frame arrived
//   heard           audio started playing (what the user experiences)
// Voice turns start the clock when the utterance was sent (end of speech + the VAD's 600 ms of silence is not included); `stt` is the
// transcription time the backend reports.
// The backend adds ttft (first token), tts ms and the real-time factor (synthesis time / audio time; below 1 keeps up with playback).
export function createLatency(el) {
  let t0 = 0
  let row = null

  function render() {
    if (!row) { el.textContent = ''; return }
    const f = (v) => (v == null ? '-' : Math.round(v) + ' ms')
    const m = row.metrics || {}
    el.textContent = [
      `latency (turn ${row.turn_id})`,
      ...(row.stt != null ? [`  STT             ${f(row.stt)}  speech ${f(row.speech_ms)}`] : []),
      `  TTFT            ${f(m.ttft_ms)}`,
      `  first sentence  ${f(row.sentence)}`,
      `  first frame     ${f(row.frame)}`,
      `  heard           ${f(row.heard)}   [target < 1500]`,
      `  TTS total       ${f(m.tts_ms)}  audio ${f(m.audio_ms)}`,
      `  real-time factor ${m.rtf == null ? '-' : m.rtf}`,
    ].join('\n')
  }

  return {
    // backdateMs: the clock started that long ago (voice: when the utterance left the app); stt / speechMs come from the transcript.
    start(turn_id, { backdateMs = 0, stt = null, speechMs = null } = {}) {
      t0 = performance.now() - backdateMs
      row = { turn_id, sentence: null, frame: null, heard: null, metrics: null, stt, speech_ms: speechMs }
      render()
    },
    mark(key) { if (row && row[key] == null) { row[key] = performance.now() - t0; render() } },
    metrics(m) { if (row) { row.metrics = m; render() } },
    snapshot: () => (row ? { ...row } : null),
  }
}
