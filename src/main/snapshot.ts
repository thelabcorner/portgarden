/**
 * Turning raw probes into the table the user actually reads.
 *
 * Two rules shape the output:
 *
 * - One row per port. A dual-stack listener reports both `0.0.0.0` and `::`;
 *   that is one port with two bindings, not two rows. A port genuinely shared
 *   by two pids lists both owners rather than hiding one.
 * - Absence is reported, never implied. A process that exited between the tiers
 *   is counted, and a port that lost its owner is written to history, so the
 *   table shrinking is always explained.
 *
 * The two probe tiers run *separately*, and that is forced by measurement rather
 * than chosen for tidiness:
 *
 *   fast tier    ~2.5s   the whole process table plus every listening socket
 *   detail tier  ~3.2s   command lines, image paths, and the machine-wide
 *                          parent map - of which ~2.8s is an irreducible WMI
 *                          provider start-up
 *
 * Awaiting both inside a refresh would put a five-and-a-half second stall in
 * front of a table that refreshes every couple of seconds. So `runFastScan`
 * returns as soon as the ports and processes are known, and `refreshDetail`
 * enriches the same rows afterwards and publishes them again. The table is
 * never blocked waiting for a command line.
 */

import { runDetailProbe, runFastProbe, type DetailProbe, type FastProbe, type RawProcess } from './probe.js';
import { normalizeAddress, percentCpu } from './parse.js';
import { buildAncestry, buildDescendants, type ParentMap } from './group.js';
import { classifyRole, nodeProjectIo, ProjectResolver, resolveDeclaredPort } from './project.js';
import { logInfo } from './logger.js';
import type { HistoryEntry, PortBinding, PortRow, ProcessInfo, ScanResult, Settings } from '../shared/types.js';

const HISTORY_CAPACITY = 200;

/**
 * How stale the detail tier may get before it is refreshed anyway. The tier also
 * refreshes whenever the set of listening pids changes, which is the case that
 * actually matters: a newly started dev server should have its command line
 * promptly, not thirty seconds later.
 */
const DETAIL_INTERVAL_MS = 30_000;
let lastDetailAt = 0;

interface CpuSample {
  ticks: number;
  at: number;
}

/** Command line and image, keyed by pid. Stable for the life of a process. */
const listenerDetail = new Map<number, { commandLine: string | null; image: string | null; createdAt: string | null }>();
const cpuSamples = new Map<number, CpuSample>();
const resolver = new ProjectResolver();

let history: HistoryEntry[] = [];
let previousOwners = new Map<number, Set<number>>();
let coveredListeners = '';
let lastFast: FastProbe | null = null;
let lastFastDurationMs = 0;
let lastFastStartedAt = 0;
let parentMap: ParentMap = new Map();
let lastCpu: Map<number, number | null> = new Map();
let detailInFlight = false;

export function noteKill(entry: HistoryEntry): void {
  history.push(entry);
  if (history.length > HISTORY_CAPACITY) history = history.slice(history.length - HISTORY_CAPACITY);
}

export function clearHistory(): void {
  history = [];
}

export function getHistory(): HistoryEntry[] {
  return history;
}

/** True when the detail tier is stale, and whether an in-flight run must be skipped. */
export function detailIsStale(now = Date.now()): boolean {
  if (detailInFlight) return false;
  if (!lastFast) return true;
  if (listenerSignature(lastFast) !== coveredListeners) return true;
  return now - lastDetailAt >= DETAIL_INTERVAL_MS;
}

/** True while the slow tier is running, so the status pill can say so. */
export function detailIsInFlight(): boolean {
  return detailInFlight;
}

function listenerSignature(detail: FastProbe): string {
  return [...listenerPids(detail)].sort((a, b) => a - b).join(',');
}

function listenerPids(detail: FastProbe): Set<number> {
  const pids = new Set<number>();
  for (const binding of detail.bindings) pids.add(binding.pid);
  return pids;
}

function mergeDetail(probe: DetailProbe, fast: FastProbe): void {
  for (const pid of [...listenerDetail.keys()]) {
    if (!fast.processes.has(pid)) listenerDetail.delete(pid);
  }
  for (const [pid, entry] of probe.entries) {
    const known = listenerDetail.get(pid);
    // A null from the detail tier means "the OS withheld it"; it must not
    // overwrite a value already in hand.
    listenerDetail.set(pid, {
      commandLine: entry.commandLine ?? known?.commandLine ?? null,
      image: entry.image ?? known?.image ?? null,
      createdAt: entry.createdAt ?? known?.createdAt ?? null
    });
  }
  if (probe.parents.size > 0) parentMap = probe.parents;
}

