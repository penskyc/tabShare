import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { alphaTab } from '@coderline/alphatab-vite';

export default defineConfig({
  plugins: [react(), alphaTab()],
  // The NAM AudioWorklet processor (src/rig/nam-processor.ts?worker&url) imports an ES module.
  worker: { format: 'es' },
  server: {
    port: 5173,
    // The desktop app is its own package; watching it locks desktop/dist on Windows and breaks electron-builder.
    watch: { ignored: ['**/desktop/**'] },
    proxy: {
      '/api': 'http://localhost:3001',
      '/downloads': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
