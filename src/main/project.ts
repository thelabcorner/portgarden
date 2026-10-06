/**
 * Resolving a port to the project that owns it.
 *
 * Windows does not expose another process's working directory. Reading it means
 * reading the target's PEB - an NT structure reached with `ReadProcessMemory` -
 * which is a deliberate deferral, not an oversight. So a project root here is
 * always *inferred*, and the result says which evidence produced it:
 *
 *   1. An absolute path in the command line. `node C:\work\api\node_modules\
 *      vite\bin\vite.js --port 5173` walks up to `C:\work\api`, because that is
 *      where `.git` or `package.json` lives. This is the reliable case for the
 *      toolchains this app exists for.
 *   2. The executable path, used only when the command line yielded nothing.
 *      `C:\work\api\.venv\Scripts\python.exe` finds the same root from the other
 *      direction, which is why virtualenv-hosted tooling still resolves.
 *   3. Nothing. Reported as `unknown` rather than guessed.
 *
 * The confidence label is not decoration. Presenting an inferred root as "the
 * working directory" would be a lie the user cannot see, and they would act on
 * it - so the UI renders the basis next to every project name.
 */

import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import type { ProcessRole, ProjectInfo } from '../shared/types.js';

/** Filesystem access, injected so the walk can be tested without real disks. */
export interface ProjectIo {
  readDirectory(directory: string): string[];
  readTextFile(file: string): string | null;
}

