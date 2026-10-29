import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dev server proxies the API and WebSocket endpoint to the Go PoC server,
// so the browser sees a single origin (cookies and the Origin check work).
const backend = process.env.COLLABSPACE_BACKEND ?? '127.0.0.1:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://${backend}`,
      '/ws': { target: `ws://${backend}`, ws: true },
    },
  },
})
