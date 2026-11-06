import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'app',
  envDir: '..',
  plugins: [react()],
  // The PDF chunk (pdf-lib + fontkit) is large but loaded only when a PDF is produced.
  build: { outDir: '../dist-app', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1100 },
  server: { port: 5173, strictPort: true, host: true },
  preview: { port: 4174, strictPort: true, host: true },
});
