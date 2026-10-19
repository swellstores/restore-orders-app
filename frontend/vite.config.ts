import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // Swell CLI tunnels reach the dev server through these hosts.
    allowedHosts: ['.trycloudflare.com', '.swell.store', '.swell.test'],
  },
})