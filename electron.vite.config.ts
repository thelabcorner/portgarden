import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * The renderer's Content-Security-Policy.
 *
 * Production is deliberately as tight as it can be: no remote content, no
 * inline script, no network egress at all. The renderer is a control surface,
 * not a web page, and a tool description or a process command line should never
 * be able to become executable.
 *
 * Development needs two exceptions, and only in development:
 *
 *   - `connect-src ws:` for Vite's HMR socket. Without it the page loads, the
 *     CSS is served correctly, and every edit is silently ignored because the
 *     hot-update channel cannot open - which reads exactly like a build that is
 *     not running.
 *   - `script-src 'unsafe-inline'` because Vite injects its client inline.
 *
 * Injecting these at serve time rather than writing them into index.html keeps
 * the shipped document strict. Relaxing the production policy to make
 * development convenient would be the wrong trade for a utility that runs with
 * an administrator token available to it.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join('; ');

const DEVELOPMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The HMR websocket and the dev server's own module requests.
  "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*"
].join('; ');

function contentSecurityPolicy(development: boolean): Plugin {
  return {
    name: 'portgarden-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string): string {
        return html.replace(
          /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i,
          `$1${development ? DEVELOPMENT_CSP : PRODUCTION_CSP}$2`
        );
      }
    }
  };
}

export default defineConfig(({ command }) => {
  const development = command === 'serve';
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [contentSecurityPolicy(development)],
      build: {
        rollupOptions: {
          input: {
            // The control window.
            index: resolve(__dirname, 'src/renderer/index.html'),
            // The documentation demo: the same views against fictional data, used
            // for the README screenshot. Built as its own entry so it can never
            // be reached from the app's own document.
            demo: resolve(__dirname, 'src/renderer/demo.html')
          }
        }
      }
    }
  };
});