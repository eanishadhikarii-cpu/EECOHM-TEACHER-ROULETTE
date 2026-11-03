import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
  const realtimeUrl = process.env.VITE_WS_URL?.trim()
  if (mode === 'production' && process.env.VERCEL === '1') {
    if (!realtimeUrl) throw new Error('Set VITE_WS_URL to the Render wss://.../ws endpoint before deploying the Vercel frontend.')
    const parsedUrl = new URL(realtimeUrl)
    if (parsedUrl.protocol !== 'wss:' || parsedUrl.pathname !== '/ws') {
      throw new Error('VITE_WS_URL must be a secure WebSocket URL ending in /ws.')
    }
  }
  return {
    plugins: [react()],
  }
})
