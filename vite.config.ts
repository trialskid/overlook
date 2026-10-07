import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the Hono backend (npm run dev starts both).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/web', emptyOutDir: true, assetsInlineLimit: 0 }, // no data: URIs (CSP font-src 'self')
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
});
