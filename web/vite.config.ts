import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { themeCss } from './src/theme';

// Serves the central theme (src/theme/*.ts) as one generated stylesheet.
function rtdTheme(): Plugin {
  const id = 'virtual:rtd-theme.css';
  return {
    name: 'rtd-theme',
    resolveId: source => (source === id ? `\0${id}` : undefined),
    load: source => (source === `\0${id}` ? themeCss() : undefined),
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [rtdTheme()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
  // `npm run dev:web` with `npm run dev` alongside: the Worker answers /api.
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
