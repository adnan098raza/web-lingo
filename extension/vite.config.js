import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the popup (index.html). Everything in public/ (manifest, background, content script)
// is copied to dist/ unchanged.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
