/**
 * The contracts shared by the main process and the renderer.
 *
 * Every shape here is deliberately honest about missing data rather than
 * carrying placeholder values. A Windows process whose command line cannot be
 * read (System, wininit, services.exe - protected even for an administrator)
 * reports `commandLine: null`, and the UI says so. `ProjectConfidence` exists
 * for the same reason: Windows exposes no working directory for another
 * process without low-level PEB access, so a resolved project is labelled with
 * how it was resolved, and the UI shows that label.
 */

/**
 * How a project's root directory was arrived at.
 *
 * Only two states exist because only two are reachable today. An `exact`
 * variant would require reading another process's PEB, which is a deliberate
 * deferral rather than an oversight; widening this union is a one-line change
 * when that lands.
 */
export type ProjectConfidence = 'inferred' | 'unknown';

/** A plain-language description of what a process is, from its image + argv. */
export type ProcessRole =
  | 'dev-server'
  | 'node'
  | 'python'
  | 'dotnet'
  | 'java'
  | 'docker-forward'
  | 'database'
  | 'browser'
  | 'system'
  | 'service'
  | 'other';

/** Which mechanism was attempted. Windows has no SIGTERM; see control.ts. */
export type KillMethod = 'close' | 'terminate';

export type KillFailureCode =
  | 'gone'
  | 'identity'
  | 'protected'
  | 'requires-elevation'
  | 'cancelled'
  | 'taskkill';

export interface KillOutcome {
  ok: boolean;
  pid: number;
  method: KillMethod;
  /** Whether child processes were included in the scope of the operation. */
  tree: boolean;
  /** Present on failure: a stable code the renderer maps to tone and next step. */
  code: KillFailureCode | null;
  message: string | null;
}

/** What a native confirmation dialog was asked to offer. */
export type ConfirmChoice = 'close' | 'terminate' | 'unprotect-and-terminate' | null;

/** Everything the confirmation dialog needs to describe one target honestly. */
export interface ConfirmTarget {
  pid: number;
  port: number;
  name: string;
  owner: string | null;
  commandLine: string | null;
  /** Child pids known from the last detail read; Windows re-walks at kill time. */
  descendants: number[];
  projectName: string | null;
  protected: boolean;
}

export interface ConfirmKillRequest {
  targets: ConfirmTarget[];
  method: KillMethod;
}

/**
 * A request to end one process.
 *
 * `identity` is what the row displayed, and it is re-verified in the main
 * process before anything is signalled. The renderer is not trusted to have got
 * it right; it is trusted only to have said what the user clicked on.
 */
export interface KillRequest {
  pid: number;
  identity: ProcessIdentity;
  method: KillMethod;
  /** Set only after the user has explicitly unprotected the process. */
  allowProtected: boolean;
}

export interface ProjectInfo {
  /** Absolute root directory, or null when nothing was found. */
  root: string | null;
  /** Display label: package.json name when readable, else the directory name. */
  name: string | null;
  confidence: ProjectConfidence;
  /** One short clause naming the evidence, shown beside the confidence badge. */
  basis: string;
}

/**
 * The tuple that makes a kill safe.
 *
 * A pid alone is not identity: Windows recycles pids, so a click on a stale row
 * could otherwise land on an unrelated process. All three parts are re-verified
 * in the main process immediately before any signal is sent.
 */
export interface ProcessIdentity {
  pid: number;
  /** ISO-8601 UTC instant the process was created, or null if unreadable. */
  createdAt: string | null;
  /** Absolute image path, or null if the OS refused to disclose it. */
  image: string | null;
}

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  owner: string | null;
  /** Image name without extension, lowercased for stable matching. */
  name: string;
  image: string | null;
  commandLine: string | null;
  createdAt: string | null;
  workingSetBytes: number;
  /** Whole-machine percentage across all logical cores, or null if unknown. */
  cpuPercent: number | null;
  sessionId: number | null;
  role: ProcessRole;
  project: ProjectInfo;
  /** The port this process asked for on its own command line, if it asked. */
  declaredPort: number | null;
  /** Every listening port this process holds, ascending. */
  ports: number[];
  /** True when the image name is in the protect list. */
  protected: boolean;
  identity: ProcessIdentity;
  /** Ancestor pids, nearest parent first. */
  ancestry: number[];
  /** Descendant pids, from the same coherent snapshot. */
  descendants: number[];
}

export interface PortBinding {
  port: number;
  /** Bind address reduced to a comparable form: 0.0.0.0 / :: / loopback / host. */
  address: string;
  /** Exactly what Windows reported, kept for the detail panel. */
  rawAddress: string;
  family: 'IPv4' | 'IPv6';
  /** True when the bind covers every interface. */
  wildcard: boolean;
}

/**
 * One listening port.
 *
 * A port is the row, not a socket: a dual-stack listener is one row carrying
 * both bindings, and a port shared by two processes on v4 and v6 carries both
 * owners rather than pretending it has one.
 */
export interface PortRow {
  key: string;
  port: number;
  bindings: PortBinding[];
  processes: ProcessInfo[];
  /** pids Windows reported that had no readable process entry. */
  unresolvedPids: number[];
  /**
   * Precomputed search text for this row: port, addresses, pids, process names,
   * owners, roles, project names and roots, every port each owner holds, the
   * declared port, and the full command line - lowercased.
   *
   * Built here rather than in the renderer because the renderer filters on every
   * keystroke, and reassembling a few hundred strings per keystroke is exactly
   * the kind of work that makes a filter feel sticky.
   */
  search: string;
  /**
   * True when an owner's command line declares a port that is not the one
   * actually bound - the shape of "I asked for 4000 and got 3000", which is
   * among the most confusing failures on a busy dev machine.
   */
  declaredPortMismatch: boolean;
  pinned: boolean;
}