export const nodeProjectIo: ProjectIo = {
  readDirectory(directory) {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
  readTextFile(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
};

/**
 * A directory containing any of these is a project root. `.git` counts whether
 * it is a directory or a file, because a worktree or submodule uses a file - so
 * membership of the directory listing is the test, not the entry's type.
 */
const MARKERS: readonly string[] = [
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml'
];

const MARKER_SUFFIXES: readonly string[] = ['.sln', '.csproj', '.fsproj', '.xcodeproj'];

const MAX_WALK = 12;

export function isProjectDirectory(entries: readonly string[]): boolean {
  return entries.some(
    (entry) => MARKERS.includes(entry) || MARKER_SUFFIXES.some((suffix) => entry.toLowerCase().endsWith(suffix))
  );
}

/**
 * Walks up from `start` to the nearest project root.
 *
 * `start` may be a file; the walk begins at its directory. A path that reaches
 * the drive root without a marker yields null - an unresolvable root is a valid
 * answer, and pretending otherwise would be the exact failure this file exists
 * to prevent.
 */
export function findProjectRoot(start: string, io: ProjectIo): string | null {
  let current = path.extname(start) === '' ? start : path.dirname(start);
  for (let depth = 0; depth < MAX_WALK; depth += 1) {
    if (isProjectDirectory(io.readDirectory(current))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/*
 * Built through `String.raw` on purpose. A UNC prefix is two literal
 * backslashes, which in a regex literal is four backslash characters - and that
 * run is exactly the kind of sequence that gets doubled by an editor, a patch
 * tool or a quoting layer. Six backslashes silently compiles to "three literal
 * backslashes" and the UNC branch stops matching with no error anywhere.
 * `String.raw` takes the characters exactly as written, so the count stays
 * visible and cannot drift.
 */
const PATH_PATTERN = new RegExp(
  String.raw`"([^"]+)"|'([^']+)'|([A-Za-z]:[\\/][^\s"']+)|(\\\\[^\\\s]+\\[^\s"']+)`,
  'g'
);

/**
 * Absolute paths mentioned by a command line, in the order they appear.
 *
 * Relative paths are deliberately ignored: resolving one needs a working
 * directory, which is precisely the thing Windows will not give us. Guessing
 * one and reporting it as fact would defeat the point of the confidence label.
 */
export function extractPathCandidates(commandLine: string): string[] {
  const found: string[] = [];
  for (const match of commandLine.matchAll(PATH_PATTERN)) {
    const candidate = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!candidate) continue;
    if (!/[\\/]/.test(candidate)) continue;
    found.push(candidate);
  }
  return found;
}

/** `--port`, `-p`, `PORT=` and friends. Order is most-specific first. */
const PORT_PATTERNS: readonly RegExp[] = [
  /--port(?:=|\s+)(\d{1,5})/i,
  /\bPORT=(\d{1,5})/i,
  /--listen(?:=|\s+)?(?:\S*?:)?(\d{1,5})/i,
  /\.port\s*=\s*(\d{1,5})/i,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})/i
];

/**
 * `-p` is overloaded across the ecosystem: it is a port for `rails` and a
 * "project" flag for `go build`. It is only honoured when a known server
 * framework is present, which is the difference between a useful hint and a
 * confidently wrong number.
 */
const SHORT_PORT = /(?:^|\s)-p\s+(\d{1,5})(?=\s|$)/i;

const FRAMEWORK_HINT =
  /\b(vite|next|nuxt|webpack|parcel|rollup|serve|http-server|live-server|json-server|uvicorn|gunicorn|flask|django|manage\.py|fastapi|rails|puma|phoenix|remix|astro|svelte|expo|metro|detox|storybook|tsx|ts-node|nodemon|angular|ng)\b/i;

/**
 * The port a process asked for on its own command line, or null if it did not
 * ask. A mismatch against the port actually bound is the "I asked for 4000 and
 * got 3000" case, which is one of the more confusing failures to debug from a
 * terminal and completely obvious when a tool simply points at it.
 */
export function resolveDeclaredPort(commandLine: string | null): number | null {
  if (!commandLine) return null;
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(commandLine);
    const port = match ? Number(match[1]) : 0;
    if (port > 0 && port <= 65535) return port;
  }
  if (FRAMEWORK_HINT.test(commandLine)) {
    const match = SHORT_PORT.exec(commandLine);
    const port = match ? Number(match[1]) : 0;
    if (port > 0 && port <= 65535) return port;
  }
  return null;
}

const DATA_SERVICES = new Set([
  'postgres',
  'sqlservr',
  'sqlagent',
  'mssql',
  'mysqld',
  'mariadbd',
  'mongod',
  'redis-server',
  'influxd',
  'elastic'
]);

/**
 * Session-critical and kernel processes.
 *
 * `services.exe` is deliberately absent: it is the Service Control Manager and
 * is classified as a service rather than as one of these. Listing it here would
 * make the service branch unreachable.
 */
const SYSTEM_IMAGES = new Set([
  'system',
  'smss',
  'csrss',
  'wininit',
  'lsass',
  'svchost',
  'dwm',
  'fontdrvhost',
  'sihost',
  'winlogon',
  'spoolsv',
  'searchindexer',
  'searchprotocolhost',
  'memcompression',
  'registry',
  'secure',
  'taskhostw',
  'wudfhost'
]);

const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium']);

/** An explicit "this is a dev server" signal, checked before the bare runtimes. */
const DEV_SERVER =
  /\b(vite|next dev|nuxt|webpack serve|parcel|ng serve|react-scripts|astro dev|remix dev|svelte-kit|uvicorn|gunicorn|manage\.py runserver|flask run|rails server|rails s|http-server|live-server|json-server|mcp-server|dotnet run|cargo watch)\b/i;

export const ROLE_LABELS: Record<ProcessRole, string> = {
  'dev-server': 'Dev server',
  node: 'Node.js',
  python: 'Python',
  dotnet: '.NET',
  java: 'Java',
  'docker-forward': 'Docker port forward',
  database: 'Database',
  browser: 'Browser',
  system: 'Windows system',
  service: 'Windows service',
  other: 'Other'
};

/**
 * A plain-language role for a process, from its image name and command line.
 *
 * Order is significant: a database running under a `python` image name is still
 * a database, and a Docker port forward is still a Docker port forward even
 * though it is the only thing holding that port from the outside.
 */
export function classifyRole(name: string, commandLine: string | null): ProcessRole {
  const image = name.toLowerCase();
  const argv = (commandLine ?? '').toLowerCase();

  if (
    image === 'docker-proxy' ||
    image === 'com.docker.backend' ||
    argv.includes('docker-proxy') ||
    argv.includes('com.docker.backend')
  ) {
    return 'docker-forward';
  }
  if (DATA_SERVICES.has(image)) return 'database';
  if (SYSTEM_IMAGES.has(image)) return 'system';
  if (BROWSERS.has(image)) return 'browser';
  if (image === 'svchost' || image === 'services') return 'service';
  if (image === 'node' || image === 'nodejs') return DEV_SERVER.test(argv) ? 'dev-server' : 'node';
  if (image.startsWith('python')) return 'python';
  if (image === 'dotnet' || argv.startsWith('dotnet ')) return 'dotnet';
  if (image === 'java' || image === 'javaw' || argv.startsWith('java ')) return 'java';
  if (DEV_SERVER.test(argv)) return 'dev-server';
  return 'other';
}

/** Uses package.json's `name` when readable, because a directory name is often `my-app-2`. */
function readPackageName(root: string, io: ProjectIo): string | null {
  const text = io.readTextFile(path.join(root, 'package.json'));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  commandLine: string | null;
  image: string | null;
  io: ProjectIo;
}

/**
 * Resolves the project a process belongs to, with the evidence that produced it.
 *
 * A small per-path cache sits in front of the walk because the same executable
 * and the same script path recur across every scan, and a directory walk per row
 * per refresh is the kind of thing that turns a 700ms scan into two seconds.
 */
export class ProjectResolver {
  private readonly cache = new Map<string, ProjectInfo>();
  private readonly cachedAt = new Map<string, number>();
  private static readonly CACHE_LIMIT = 500;
  private static readonly CACHE_TTL_MS = 30_000;

  private remember(key: string, info: ProjectInfo, now: number): ProjectInfo {
    this.cache.set(key, info);
    this.cachedAt.set(key, now);
    if (this.cache.size > ProjectResolver.CACHE_LIMIT) {
      const oldest = [...this.cachedAt.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.cachedAt.delete(oldest);
      }
    }
    return info;
  }

  resolve(options: ResolveOptions, now = Date.now()): ProjectInfo {
    const candidates = options.commandLine ? extractPathCandidates(options.commandLine) : [];
    const sources: Array<{ path: string; basis: string }> = candidates.map((entry) => ({
      path: entry,
      basis: 'inferred from the command line'
    }));
    if (options.image) sources.push({ path: options.image, basis: 'inferred from the executable path' });

    for (const source of sources) {
      const key = source.path.toLowerCase();
      const stamp = this.cachedAt.get(key);
      const hit = this.cache.get(key);
      if (hit && stamp !== undefined && now - stamp < ProjectResolver.CACHE_TTL_MS) return hit;

      const root = findProjectRoot(source.path, options.io);
      const info: ProjectInfo = root
        ? { root, name: readPackageName(root, options.io) ?? path.basename(root), confidence: 'inferred', basis: source.basis }
        : { root: null, name: null, confidence: 'unknown', basis: 'no project marker found' };
      this.remember(key, info, now);
      if (info.root) return info;
    }

    return { root: null, name: null, confidence: 'unknown', basis: options.commandLine ? 'no project marker found' : 'command line unavailable' };
  }
}
