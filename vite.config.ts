import { defineConfig } from 'vite';

// `base: './'` keeps every asset reference relative, so the same build works on
// GitHub Pages project sites, Vercel, Netlify, or a plain static file server.
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
