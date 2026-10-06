/**
 * Running the PowerShell probe scripts.
 *
 * The host is resolved once: PowerShell 7 if it is installed, otherwise the
 * in-box Windows PowerShell. Measured start-ups are 255ms and 327ms, so trying 7
 * first is worth it.
 *
 * ## Why there is a long-lived host
 *
 * Measured on the development machine, one fast-tier scan breaks down as:
 *
 *   PowerShell start-up            255 ms
 *   first CIM client + WMI connect ~420 ms
 *   the actual work                ~880 ms
 *
 * The first two are paid on *every spawn*, and they are 43% of the scan. So the
 * fast tier - the one on the refresh loop, the one the user waits for - runs
 * inside a single long-lived `pwsh` that reads commands from stdin and stays warm
 * between scans.
 *
 * The detail tier deliberately does not use it. It costs ~3s of irreducible WMI
 * work and runs out of band, so its start-up is not on anybody's critical path -
 * and a second long-lived process is a second thing that can wedge.
 *
 * ## Why it cannot make the app worse
 *
 * A persistent child process is a real reliability surface, so the host is an
 * accelerator and never a dependency:
 *
 *   - every request has a hard timeout, and a timed-out host is killed and
 *     respawned because its state is unknowable;
 *   - if the host is missing, dead, or slow, the request falls back to a one-shot
 *     `execFile` and the scan still succeeds;
 *   - a request already in flight is rejected rather than left hanging, so the
 *     caller can retry through the safe path.
 *
 * The observable worst case is therefore the old behaviour: one spawn per scan.
 */

import { app } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { logInfo, logWarn } from './logger.js';
import {
  parseExcludedRanges,
  parseGoneList,
  parsePackedBindings,
  parsePackedListenerDetails,
  parsePackedProcesses,
  parseParentMap,
  parseProbeLines,
  type PackedListenerDetail,
  type PackedProcess,
  type ProbeRecord,
  type ReservedRange
} from './parse.js';

const CANDIDATE_HOSTS: ReadonlyArray<{ file: string; label: string }> = [
  { file: 'pwsh.exe', label: 'PowerShell 7' },
  { file: 'powershell.exe', label: 'Windows PowerShell' }
];

/** A line no probe script can emit, because every record they print starts with `{`. */
const END_SENTINEL = '###PORTGARDEN-END###';

/** Generous: the fast tier is ~1.5s cold. Past this the host is treated as wedged. */
const HOST_REQUEST_TIMEOUT_MS = 15_000;

let host: { file: string; label: string } | null = null;

/**
 * `resources/probe` lives beside the app when packaged and inside the project
 * when running from source, so both layouts read from one place.
 */
export function probeDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'probe')
    : path.join(app.getAppPath(), 'resources', 'probe');
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

function runOnce(file: string, args: string[], timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout),
        stderr: String(stderr),
        error: error ? error.message : null
      });
    });
  });
}

/** Finds a working PowerShell once and remembers it. */
async function resolveHost(): Promise<{ file: string; label: string }> {
  if (host) return host;
  for (const candidate of CANDIDATE_HOSTS) {
    const probe = await runOnce(candidate.file, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], 10_000);
    if (probe.ok && /\d/.test(probe.stdout)) {
      host = candidate;
      return candidate;
    }
  }
  throw new Error('No usable PowerShell host was found.');
}

export function powerShellLabel(): string {
  return host?.label ?? 'PowerShell';
}

/* --------------------------------------------------------------- warm host */

interface Pending {
  lines: string[];
  resolve(lines: string[]): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class PowerShellHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending: Pending | null = null;
  private starting: Promise<void> | null = null;

