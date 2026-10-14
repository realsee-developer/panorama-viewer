import { defineConfig } from 'vite';

// `base: './'` produces relative asset URLs so the build works when served
// from a GitHub Pages project subpath (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  server: {
    host: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
