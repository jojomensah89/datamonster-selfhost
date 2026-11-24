import { readdirSync, rmSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/dashboard',
  publicDir: '../../public',
  plugins: [
    react(),
    {
      name: 'exclude-general-sans',
      closeBundle() {
        for (const file of readdirSync('dist/fonts')) {
          if (file.startsWith('GeneralSans')) rmSync('dist/fonts/' + file);
        }
      },
    },
  ],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