function sampleCpu(detail: FastProbe, now: number): Map<number, number | null> {
  const result = new Map<number, number | null>();
  for (const [pid, raw] of detail.processes) {
    const previous = cpuSamples.get(pid);
    result.set(pid, previous ? percentCpu(previous.ticks, previous.at, raw.cpuTicks, now, detail.cores) : null);
    cpuSamples.set(pid, { ticks: raw.cpuTicks, at: now });
  }
  for (const pid of [...cpuSamples.keys()]) if (!detail.processes.has(pid)) cpuSamples.delete(pid);
  return result;
}

function buildProcess(
  raw: RawProcess,
  ports: number[],
  cpuPercent: number | null,
  parents: ParentMap,
  settings: Settings,
  now: number
): ProcessInfo {
  const detail = listenerDetail.get(raw.pid);
  const commandLine = detail?.commandLine ?? null;
  // The fast tier already supplies the image and creation time for listeners,
  // which is what keeps the identity tuple anchored from the very first scan.
  const image = detail?.image ?? raw.image;
  const createdAt = detail?.createdAt ?? raw.createdAt;
  return {
    pid: raw.pid,
    ppid: parents.get(raw.pid) ?? null,
    owner: raw.owner,
    name: raw.name,
    image,
    commandLine,
    createdAt,
    workingSetBytes: raw.workingSetBytes,
    cpuPercent,
    sessionId: raw.sessionId,
    role: classifyRole(raw.name, commandLine),
    project: resolver.resolve({ commandLine, image, io: nodeProjectIo }, now),
    declaredPort: resolveDeclaredPort(commandLine),
    ports,
    protected: settings.protect.includes(raw.name),
    identity: { pid: raw.pid, createdAt, image },
    ancestry: buildAncestry(parents, raw.pid),
    descendants: buildDescendants(parents, raw.pid)
  };
}

function bindingFor(raw: { address: string; port: number }): PortBinding {
  const normalized = normalizeAddress(raw.address);
  return { port: raw.port, address: normalized.address, rawAddress: raw.address, family: normalized.family, wildcard: normalized.wildcard };
}

/**
 * Everything a user might plausibly type, lowercased, for the filter box.
 *
 * Computed once here rather than in the renderer: the renderer filters on every
 * keystroke, and rebuilding a few hundred strings per keystroke is what makes a
 * filter feel sticky on a machine with 130 open ports.
 */
function buildSearch(row: {
  port: number;
  bindings: PortBinding[];
  processes: ProcessInfo[];
  unresolvedPids: number[];
}): string {
  const parts: string[] = [String(row.port)];
  for (const binding of row.bindings) parts.push(binding.address, binding.rawAddress, binding.family);
  for (const process of row.processes) {
    parts.push(process.name, String(process.pid), process.owner ?? '', process.role, process.project.name ?? '', process.project.root ?? '', process.project.basis);
    if (process.commandLine !== null) parts.push(process.commandLine);
    for (const port of process.ports) parts.push(String(port));
    if (process.declaredPort !== null) parts.push(String(process.declaredPort));
    for (const ancestor of process.ancestry) parts.push(String(ancestor));
  }
  for (const pid of row.unresolvedPids) parts.push(String(pid));
  return parts.join(' ').toLowerCase();
}

