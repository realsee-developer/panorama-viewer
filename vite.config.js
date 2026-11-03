import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// License files that must ship alongside the built site. The repository root
// is the single source of truth; they are emitted into the build output (and
// served by the dev server) instead of keeping duplicate copies in public/.
const LICENSE_FILES = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'];

function licenseFiles() {
  const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  return {
    name: 'license-files',
    // Build: emit each file at the root of dist/.
    generateBundle() {
      for (const name of LICENSE_FILES) {
        this.emitFile({ type: 'asset', fileName: name, source: read(name) });
      }
    },
    // Dev: serve the same files at the same URLs.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = LICENSE_FILES.find((n) => req.url?.split('?')[0].endsWith('/' + n));
        if (!name) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(read(name));
      });
    },
  };
}

// `base: './'` produces relative asset URLs so the build works when served
// from a GitHub Pages project subpath (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  plugins: [licenseFiles()],
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
    rolldownOptions: {
      output: {
        // Keep three.js (about 900 kB minified, and the bulk of the bundle) in
        // its own chunk. It changes far less often than the app code, so a
        // returning visitor re-downloads only the small app chunk after a
        // deploy. Only the core build is grouped: the lazily imported EXR/HDR
        // decoders under three/examples stay in their own on-demand chunks.
        codeSplitting: {
          groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/ }],
        },
      },
    },
    // three.js itself is ~900 kB minified and is needed at startup, so it can't
    // be made smaller or deferred. Warn only if a chunk grows well past it.
    chunkSizeWarningLimit: 1000,
  },
});
