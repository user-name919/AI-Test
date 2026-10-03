import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { sites } from '../build/sites-vite-plugin'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [vue(), sites(fileURLToPath(new URL('../', import.meta.url)))],
  server: {
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    },
    watch: process.env.CODEX_SANDBOX === 'seatbelt'
      ? { useFsEvents: false, usePolling: true }
      : undefined
  },
  build: { target: 'es2022' }
})
