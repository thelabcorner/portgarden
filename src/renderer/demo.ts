/**
 * The demo page.
 *
 * Renders the **real** views and the real stylesheet against fictional data, so
 * the screenshot in the README shows the actual interface rather than a mockup
 * that could drift from it.
 *
 * Nothing here is reachable from the running app. This is a separate document
 * loaded only when `PORTGARDEN_DEMO=1` is set, and `window.ts` refuses it when
 * the app is packaged.
 *
 * The bridge is not stubbed here. `contextBridge.exposeInMainWorld` defines a
 * read-only property, so a page cannot replace the bridge - and it should not be
 * able to. The preload decides: the main process passes `--portgarden-demo` to
 * the renderer, and the preload exposes fictional data instead of IPC.
 */

import '@fontsource-variable/inter';
import './style.css';

import { mount } from './app.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('demo root element is missing');

// Set before mounting so the first paint is in the right theme; the preload's
// stub reads the same query string.
document.documentElement.dataset['theme'] = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';

/*
 * A demo that fails silently is worse than one that fails loudly: a blank window
 * is indistinguishable from a stylesheet problem, a bad import, or eight other
 * things. The error goes into the page, where a screenshot can read it.
 */
try {
  mount(root);
} catch (error) {
  root.textContent = `Demo failed to mount:\n\n${error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)}`;
  root.style.color = '#ff8080';
  root.style.padding = '24px';
  root.style.whiteSpace = 'pre-wrap';
  root.style.fontFamily = 'monospace';
  throw error;
}