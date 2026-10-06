/**
 * Identifying what is actually listening on a port.
 *
 * A port number and a pid answer "what is holding this"; they do not answer
 * "what is this". For a local HTTP server the useful answer is a status, a
 * `Server` header, the page title, and a picture - which is what this module
 * produces.
 *
 * Three decisions worth stating, because each one is a place this could have
 * gone wrong:
 *
 * 1. **The probe is a plain HTTP request, not a loaded page.** Reading a status
 *    line and a content type is one socket and a few milliseconds. Loading the
 *    page is only justified when a picture is actually wanted.
 *
 * 2. **The capture window is sandboxed, ephemeral and local-only.** Loading
 *    `http://127.0.0.1:<port>` executes whatever that process serves, so the
 *    window runs with `sandbox: true`, no node integration, no preload, a
 *    throwaway session partition that shares no cookies or storage with the app,
 *    and a navigation guard that refuses anything that is not loopback. It is
 *    never shown.
 *
 * 3. **Thumbnails never enter the shared state.** A 1280x800 PNG is a few hundred
 *    kilobytes; broadcasting that on every push would undo the work done to keep
 *    the state payload small. The image is returned once, to the caller that
 *    asked for it, and the renderer keeps it in its own map.
 *
 * On the capture mechanism itself: Electron's `capturePage()` is used rather
 * than a DOM-to-image library such as snapdom. snapdom reconstructs a picture
 * from serialised DOM, which is the right tool when the goal is a capture taller
 * than the viewport, but it is a reconstruction: canvas and WebGL content,
 * cross-origin images and web fonts routinely degrade or drop out of it.
 * `capturePage()` is the compositor's own output - exactly what the user sees in
 * a browser. For identifying a dev server the real frame is strictly more
 * useful, needs no injected dependency, and cannot be defeated by a page that
 * refuses to be serialised. A taller capture is available by resizing the probe
 * window, which covers the full-page case without the trade-off.
 */

import { BrowserWindow, session } from 'electron';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { logInfo, logWarn } from './logger.js';
import type { HttpIdentity } from '../shared/types.js';

/** The probe window's session. Deliberately not the app's default session. */
const PROBE_PARTITION = 'portgarden-probe';

const REQUEST_TIMEOUT_MS = 1400;
/**
 * A ceiling on one port's whole probe, across every candidate address.
 *
 * A socket that accepts a connection and then never answers is the bad case: it
 * costs the full per-request timeout, and there are four candidate URLs. Four
 * sequential timeouts would be five and a half seconds for a single unresponsive
 * port. A total budget keeps the worst case bounded without penalising the
 * ordinary case, where a refused connection returns immediately.
 */
const PROBE_BUDGET_MS = 3200;
/** Enough for `<head>` and a title; a dev server's index is usually under 20KB. */
const MAX_BODY_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 9000;
const CAPTURE_SETTLE_MS = 450;
/** Bounded so a probe can never become a way to photograph a tall page repeatedly. */
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 900;

export interface ProbeTarget {
  port: number;
  /** The bind address Windows reported, so the probe asks the right interface. */
  address: string;
}

/* --------------------------------------------------------------- http probe */

interface RawResponse {
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function requestOnce(url: string, secure: boolean, timeoutMs: number): Promise<RawResponse | { error: string }> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const transport = secure ? https : http;
    const request = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: '/',
        method: 'GET',
        // A local dev server very often serves a self-signed certificate. The
        // probe is reading a status line from loopback, not establishing trust.
        ...(secure ? { rejectUnauthorized: false } : {}),
        headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'user-agent': 'PortGarden/0.1 (+local identification)' },
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          resolve({
            url,
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        };
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
          else {
            // The title lives in the head. Reading a whole bundle to find it
            // would make the probe proportional to the asset size.
            response.destroy();
            finish();
          }
        });
        response.on('end', finish);
        response.on('error', () => finish());
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolve({ error: `no response within ${timeoutMs} ms` });
    });
    request.on('error', (error: Error) => resolve({ error: error.message }));
    request.end();
  });
}

/** Loopback is tried first, then the reported bind address, then https. */
function candidateUrls(target: ProbeTarget): Array<{ url: string; secure: boolean }> {
  const hosts = ['127.0.0.1'];
  if (target.address !== '' && target.address !== 'any' && target.address !== 'loopback' && !hosts.includes(target.address)) {
    hosts.push(target.address);
  }
  const candidates: Array<{ url: string; secure: boolean }> = [];
  for (const host of hosts) {
    candidates.push({ url: `http://${host}:${target.port}/`, secure: false });
    candidates.push({ url: `https://${host}:${target.port}/`, secure: true });
  }
  return candidates;
}

function extractTitle(body: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body);
  if (!match) return null;
  const text = match[1]!.replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : text;
}

/** The framework or product behind the port: header first, then `<meta generator>`, then the title. */
function describeService(headers: Record<string, string | string[] | undefined>, body: string, title: string | null): string | null {
  const server = headers['server'];
  const serverText = Array.isArray(server) ? server[0] : server;
  const powered = headers['x-powered-by'];
  const poweredText = Array.isArray(powered) ? powered[0] : powered;
  if (serverText && !/^$/.test(serverText)) return serverText;
  if (poweredText) return poweredText;
  const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,80})["']/i.exec(body);
  if (generator) return generator[1]!;
  return title;
}

