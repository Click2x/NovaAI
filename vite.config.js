import { defineConfig } from 'vite'
import { resolve, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs'

// The voice activity detector loads its model, audio worklet and ONNX runtime (wasm) at run time from one folder next to the page.
// They are not bundled: this plugin serves them from node_modules in dev and copies them to dist/vad/ on build, so nothing is fetched
// from a CDN and the app works offline.
const VAD_FILES = {
  'silero_vad_v5.onnx': '@ricky0123/vad-web/dist/silero_vad_v5.onnx',
  'vad.worklet.bundle.min.js': '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
  'ort-wasm-simd-threaded.wasm': 'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs': 'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
}
const MIME = { '.onnx': 'application/octet-stream', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }

function vadAssets() {
  const source = (name) => resolve(__dirname, 'node_modules', VAD_FILES[name])
  return {
    name: 'nova-vad-assets',
    configureServer(server) {
      server.middlewares.use('/vad/', (req, res, next) => {
        const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\//, ''))
        if (!Object.prototype.hasOwnProperty.call(VAD_FILES, name)) return next()
        res.setHeader('Content-Type', MIME[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream')
        createReadStream(source(name)).pipe(res)
      })
    },
    closeBundle() {
      const out = resolve(__dirname, 'dist', 'vad')
      mkdirSync(out, { recursive: true })
      for (const name of Object.keys(VAD_FILES)) if (existsSync(source(name))) copyFileSync(source(name), join(out, name))
    },
  }
}

// Relative base so the built pages load from file:// inside Electron.
// Three pages: the avatar overlay (index.html), the Code stand-in window (code.html) and the settings panel (settings.html).
export default defineConfig({
  base: './',
  plugins: [vadAssets()],
  server: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { index: resolve(__dirname, 'index.html'), code: resolve(__dirname, 'code.html'), chat: resolve(__dirname, 'chat.html'), onboarding: resolve(__dirname, 'onboarding.html'), settings: resolve(__dirname, 'settings.html') },
    },
  },
})
