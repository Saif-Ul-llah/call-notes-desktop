import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // engine.js runs in a utilityProcess and must sit next to index.js
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      // ship fonts as files: inlined data: URIs are blocked by the pages' CSP
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          button: resolve(__dirname, 'src/renderer/button.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          library: resolve(__dirname, 'src/renderer/library.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html'),
        },
      },
    },
  },
})
