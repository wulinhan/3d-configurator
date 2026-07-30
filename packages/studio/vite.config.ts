import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The embed sources are imported by relative path from ../embed/src — same
  // files the embed bundle is built from, so the Studio preview and the
  // shipped configurator can't drift apart.
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1024 },
});
