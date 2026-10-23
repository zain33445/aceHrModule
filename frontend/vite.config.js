import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// The backend the dev server proxies to.
const BACKEND = process.env.ACEHRM_BACKEND || 'http://localhost:5000'

// The browser only exposes camera/microphone on a *secure* origin.
// http://localhost is treated as secure, but a LAN address such as
// http://192.168.18.65:5173 is not, so getUserMedia is unavailable and calls
// end up with no audio or video.
//
// So LAN mode (--host 0.0.0.0) always serves HTTPS with a self-signed
// certificate; the browser asks once and then treats the origin as secure.
// Set ACEHRM_DEV_HTTPS=1 to force it for plain `vite` as well.
const wantsLan = process.argv.some((arg) => arg.includes('0.0.0.0'))
const useHttps = process.env.ACEHRM_DEV_HTTPS === '1' || wantsLan

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    ...(useHttps ? [basicSsl()] : []),
  ],
  base: './',
  server: {
    // Listen on every interface so the app can be opened from other devices.
    host: '0.0.0.0',
    proxy: {
      // The browser app talks to the dev server only, and the dev server
      // forwards to the backend. This keeps the page same-origin, which is
      // required when the dev server is served over HTTPS (a secure page may
      // not call a plain-HTTP API).
      '/api': { target: BACKEND, changeOrigin: true, ws: true },
      // The WebSocket gateways live at the root of the backend.
      '/call-ws': { target: BACKEND, ws: true },
      '/chat-ws': { target: BACKEND, ws: true },
      '/recording-ws': { target: BACKEND, ws: true },
      '/admin-recording-ws': { target: BACKEND, ws: true },
    },
  },
  build: {
    outDir: 'dist_build',
  },
})