async function probe(target: ProbeTarget): Promise<HttpIdentity> {
  const base: HttpIdentity = {
    port: target.port,
    state: 'checking',
    url: null,
    status: null,
    contentType: null,
    server: null,
    title: null,
    html: false,
    checkedAt: Date.now(),
    error: null
  };

  let lastError = 'no response';
  const deadline = Date.now() + PROBE_BUDGET_MS;
  for (const candidate of candidateUrls(target)) {
    // Once the budget is spent the remaining candidates are skipped rather than
    // each paying another timeout. Whatever answered first wins; the budget only
    // decides how long a silent socket is indulged.
    if (Date.now() >= deadline) {
      lastError = `no response within ${PROBE_BUDGET_MS} ms`;
      break;
    }
    const remaining = Math.max(200, deadline - Date.now());
    const result = await requestOnce(candidate.url, candidate.secure, Math.min(REQUEST_TIMEOUT_MS, remaining));
    if ('error' in result) {
      lastError = result.error;
      continue;
    }

    const contentTypeRaw = result.headers['content-type'];
    const contentType = Array.isArray(contentTypeRaw) ? contentTypeRaw[0] ?? null : contentTypeRaw ?? null;
    const html = contentType !== null && contentType.toLowerCase().includes('text/html');
    const title = html ? extractTitle(result.body) : null;

    return {
      ...base,
      state: html ? 'html' : 'responds',
      url: result.url,
      status: result.status,
      contentType,
      server: describeService(result.headers, result.body, title),
      title,
      html,
      checkedAt: Date.now()
    };
  }

  return { ...base, state: 'none', checkedAt: Date.now(), error: lastError };
}

/* ----------------------------------------------------------------- capture */

let captureQueue: Promise<unknown> = Promise.resolve();
let activeCaptures = 0;

/**
 * Only loopback is reachable, enforced here rather than trusted from the caller.
 * The window loads a page served by an unknown local process; it must not become
 * a way to load anything else.
 */
function isLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function captureOnce(url: string): Promise<string | null> {
  if (!isLoopback(url)) {
    logWarn(`Refused to capture ${url}: the probe window only loads loopback addresses.`);
    return null;
  }

  const partition = session.fromPartition(PROBE_PARTITION, { cache: false });
  // A page that asks for permissions from a hidden probe window is not something
  // the user consented to, so nothing is granted and nothing is prompted.
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const probe = new BrowserWindow({
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    show: false,
    frame: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CAPTURE_TIMEOUT_MS);
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      probe.webContents.once('did-finish-load', () => done(true));
      probe.webContents.once('did-fail-load', () => done(false));
      // Anything the page tries to navigate to is refused; the probe window
      // exists to look at exactly one address.
      probe.webContents.on('will-navigate', (event, target) => {
        if (target !== url) event.preventDefault();
      });
      probe.webContents.loadURL(url).catch(() => done(false));
    });

    if (!loaded) return null;
    // Give the first paint, web fonts and a synchronous app shell a moment to
    // land. Without this a client-rendered page photographs as an empty frame.
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_SETTLE_MS));

    const image = await probe.webContents.capturePage();
    if (image.isEmpty()) return null;
    return image.toDataURL();
  } catch (error) {
    logWarn(`Capture of ${url} failed: ${(error as Error).message}`);
    return null;
  } finally {
    if (!probe.isDestroyed()) probe.destroy();
  }
}

/** Serialised: one hidden window at a time, and never two probes competing for paint. */
export function capturePort(url: string): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    activeCaptures += 1;
    try {
      return await captureOnce(url);
    } finally {
      activeCaptures -= 1;
    }
  };
  const result = captureQueue.then(run, run);
  captureQueue = result.catch(() => undefined);
  return result;
}

export function activeCaptureCount(): number {
  return activeCaptures;
}

/* ------------------------------------------------------------------- cache */

interface CacheEntry {
  identity: HttpIdentity;
  /** The process identity this reading belongs to, so it invalidates on restart. */
  owner: string;
}

const cache = new Map<number, CacheEntry>();

export function cachedIdentity(port: number): HttpIdentity | null {
  return cache.get(port)?.identity ?? null;
}

export function identitySnapshot(): Record<number, HttpIdentity> {
  const out: Record<number, HttpIdentity> = {};
  for (const [port, entry] of cache) out[port] = entry.identity;
  return out;
}

/**
 * Probes a port, reusing a cached reading when the owning process has not
 * changed. `owner` is the process identity string, so a new process on the same
 * port is re-probed rather than inheriting the previous answer.
 */
export async function identify(target: ProbeTarget, owner: string, force = false): Promise<HttpIdentity> {
  const cached = cache.get(target.port);
  if (!force && cached && cached.owner === owner) return cached.identity;

  const identity = await probe(target);
  cache.set(target.port, { identity, owner });
  logInfo(
    `Port ${target.port}: ${identity.state}${identity.status ? ` ${identity.status}` : ''}${identity.server ? ` · ${identity.server}` : ''}${identity.title ? ` · ${identity.title}` : ''}`
  );
  return identity;
}

/** Drops readings for ports that are no longer listening. */
export function pruneIdentities(livePorts: readonly number[]): void {
  const live = new Set(livePorts);
  for (const port of [...cache.keys()]) if (!live.has(port)) cache.delete(port);
}

export function resetIdentifyForTest(): void {
  cache.clear();
}