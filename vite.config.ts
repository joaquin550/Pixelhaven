import { defineConfig } from 'vite';

// `SINGLE_FILE=1` builds everything into one bundle with no code splitting, so
// scripts/build-single.mjs can inline it into a standalone .html that runs from
// anywhere - a file share, an email attachment, or a static host with no
// directory structure to preserve.
const singleFile = process.env.SINGLE_FILE === '1';

// `base: './'` keeps every asset reference relative, so the same build works on
// GitHub Pages project sites, Vercel, Netlify, or a plain static file server.
export default defineConfig({
  base: './',
  define: {
    __SINGLE_FILE__: JSON.stringify(singleFile),
  },
  server: { host: '0.0.0.0', port: 5173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: singleFile
        ? { inlineDynamicImports: true, manualChunks: undefined }
        : { manualChunks: { three: ['three'] } },
    },
  },
});
