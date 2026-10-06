/**
 * Fictional data for the documentation screenshot and the demo page.
 *
 * This exists so the published screenshot shows what the interface looks like
 * without publishing a real machine's process list. Every name here is invented:
 * `acme-web`, `billing-service`, and the "CORP" account are not anybody's.
 *
 * It is deliberately *not* reachable from the running app. Demo mode is entered
 * by loading a separate document (`demo.html`) under an environment variable that
 * only works in an unpackaged dev run - see `window.ts`. A port tool that could
 * ever show fabricated rows would have failed at the one thing it is for, so the
 * mock data lives in the renderer's own entry point and never in the probe path.
 */

import type { AppState, HistoryEntry, PortBinding, PortRow, ProcessInfo, ProcessRole, ScanResult, Settings } from '../shared/types.js';

interface ProcessSpec {
  pid: number;
  name: string;
  role: ProcessRole;
  /** Null for a protected system process, where Windows withholds it. */
  owner: string | null;
  image: string | null;
  commandLine: string | null;
  project: { root: string | null; name: string | null; basis: string };
  workingSetBytes: number;
  cpuPercent: number | null;
  ageMinutes: number;
  declaredPort: number | null;
  ports: number[];
  ancestry: number[];
  descendants: number[];
  protected?: boolean;
  identityConfidence?: 'inferred' | 'unknown';
}

const ACCOUNT = 'CORP\\dev';

function buildProcess(spec: ProcessSpec, now: number): ProcessInfo {
  const createdAt = new Date(now - spec.ageMinutes * 60_000).toISOString();
  return {
    pid: spec.pid,
    ppid: 8124,
    owner: spec.owner,
    name: spec.name,
    image: spec.image,
    commandLine: spec.commandLine,
    createdAt,
    workingSetBytes: spec.workingSetBytes,
    cpuPercent: spec.cpuPercent,
    sessionId: 1,
    role: spec.role,
    project: {
      root: spec.project.root,
      name: spec.project.name,
      confidence: spec.project.root === null ? 'unknown' : 'inferred',
      basis: spec.project.basis
    },
    declaredPort: spec.declaredPort,
    ports: spec.ports,
    protected: spec.protected === true,
    identity: { pid: spec.pid, createdAt, image: spec.image },
    ancestry: spec.ancestry,
    descendants: spec.descendants
  };
}

function binding(port: number, address: string, raw: string, family: 'IPv4' | 'IPv6'): PortBinding {
  return { port, address, rawAddress: raw, family, wildcard: address === 'any' };
}

interface RowSpec {
  port: number;
  bindings: Array<[string, string, 'IPv4' | 'IPv6']>;
  process: ProcessSpec;
  pinned?: boolean;
  mismatch?: boolean;
}

