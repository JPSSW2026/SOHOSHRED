import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    sourcemap: false,
  },
  // strictPort was true: if anything already held 5173 the dev server exited
  // instead of shifting to 5174, which reads as "it will not run" rather than
  // "that port is busy". Let it fall back.
  server: { host: '0.0.0.0', port: 5173, strictPort: false },
  preview: { host: '0.0.0.0', port: 4173, strictPort: false },
});