/** Pure assembly: raw probe data plus caches in, one scan out. */
function assemble(
  detail: FastProbe,
  cpu: Map<number, number | null>,
  settings: Settings,
  now: number,
  startedAt: number,
  durationMs: number
): ScanResult {
  const portsByPid = new Map<number, number[]>();
  const listenersByPort = new Map<number, { binding: PortBinding; pid: number }[]>();
  const ownerSet = new Map<number, Set<number>>();
  const pids = new Set<number>();

  for (const raw of detail.bindings) {
    if (raw.port <= 0) continue;
    pids.add(raw.pid);

    const ports = portsByPid.get(raw.pid);
    if (ports) ports.push(raw.port);
    else portsByPid.set(raw.pid, [raw.port]);

    const bucket = listenersByPort.get(raw.port);
    if (bucket) bucket.push({ binding: bindingFor(raw), pid: raw.pid });
    else listenersByPort.set(raw.port, [{ binding: bindingFor(raw), pid: raw.pid }]);

    const owners = ownerSet.get(raw.port);
    if (owners) owners.add(raw.pid);
    else ownerSet.set(raw.port, new Set([raw.pid]));
  }
  for (const ports of portsByPid.values()) ports.sort((a, b) => a - b);

  const processes = new Map<number, ProcessInfo>();
  for (const pid of pids) {
    const raw = detail.processes.get(pid);
    if (!raw) continue;
    processes.set(pid, buildProcess(raw, portsByPid.get(pid) ?? [], cpu.get(pid) ?? null, parentMap, settings, now));
  }

  const pins = new Set(settings.pins);
  const rows: PortRow[] = [];
  for (const [port, listeners] of listenersByPort) {
    // A dual-stack listener binds `0.0.0.0` and `::`. Both describe one port, so
    // they collapse into one row with two bindings rather than two rows.
    const seen = new Set<string>();
    const bindings = listeners
      .map((entry) => entry.binding)
      .filter((binding) => {
        const key = `${binding.address}|${binding.family}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.wildcard) - Number(a.wildcard) || a.family.localeCompare(b.family) || a.address.localeCompare(b.address));

    const owners = new Set(listeners.map((entry) => entry.pid));
    const rowProcesses = [...owners]
      .map((pid) => processes.get(pid))
      .filter((entry): entry is ProcessInfo => entry !== undefined)
      .sort((a, b) => a.pid - b.pid);

    const unresolvedPids = [...owners].filter((pid) => !processes.has(pid)).sort((a, b) => a - b);

    const row: PortRow = {
      key: String(port),
      port,
      bindings,
      processes: rowProcesses,
      unresolvedPids,
      search: '',
      // A mismatch means the process asked for one port and got another, which
      // is the single most confusing thing that can happen to a dev server.
      declaredPortMismatch: rowProcesses.some((entry) => entry.declaredPort !== null && entry.declaredPort !== port),
      pinned: pins.has(port)
    };
    row.search = buildSearch(row);
    rows.push(row);
  }

  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.port - b.port);

  // Anything that was listening last scan and is not now is accounted for.
  let vanished = 0;
  for (const [port, previous] of previousOwners) {
    const current = ownerSet.get(port);
    for (const pid of previous) {
      if (current?.has(pid)) continue;
      vanished += 1;
      noteKill({
        at: now,
        port,
        pid,
        name: detail.processes.get(pid)?.name ?? 'gone',
        projectName: null,
        reason: 'vanished'
      });
    }
  }
  previousOwners = ownerSet;

  return {
    at: startedAt,
    rows,
    reserved: detail.excludedRanges,
    stats: {
      listeners: detail.bindings.length,
      processes: detail.processCount,
      hidden: Math.max(0, detail.processCount - processes.size),
      vanished,
      // The probe's own duration, not this assembly's. The enrichment pass
      // rebuilds rows from data already gathered, so timing it would report a
      // few milliseconds and claim the scan was instant.
      durationMs,
      degraded: detail.errors.length > 0,
      errors: detail.errors,
      cores: detail.cores,
      ownersAvailable: detail.ownersAvailable
    }
  };
}

/**
 * The fast half of a scan. Returns as soon as the ports and processes are known;
 * command lines and the parent map arrive later via `refreshDetail`.
 */
export async function runFastScan(settings: Settings, now = Date.now()): Promise<ScanResult> {
  const startedAt = Date.now();
  const detail = await runFastProbe();
  const durationMs = Date.now() - startedAt;
  lastFast = detail;
  lastFastDurationMs = durationMs;
  lastFastStartedAt = startedAt;
  lastCpu = sampleCpu(detail, Date.now());
  return assemble(detail, lastCpu, settings, now, startedAt, durationMs);
}

/**
 * The slow half. Enriches the cached rows and returns a fresh scan built from the
 * same fast data, so the caller can publish enrichment without re-reading the
 * whole process table.
 */
export async function refreshDetail(settings: Settings, now = Date.now()): Promise<ScanResult | null> {
  const fast = lastFast;
  if (!fast) return null;
  detailInFlight = true;
  try {
    const probe = await runDetailProbe([...listenerPids(fast)]);
    mergeDetail(probe, fast);
    lastDetailAt = Date.now();
    coveredListeners = listenerSignature(fast);
    if (probe.gone.length > 0) {
      logInfo(`Detail tier could not read ${probe.gone.length} listener process(es); they exited or are unreadable.`);
    }
    const errors = [...fast.errors, ...probe.errors];
    const enriched = assemble({ ...fast, errors }, lastCpu, settings, now, lastFastStartedAt, lastFastDurationMs);
    return probe.errors.length > 0 ? { ...enriched, stats: { ...enriched.stats, errors } } : enriched;
  } finally {
    detailInFlight = false;
  }
}

/** Test seam: clears the derived caches between cases. */
export function resetSnapshotState(): void {
  cpuSamples.clear();
  listenerDetail.clear();
  history = [];
  previousOwners = new Map();
  coveredListeners = '';
  lastFast = null;
  lastFastDurationMs = 0;
  lastFastStartedAt = 0;
  parentMap = new Map();
  lastCpu = new Map();
  detailInFlight = false;
  lastDetailAt = 0;
}