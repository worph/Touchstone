import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vitest would otherwise pick up `vite.config.ts`, whose `root` is `src/web` — the SPA's
 * root, not the repo's — and find no test files at all. This config exists only to point
 * it back at the repo root; it takes precedence over `vite.config.ts` wholesale, so the
 * web build is unaffected.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.{ts,tsx}'],
    // The archive tests build an index over ~140 files. That is ~1s alone and several
    // times that when the whole suite is competing for the same cores, so the 5s default
    // fails them for being scheduled badly rather than for being wrong.
    testTimeout: 30_000,
  },
});
