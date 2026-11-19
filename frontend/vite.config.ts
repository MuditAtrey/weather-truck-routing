import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// API_TARGET points the dev server at another backend (e.g. the deployed one).
const api = { target: process.env.API_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true }

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1100, sourcemap: false },
  server: { proxy: { '/api': api } },
  preview: { proxy: { '/api': api } },
})
