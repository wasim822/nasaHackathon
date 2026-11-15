/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NOAA's HMS smoke files have no CORS header, so the browser fetches them through this rewrite.
const hmsProxy = {
  '/proxy/hms': {
    target: 'https://satepsanone.nesdis.noaa.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/proxy\/hms/, '/pub/FIRE/web/HMS/Smoke_Polygons/KML'),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: hmsProxy },
  preview: { proxy: hmsProxy },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
