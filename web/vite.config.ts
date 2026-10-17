import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// The workbench UI is served by the local service at /assets/app/ (see mcp/dashboard.mjs). In
// development, `npx vite --config web/vite.config.ts` proxies the API to a running dashboard.
export default defineConfig({
  root: __dirname,
  base: '/assets/app/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  clearScreen: false,
  server: {
    port: 5180,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.HROUTER_PREVIEW_PORT ?? 8790}`, changeOrigin: false }, '/health': `http://127.0.0.1:${process.env.HROUTER_PREVIEW_PORT ?? 8790}` },
  },
  build: {
    target: 'es2022',
    outDir: path.resolve(__dirname, '../assets/app'),
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/main.tsx'),
      output: { entryFileNames: 'app.js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: (info) => (info.names?.[0]?.endsWith('.css') ? 'app.css' : 'files/[name]-[hash][extname]') },
    },
  },
})
