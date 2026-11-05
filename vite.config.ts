import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'app',
  envDir: '..',
  plugins: [react()],
  build: { outDir: '../dist-app', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, strictPort: true, host: true },
  preview: { port: 4174, strictPort: true, host: true },
});
