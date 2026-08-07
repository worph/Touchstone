import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The SPA is built into dist/web and served by Fastify in production; in dev, Vite
// serves it on 5173 and proxies /api to the API process. One port in prod, two in dev.
export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  publicDir: false,
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Bind all interfaces: the dev server runs inside a container and is viewed
    // from the host browser, so the default localhost-only bind is unreachable.
    host: true,
    // 8080 is the production default, but it is occupied by ttyd in the dev
    // container, so dev:api overrides TOUCHSTONE_PORT to 8081 and this follows.
    proxy: {
      '/api': 'http://localhost:8081',
    },
  },
});
