import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Resolve the single three.js build we use everywhere. The WebGPU build
// (`three/webgpu`) is a standalone bundle that includes all of three.js core.
// Importing core classes from bare `three` AND the renderer from
// `three/webgpu` would load TWO copies of three.js ("Multiple instances of
// Three.js" warning + broken instanceof checks). Aliasing bare `three` — and
// the UltraHDRLoader addon, which imports from `three` — to the WebGPU build
// forces a single instance.
const threeWebGPU = fileURLToPath(
  new URL('./node_modules/three/build/three.webgpu.js', import.meta.url)
);

// `base: './'` produces relative asset URLs so the build works when served
// from a GitHub Pages project subpath (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  resolve: {
    alias: [
      // Remap only the bare `three` entry to the WebGPU build. The
      // `three/examples/...` and `three/webgpu` specifiers resolve normally.
      { find: /^three$/, replacement: threeWebGPU },
    ],
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