  private async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    const resolved = await resolveHost();
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(
        resolved.file,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.consume(chunk));
      child.stderr.on('data', (chunk: string) => {
        const text = String(chunk).trim();
        if (text !== '') logWarn(`probe host stderr: ${text}`);
      });
      child.on('error', (error: Error) => {
        this.failPending(new Error(`probe host failed to start: ${error.message}`));
        this.child = null;
        reject(error);
      });
      child.on('exit', (code) => {
        // An exit while a request is in flight is the case the fallback exists
        // for: reject it so the caller retries through the one-shot path.
        this.failPending(new Error(`probe host exited with code ${code}`));
        this.child = null;
        this.buffer = '';
      });
      child.stdin.on('error', () => this.failPending(new Error('probe host stdin closed')));
      this.child = child;
      // The host emits UTF-8 explicitly. Without this a process name or an owner
      // containing a non-ASCII character comes back mojibake on a machine whose
      // console code page is not UTF-8.
      this.child.stdin.write("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n");
      resolve();
    });
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    const pending = this.pending;
    if (line === END_SENTINEL) {
      if (!pending) {
        // A late reply from a request that already timed out. Its host was
        // killed, so this is a stray rather than a signal.
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(pending.lines);
      return;
    }
    if (line === '') return;
    if (pending) pending.lines.push(line);
  }

  /** Runs one probe script, or throws so the caller can fall back. */
  async run(script: string, args: string[]): Promise<string[]> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error('probe host is not running');
    if (this.pending) throw new Error('probe host is busy');

    const full = path.join(probeDir(), script);
    // Single quotes around the path, doubled if one ever appears in it.
    const quoted = `'${full.replace(/'/g, "''")}'`;
    const suffix = args.length > 0 ? ` ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(' ')}` : '';

    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === null) return;
        this.pending = null;
        // The host's state is unknowable after a timeout, so it is discarded
        // rather than reused. The next request starts a fresh one.
        this.kill();
        reject(new Error(`${script} timed out after ${HOST_REQUEST_TIMEOUT_MS} ms`));
      }, HOST_REQUEST_TIMEOUT_MS);

      this.pending = { lines: [], resolve, reject, timer };
      child.stdin.write(`& ${quoted}${suffix}\nWrite-Output '${END_SENTINEL}'\n`, (error) => {
        if (error) {
          this.failPending(new Error(`probe host write failed: ${error.message}`));
          this.kill();
        }
      });
    });
  }

  kill(): void {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // Already gone.
    }
  }

  alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }
}

const fastHost = new PowerShellHost();

export function disposeProbeHost(): void {
  if (fastHost.alive()) logInfo('Closing the warm probe host.');
  fastHost.kill();
}

/* --------------------------------------------------------------- execution */

async function runScript(script: string, args: string[], timeout: number): Promise<ProbeRecord[]> {
  const resolved = await resolveHost();
  const result = await runOnce(
    resolved.file,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(probeDir(), script), ...args],
    timeout
  );
  if (!result.ok && result.stdout.trim() === '') {
    logWarn(`${script} failed: ${result.stderr.trim() || result.error || 'no output'}`);
  }
  return parseProbeLines(result.stdout);
}

/**
 * The warm path for the fast tier, falling back to a one-shot spawn.
 *
 * The fallback is not defensive decoration: it is the whole reason the warm host
 * is safe to have. Every failure mode - missing host, dead host, busy host,
 * timeout - lands here, and here is exactly the behaviour the app had before the
 * host existed.
 */
async function runFastScript(): Promise<ProbeRecord[]> {
  try {
    const lines = await fastHost.run('fast.ps1', []);
    return parseProbeLines(lines.join('\n'));
  } catch (error) {
    logWarn(`Warm probe host unavailable (${(error as Error).message}); falling back to a one-shot spawn.`);
    return runScript('fast.ps1', [], 30_000);
  }
}

/* ------------------------------------------------------------------ probes */

export interface RawBinding {
  address: string;
  port: number;
  pid: number;
}

export interface RawProcess {
  pid: number;
  name: string;
  owner: string | null;
  image: string | null;
  createdAt: string | null;
  workingSetBytes: number;
  cpuTicks: number;
  sessionId: number;
}

export interface FastProbe {
  bindings: RawBinding[];
  /**
   * Full data for the pids that hold a listening port, and only those. Every
   * other process contributes to `processCount` and nothing else, so shipping
   * its name, working set and CPU counters across the process boundary was
   * payload for data no row displays: the packed payload went from ~100KB to
   * 22KB and the probe from ~2.5s to ~1.5s.
   */
  processes: Map<number, RawProcess>;
  /** Every process on the machine, including ones holding no port. */
  processCount: number;
  excludedRanges: ReservedRange[];
  cores: number;
  ownersAvailable: boolean;
  errors: string[];
}

function toRawProcess(packed: PackedProcess): RawProcess {
  return {
    pid: packed.pid,
    name: packed.name,
    owner: packed.owner,
    image: packed.image,
    createdAt: packed.createdAt,
    workingSetBytes: packed.workingSetBytes,
    cpuTicks: packed.cpuTicks,
    sessionId: packed.sessionId
  };
}

