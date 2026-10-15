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

// Each build's ID: the commit on Workers Builds, otherwise the build time.
// The app compares it with /version.json to know a newer build is live.
const BUILD_ID = (process.env.WORKERS_CI_COMMIT_SHA ?? '').slice(0, 12) || `t${Date.now().toString(36)}`;

/** Writes dist/version.json with this build's ID (fetched with no caching by lib/update.ts). */
function rtdVersion(): Plugin {
  return {
    name: 'rtd-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID, built_at: new Date().toISOString() }) });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [rtdTheme(), rtdVersion()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
  // `npm run dev:web` with `npm run dev` alongside: the Worker answers /api.
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
