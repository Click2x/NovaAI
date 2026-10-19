import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Relative base so the built pages load from file:// inside Electron.
// Two pages: the avatar overlay (index.html) and the Code stand-in window (code.html).
export default defineConfig({
  base: './',
  server: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { index: resolve(__dirname, 'index.html'), code: resolve(__dirname, 'code.html') },
    },
  },
})