export async function runFastProbe(): Promise<FastProbe> {
  const records = await runFastScript();
  const bindings: RawBinding[] = [];
  const processes = new Map<number, RawProcess>();
  const errors: string[] = [];
  let cores = 1;
  let processCount = 0;
  let ownersChecked = 0;
  let excludedRanges: ReservedRange[] = [];

  for (const record of records) {
    switch (record.k) {
      case 'pr': {
        for (const packed of parsePackedProcesses(record.v)) {
          processes.set(packed.pid, toRawProcess(packed));
          if (packed.owner === null) ownersChecked += 1;
        }
        break;
      }
      case 'tb':
        for (const packed of parsePackedBindings(record.v)) {
          bindings.push({ address: packed.address, port: packed.port, pid: packed.pid });
        }
        break;
      case 'r':
        // Parsed through the tested helper rather than duplicated here, so the
        // rule that has to survive a non-English Windows lives in one place.
        excludedRanges = parseExcludedRanges(record.excluded);
        break;
      case 'm':
        cores = record.cores > 0 ? record.cores : 1;
        processCount = record.procs;
        break;
      case 'e':
        errors.push(`${record.stage}: ${record.message}`);
        break;
      default:
        break;
    }
  }

  // Every listener pid unreadable means `-IncludeUserName` was unavailable in
  // this context. The UI says so rather than rendering blanks that look like a
  // bug.
  const ownersAvailable = processes.size === 0 || ownersChecked < processes.size;

  if (bindings.length === 0 && errors.length === 0) {
    errors.push('The probe returned no listening sockets, which usually means it failed silently.');
  }

  return { bindings, processes, processCount, excludedRanges, cores, ownersAvailable, errors };
}

export interface DetailEntry {
  pid: number;
  commandLine: string | null;
  image: string | null;
  createdAt: string | null;
}

export interface DetailProbe {
  entries: Map<number, DetailEntry>;
  /** pid -> parent pid for the whole machine. */
  parents: Map<number, number | null>;
  /** Listener pids the OS would not return at all. */
  gone: number[];
  errors: string[];
}

function toDetailEntry(packed: PackedListenerDetail): DetailEntry {
  return {
    pid: packed.pid,
    commandLine: packed.commandLine,
    image: packed.image,
    createdAt: packed.createdAt
  };
}

/**
 * Parent pids for the whole machine, plus command lines and image paths for the
 * pids that actually hold a listening port.
 *
 * The Win32_Process table is read unfiltered, and that is a measured decision. A
 * `ProcessId = 1 OR ProcessId = 2 OR ...` filter fails with "Quota violation" on
 * a machine with a few thousand processes, because WQL caps the clauses in a
 * disjunction. Filtering does not save time either: a 74-clause filter measured
 * 2871ms against 3031ms unfiltered. The cost is provider start-up, not rows.
 *
 * Measured at ~3.2s, of which ~2.8s is the irreducible WMI read. That is why
 * this never runs inside the refresh loop - see snapshot.ts.
 */
export async function runDetailProbe(detailPids: readonly number[]): Promise<DetailProbe> {
  const empty: DetailProbe = { entries: new Map(), parents: new Map(), gone: [], errors: [] };
  if (detailPids.length === 0) return empty;
  const records = await runScript('detail.ps1', ['-DetailPid', detailPids.join(',')], 45_000);
  const entries = new Map<number, DetailEntry>();
  const parents = new Map<number, number | null>();
  const gone: number[] = [];
  const errors: string[] = [];

  for (const record of records) {
    switch (record.k) {
      case 'dd':
        for (const packed of parsePackedListenerDetails(record.v)) entries.set(packed.pid, toDetailEntry(packed));
        break;
      case 'pm':
        for (const [pid, parent] of parseParentMap(record.v)) parents.set(pid, parent);
        break;
      case 'gg':
        gone.push(...parseGoneList(record.v));
        break;
      case 'e':
        errors.push(`${record.stage}: ${record.message}`);
        break;
      default:
        break;
    }
  }

  return { entries, parents, gone, errors };
}

export interface LiveIdentity {
  found: boolean;
  pid: number;
  name: string;
  owner: string | null;
  createdAt: string | null;
  image: string | null;
}

/** Reads back one process's live identity, for the pre-kill check. */
export async function readLiveIdentity(pid: number): Promise<LiveIdentity> {
  const records = await runScript('identity.ps1', ['-ProcessId', String(pid)], 20_000);
  for (const record of records) {
    if (record.k === 'i') {
      return {
        found: true,
        pid: record.pid,
        name: record.name.toLowerCase(),
        owner: record.own,
        createdAt: record.st,
        image: record.image
      };
    }
    if (record.k === 'missing') break;
  }
  return { found: false, pid, name: '', owner: null, createdAt: null, image: null };
}
