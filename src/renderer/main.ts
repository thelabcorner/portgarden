/*
 * Inter, self-hosted.
 *
 * The design guide's font stack already lists "Inter Variable" ahead of the
 * Segoe fallback, so shipping the font is the whole change - no stack edit and
 * no deviation from the guide. Self-hosted rather than a CDN link because the
 * renderer's CSP is `default-src 'none'` with no network egress, which is the
 * correct posture for a control surface and worth more than the convenience.
 */
import '@fontsource-variable/inter';
import './style.css';
import { mount } from './app.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Port Garden root element is missing');
mount(root);