const SPECS: RowSpec[] = [
  {
    port: 5173,
    bindings: [['loopback', '127.0.0.1', 'IPv4']],
    pinned: true,
    process: {
      pid: 23144,
      name: 'node',
      role: 'dev-server',
      owner: ACCOUNT,
      image: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\acme-web\\node_modules\\vite\\bin\\vite.js" --port 5173',
      project: { root: 'C:\\work\\acme-web', name: 'acme-web', basis: 'inferred from the command line' },
      workingSetBytes: 128 * 1024 * 1024,
      cpuPercent: 0.4,
      ageMinutes: 96,
      declaredPort: 5173,
      ports: [5173, 24678],
      ancestry: [8124, 11002],
      descendants: [24012, 24013]
    }
  },
  {
    port: 24678,
    bindings: [['any', '0.0.0.0', 'IPv4']],
    process: {
      pid: 24012,
      name: 'node',
      role: 'node',
      owner: ACCOUNT,
      image: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: null,
      project: { root: null, name: null, basis: 'command line unavailable' },
      workingSetBytes: 24 * 1024 * 1024,
      cpuPercent: 0,
      ageMinutes: 95,
      declaredPort: null,
      ports: [24678],
      ancestry: [23144, 8124, 11002],
      descendants: []
    }
  },
  {
    port: 3000,
    bindings: [['any', '0.0.0.0', 'IPv4'], ['any', '::', 'IPv6']],
    process: {
      pid: 19088,
      name: 'node',
      role: 'dev-server',
      owner: ACCOUNT,
      image: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\acme-api\\src\\server.ts" --port 3000',
      project: { root: 'C:\\work\\acme-api', name: 'acme-api', basis: 'inferred from the command line' },
      workingSetBytes: 96 * 1024 * 1024,
      cpuPercent: 1.2,
      ageMinutes: 34,
      declaredPort: 3000,
      ports: [3000],
      ancestry: [8124, 11002],
      descendants: [19120]
    }
  },
  {
    port: 4200,
    bindings: [['loopback', '127.0.0.1', 'IPv4']],
    process: {
      pid: 27610,
      name: 'node',
      role: 'dev-server',
      owner: ACCOUNT,
      image: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\admin-portal\\node_modules\\@angular\\cli\\bin\\ng.js" serve --port 4200',
      project: { root: 'C:\\work\\admin-portal', name: 'admin-portal', basis: 'inferred from the command line' },
      workingSetBytes: 512 * 1024 * 1024,
      cpuPercent: 3.8,
      ageMinutes: 12,
      declaredPort: 4200,
      ports: [4200],
      ancestry: [8124, 11002],
      descendants: [27644, 27645]
    }
  },
  {
    port: 8080,
    bindings: [['any', '0.0.0.0', 'IPv4']],
    mismatch: true,
    process: {
      pid: 15420,
      name: 'java',
      role: 'java',
      owner: ACCOUNT,
      image: 'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe',
      commandLine: '"C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe" -jar billing-service.jar --server.port=8081',
      project: { root: 'C:\\work\\billing-service', name: 'billing-service', basis: 'inferred from the command line' },
      workingSetBytes: 720 * 1024 * 1024,
      cpuPercent: 0.8,
      ageMinutes: 260,
      declaredPort: 8081,
      ports: [8080],
      ancestry: [11002],
      descendants: []
    }
  },
  {
    port: 9000,
    bindings: [['any', '0.0.0.0', 'IPv4']],
    process: {
      pid: 20876,
      name: 'orders-service',
      role: 'dotnet',
      owner: ACCOUNT,
      image: 'C:\\work\\orders-service\\bin\\Debug\\net9.0\\orders-service.exe',
      commandLine: '"C:\\work\\orders-service\\bin\\Debug\\net9.0\\orders-service.exe" --urls http://0.0.0.0:9000',
      project: { root: 'C:\\work\\orders-service', name: 'orders-service', basis: 'inferred from the executable path' },
      workingSetBytes: 184 * 1024 * 1024,
      cpuPercent: 0.2,
      ageMinutes: 41,
      declaredPort: 9000,
      ports: [9000, 9001],
      ancestry: [8124],
      descendants: []
    }
  },
  {
    port: 5432,
    bindings: [['loopback', '127.0.0.1', 'IPv4']],
    process: {
      pid: 4820,
      name: 'postgres',
      role: 'database',
      owner: 'NT AUTHORITY\\NETWORK SERVICE',
      image: 'C:\\Program Files\\PostgreSQL\\17\\bin\\postgres.exe',
      commandLine: '"C:\\Program Files\\PostgreSQL\\17\\bin\\postgres.exe" -D "C:\\ProgramData\\PostgreSQL\\17\\data"',
      project: { root: null, name: null, basis: 'no project marker found' },
      workingSetBytes: 64 * 1024 * 1024,
      cpuPercent: 0.1,
      ageMinutes: 1440,
      declaredPort: null,
      ports: [5432],
      ancestry: [1204],
      descendants: [4836, 4837, 4838],
      protected: true
    }
  },
  {
    port: 6379,
    bindings: [['loopback', '127.0.0.1', 'IPv4']],
    process: {
      pid: 6104,
      name: 'redis-server',
      role: 'database',
      owner: 'NT AUTHORITY\\NETWORK SERVICE',
      image: 'C:\\Program Files\\Redis\\redis-server.exe',
      commandLine: '"C:\\Program Files\\Redis\\redis-server.exe" redis.windows.conf',
      project: { root: null, name: null, basis: 'no project marker found' },
      workingSetBytes: 12 * 1024 * 1024,
      cpuPercent: 0.1,
      ageMinutes: 1440,
      declaredPort: null,
      ports: [6379],
      ancestry: [1204],
      descendants: [],
      protected: true
    }
  },
  {
    port: 11434,
    bindings: [['loopback', '127.0.0.1', 'IPv4']],
    process: {
      pid: 33280,
      name: 'ollama',
      role: 'other',
      owner: ACCOUNT,
      image: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
      commandLine: null,
      project: { root: null, name: null, basis: 'command line unavailable' },
      workingSetBytes: 2_400 * 1024 * 1024,
      cpuPercent: 6.1,
      ageMinutes: 300,
      declaredPort: null,
      ports: [11434],
      ancestry: [1204],
      descendants: []
    }
  },
  {
    port: 80,
    bindings: [['any', '0.0.0.0', 'IPv4']],
    process: {
      pid: 4,
      name: 'System',
      role: 'system',
      owner: null,
      image: null,
      commandLine: null,
      project: { root: null, name: null, basis: 'command line unavailable' },
      workingSetBytes: 3_600_000,
      cpuPercent: 0.1,
      ageMinutes: 2880,
      declaredPort: null,
      ports: [80, 443, 445, 5040],
      ancestry: [],
      descendants: [888, 1244, 1204, 620, 704, 1044]
    }
  }
];

