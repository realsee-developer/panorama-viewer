import { defineConfig } from 'vite';

// `base: './'` produces relative asset URLs so the build works when served
// from a GitHub Pages project subpath (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  resolve: {
    // All three.js usage goes through `three/webgpu` (core + renderer) and
    // `three/tsl` (node functions); `dedupe` keeps the core shared by
    // `three/tsl`'s internal `three` import as a single instance (no
    // "Multiple instances of Three.js").
    dedupe: ['three'],
  },
  server: {
    host: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
