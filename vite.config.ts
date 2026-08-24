import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.ts';

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Chrome refuses to load an extension whose sourcemaps reference files it
    // cannot see, and shipping them bloats the package for no user benefit.
    sourcemap: false,
    target: 'esnext',
  },
  server: {
    // crxjs needs a stable port for its HMR client, which is injected into
    // pages under a fixed origin.
    port: 5173,
    strictPort: true,
  },
  test: {
    // core/ is pure and must stay runnable without a DOM. If a test ever needs
    // one, give that file its own environment rather than changing this.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