const HISTORY: HistoryEntry[] = [
  { at: Date.now() - 26 * 60_000, port: 5174, pid: 22280, name: 'node', projectName: 'acme-web', reason: 'terminated' },
  { at: Date.now() - 74 * 60_000, port: 3333, pid: 10944, name: 'node', projectName: 'acme-api', reason: 'closed' },
  { at: Date.now() - 3 * 3600_000, port: 7000, pid: 8892, name: 'python', projectName: null, reason: 'vanished' }
];

export const DEMO_SETTINGS: Settings = {
  refreshMs: 3000,
  autoRefresh: true,
  theme: 'dark',
  protect: ['com.docker.backend', 'docker-proxy', 'dockerd', 'mariadb', 'mongod', 'mssql', 'mysqld', 'postgres', 'redis-server', 'sqlagent', 'sqlservr', 'vmcompute', 'wslservice'],
  pins: [5173],
  closeToTray: true,
  launchAtLogin: false
};

export function demoState(theme: 'light' | 'dark' = 'dark'): AppState {
  const now = Date.now();

  const rows: PortRow[] = SPECS.map((spec) => {
    const process = buildProcess(spec.process, now);
    const bindings = spec.bindings.map(([address, raw, family]) => binding(spec.port, address, raw, family));
    const search = [
      String(spec.port),
      ...bindings.flatMap((b) => [b.address, b.rawAddress, b.family]),
      process.name,
      String(process.pid),
      process.owner ?? '',
      process.role,
      process.project.name ?? '',
      process.project.root ?? '',
      process.project.basis,
      process.commandLine ?? ''
    ]
      .join(' ')
      .toLowerCase();

    return {
      key: String(spec.port),
      port: spec.port,
      bindings,
      processes: [process],
      unresolvedPids: [],
      declaredPortMismatch: spec.mismatch === true,
      pinned: spec.pinned === true,
      search
    };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.port - b.port);

  const scan: ScanResult = {
    at: now,
    rows,
    reserved: [
      { start: 24233, end: 24332, administered: false },
      { start: 49806, end: 49905, administered: false },
      { start: 50000, end: 50059, administered: true }
    ],
    stats: {
      listeners: 14,
      processes: 318,
      hidden: 305,
      vanished: 1,
      durationMs: 143,
      degraded: false,
      errors: [],
      cores: 16,
      ownersAvailable: true
    }
  };

  return {
    scan,
    settings: { ...DEMO_SETTINGS, theme },
    theme,
    elevated: false,
    ownersAvailable: true,
    history: HISTORY,
    identities: {
      5173: { port: 5173, state: 'html', url: 'http://127.0.0.1:5173/', status: 200, contentType: 'text/html', server: 'Vite', title: 'Acme Web', html: true, checkedAt: now, error: null },
      3000: { port: 3000, state: 'html', url: 'http://127.0.0.1:3000/', status: 200, contentType: 'text/html; charset=utf-8', server: 'Express', title: 'Acme API', html: true, checkedAt: now, error: null },
      4200: { port: 4200, state: 'html', url: 'http://127.0.0.1:4200/', status: 200, contentType: 'text/html', server: 'Angular CLI', title: 'Admin Portal', html: true, checkedAt: now, error: null },
      9000: { port: 9000, state: 'responds', url: 'http://127.0.0.1:9000/', status: 404, contentType: 'application/json', server: 'Kestrel', title: null, html: false, checkedAt: now, error: null }
    },
    source: 'MSFT_NetTCPConnection + Get-Process via PowerShell 7',
    scanning: false,
    enriching: false,
    version: '0.1.0',
    platform: 'win32',
    logPath: 'C:\\Users\\dev\\AppData\\Roaming\\portgarden\\logs\\portgarden.log',
    logTail: ['[info] Port Garden 0.1.0 started.', '[info] 14 listening port(s); 318 processes, 143 ms, 14 sockets.'],
    probeDir: 'C:\\portgarden\\resources\\probe'
  };
}
