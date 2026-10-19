// Voice activity detection on the microphone (Silero via @ricky0123/vad-web, running in this window on the CPU).
// Cuts the stream into utterances and hands each one over as 16 kHz mono int16 PCM. The audio lives only in memory: it goes to the
// Nova backend on this machine over the loopback WebSocket and is never written to disk or sent anywhere else.
//
// `getStream` can be replaced (the NOVA_SMOKE_WAV test hook feeds a recording through exactly this path instead of the microphone).
const SAMPLE_RATE = 16000
const MAX_UTTERANCE_MS = 29000   // the backend refuses longer ones; a monologue is cut here

export function floatToInt16(samples) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? s * 32768 : s * 32767
  }
  return out
}

export function micStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,       // the browser's echo canceller; not guaranteed to be effective on Windows, hence the echo handling in the state machine and backend
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
}

export async function createVad({ assetBase, getStream = () => micStream(), onSpeechStart, onUtterance, onMisfire, onError }) {
  const { MicVAD } = await import('@ricky0123/vad-web')
  const vad = await MicVAD.new({
    model: 'v5',
    baseAssetPath: assetBase,
    onnxWASMBasePath: assetBase,
    startOnLoad: false,
    getStream,
    ortConfig: (ort) => { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1 },   // single thread: no SharedArrayBuffer / cross-origin isolation needed
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    redemptionMs: 600,        // silence that ends an utterance (the 600 ms of the latency budget)
    minSpeechMs: 250,         // shorter blips are misfires (door, cough)
    preSpeechPadMs: 300,      // keep the start of the first word
    onSpeechStart: () => onSpeechStart && onSpeechStart(),
    onVADMisfire: () => onMisfire && onMisfire(),
    onSpeechEnd: (audio) => {
      const pcm = floatToInt16(audio.length > SAMPLE_RATE * MAX_UTTERANCE_MS / 1000 ? audio.subarray(0, SAMPLE_RATE * MAX_UTTERANCE_MS / 1000) : audio)
      onUtterance && onUtterance(pcm, Math.round(pcm.length / SAMPLE_RATE * 1000))
    },
  }).catch((err) => { onError && onError(err); throw err })
  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy(),
  }
}

// Test hook: a MediaStream that plays the given WAV files one after another (with silence in between), so the VAD, the utterance
// frames and the backend are exercised without a microphone. `read(i)` returns the bytes of file i as an ArrayBuffer.
export function wavStream(wavs, { gapMs = 3500, leadMs = 2000, onPlay } = {}) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  const dest = ctx.createMediaStreamDestination()
  ;(async () => {
    let at = ctx.currentTime + leadMs / 1000
    for (let i = 0; i < wavs.length; i++) {
      const buf = await ctx.decodeAudioData(await wavs[i]())
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(dest)
      src.start(at)
      const index = i
      setTimeout(() => onPlay && onPlay(index, buf.duration), Math.max(0, (at - ctx.currentTime) * 1000))
      at += buf.duration + gapMs / 1000
    }
  })()
  return Promise.resolve(dest.stream)
}