export interface ReservedRange {
  start: number;
  end: number;
  /** True when netsh marked the range as an administered exclusion. */
  administered: boolean;
}

export interface ScanStats {
  listeners: number;
  processes: number;
  /** Processes excluded from the table because they hold no listening port. */
  hidden: number;
  /** Processes that disappeared between the fast and detail tiers. */
  vanished: number;
  durationMs: number;
  /** True when a tier failed and this scan is degraded but still usable. */
  degraded: boolean;
  errors: string[];
  cores: number;
  /**
   * False when `Get-Process -IncludeUserName` was unavailable, so owner names
   * could not be read at all. The UI says so rather than showing blanks.
   */
  ownersAvailable: boolean;
}

export interface ScanResult {
  at: number;
  rows: PortRow[];
  reserved: ReservedRange[];
  stats: ScanStats;
}

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Settings {
  refreshMs: number;
  autoRefresh: boolean;
  theme: ThemePreference;
  /** Image names (lower case, no extension) that must never be terminated. */
  protect: string[];
  /** Ports the user pinned to the top of the table. */
  pins: number[];
  closeToTray: boolean;
  launchAtLogin: boolean;
}

export type HistoryReason = 'closed' | 'terminated' | 'vanished';

/**
 * What is actually being served on a port.
 *
 * A port and a pid answer "what is holding this". They do not answer "what is
 * this" - and on a machine running several dev servers that is the question the
 * user actually has. `state` distinguishes the three honest outcomes: something
 * that serves HTML, something that answers but is not HTML, and nothing that
 * speaks HTTP at all (a database, or a protocol that is not HTTP).
 */
export interface HttpIdentity {
  port: number;
  state: 'checking' | 'html' | 'responds' | 'none';
  /** The address that answered, or null when nothing did. */
  url: string | null;
  status: number | null;
  contentType: string | null;
  /** `Server` header, `X-Powered-By`, generator meta, or the page title. */
  server: string | null;
  title: string | null;
  html: boolean;
  checkedAt: number;
  /** The socket-level reason when nothing answered. */
  error: string | null;
}

/**
 * The preload bridge.
 *
 * It lives in shared rather than beside the renderer because both sides need it:
 * the preload builds the object, the renderer consumes it, and `types.ts` in the
 * renderer is only a re-export. Defining it twice would let the two drift, and
 * the failure mode of a drifted bridge is a runtime `undefined` on a method
 * nothing type-checks.
 */
export interface GardenApi {
  getState(): Promise<AppState>;
  rescan(): Promise<AppState>;
  setSettings(patch: Partial<Settings>): Promise<AppState>;
  setTheme(theme: ThemePreference): Promise<AppState>;
  togglePin(port: number): Promise<Settings>;
  toggleProtect(name: string): Promise<Settings>;
  confirmKill(request: ConfirmKillRequest): Promise<ConfirmChoice>;
  kill(request: KillRequest): Promise<KillOutcome>;
  copy(text: string): Promise<void>;
  reveal(path: string): Promise<boolean>;
  identify(request: { port: number; address: string; ownerKey: string; force?: boolean }): Promise<HttpIdentity | null>;
  capture(url: string): Promise<string | null>;
  openUrl(url: string): Promise<boolean>;
  relaunchElevated(): Promise<{ ok: boolean; message: string }>;
  clearHistory(): Promise<HistoryEntry[]>;
  onState(listener: (payload: AppState) => void): () => void;
}

export interface HistoryEntry {
  at: number;
  port: number;
  pid: number;
  name: string;
  projectName: string | null;
  reason: HistoryReason;
}

export interface AppState {
  /** Null until the first scan completes; the renderer shows a loading state. */
  scan: ScanResult | null;
  settings: Settings;
  /**
   * The theme actually in effect after `settings.theme` has been resolved against
   * the OS. The renderer never reads `prefers-color-scheme` itself; the main
   * process owns `nativeTheme` and is therefore the only place that knows.
   */
  theme: 'light' | 'dark';
  /** Whether this process holds an administrator token. */
  elevated: boolean;
  /** Whether owner names were obtainable at all (needs -IncludeUserName). */
  ownersAvailable: boolean;
  history: HistoryEntry[];
  /** Human-readable description of how the data was gathered. */
  source: string;
  /**
   * What each identified port is serving, keyed by port. Thumbnails are
   * deliberately absent: a 1280x800 PNG is a few hundred kilobytes, and pushing
   * one on every state push would undo the work of keeping this payload small.
   * The image is fetched separately, by the caller that wants it.
   */
  identities: Record<number, HttpIdentity>;
  /** True while a scan is in flight; the table stays on its last good data. */
  scanning: boolean;
  /**
   * True while the slow tier is resolving command lines and the parent map. The
   * table is already current when this is set; it just does not know everything
   * yet, and the status pill says so rather than pretending the scan is idle.
   */
  enriching: boolean;
  version: string;
  platform: string;
  /** Absolute path of the bounded activity log, for the diagnostics panel. */
  logPath: string;
  logTail: string[];
  probeDir: string;
}