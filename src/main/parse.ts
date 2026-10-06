/**
 * Pure parsing of every external string Port Garden consumes.
 *
 * Two of these have to survive a Windows install that is not English, which is
 * why they exist as tested functions rather than as parsing buried inside a
 * probe script:
 *
 * - `parseExcludedRanges` reads `netsh` output whose headers are localized but
 *   whose port numbers are not, so it matches digits positionally and never
 *   looks for a translated column name.
 * - `normalizeAddress` reduces the several shapes Windows reports for a
 *   wildcard or loopback bind so one listener produces one row rather than
 *   three.
 *
 * `isElevatedFromWhoami` parses `whoami /groups`, where only the well-known
 * High Mandatory Level SID is meaningful; the label next to it is localized.
 */

/**
 * Field and record separators for the packed probe payloads.
 *
 * A PowerShell pipeline per record costs about 0.3ms, so serialising one JSON
 * object per process was 1180 calls and roughly 2.4 seconds. The probe scripts
 * pack their bulk data into single strings instead, and these two control
 * characters delimit them.
 *
 * Neither byte can occur in a Windows filename, image path, owner name or IPv6
 * literal, which is the whole reason they were chosen over a printable
 * separator.
 */
export const FIELD_SEPARATOR = '\u001f';
export const RECORD_SEPARATOR = '\u001e';

/** One JSONL record from a probe script. */
export type ProbeRecord =
  | { k: 'pr'; v: string }
  | { k: 'tb'; v: string }
  | { k: 'pm'; v: string }
  | { k: 'dd'; v: string }
  | { k: 'gg'; v: string }
  | { k: 'i'; pid: number; name: string; own: string | null; st: string | null; image: string | null }
  | { k: 'missing'; pid: number }
  | { k: 'r'; excluded: string }
  | { k: 'm'; listeners: number; procs: number; cores: number }
  | { k: 'e'; stage: string; message: string };

export function parseProbeLines(text: string): ProbeRecord[] {
  const records: ProbeRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asProbeRecord(value);
    if (record) records.push(record);
  }
  return records;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asProbeRecord(value: unknown): ProbeRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  switch (raw['k']) {
    case 'pr':
    case 'tb':
    case 'pm':
    case 'dd':
    case 'gg':
      return { k: raw['k'], v: String(raw['v'] ?? '') };
    case 'i':
      return { k: 'i', pid: num(raw['pid']), name: String(raw['name'] ?? ''), own: str(raw['own']), st: str(raw['st']), image: str(raw['image']) };
    case 'missing':
      return { k: 'missing', pid: num(raw['pid']) };
    case 'r':
      return { k: 'r', excluded: String(raw['excluded'] ?? '') };
    case 'm':
      return { k: 'm', listeners: num(raw['listeners']), procs: num(raw['procs']), cores: num(raw['cores']) };
    case 'e':
      return { k: 'e', stage: String(raw['stage'] ?? ''), message: String(raw['message'] ?? '') };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------- packed */

/** Splits a packed payload into records, dropping the empty one an empty join leaves. */
function splitRecords(value: string): string[] {
  if (value === '') return [];
  return value.split(RECORD_SEPARATOR);
}

function fields(record: string): string[] {
  return record.split(FIELD_SEPARATOR);
}

/** An empty field means the OS withheld the value, not that it is an empty string. */
function optional(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function toInt(value: string | undefined): number {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface PackedProcess {
  pid: number;
  name: string;
  owner: string | null;
  image: string | null;
  createdAt: string | null;
  workingSetBytes: number;
  cpuTicks: number;
  sessionId: number;
}

/**
 * pid, name, owner, image, start, workingSet, cpuTicks, sessionId - in that
 * order, for every running process.
 */
export function parsePackedProcesses(value: string): PackedProcess[] {
  const result: PackedProcess[] = [];
  for (const record of splitRecords(value)) {
    const parts = fields(record);
    result.push({
      pid: toInt(parts[0]),
      name: (parts[1] ?? '').toLowerCase(),
      owner: optional(parts[2]),
      image: optional(parts[3]),
      createdAt: optional(parts[4]),
      workingSetBytes: toInt(parts[5]),
      cpuTicks: toInt(parts[6]),
      sessionId: toInt(parts[7])
    });
  }
  return result;
}

export interface PackedBinding {
  port: number;
  pid: number;
  address: string;
}

/** port, pid, bindAddress - one record per listening socket. */
export function parsePackedBindings(value: string): PackedBinding[] {
  const result: PackedBinding[] = [];
  for (const record of splitRecords(value)) {
    const parts = fields(record);
    result.push({ port: toInt(parts[0]), pid: toInt(parts[1]), address: parts[2] ?? '' });
  }
  return result;
}

/**
 * `pid:ppid` pairs, comma separated. A parent of 0 becomes null: pid 0 is not a
 * process, and treating it as an ancestor would put a meaningless entry at the
 * top of every parent chain.
 */
export function parseParentMap(value: string): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  if (value === '') return parents;
  for (const pair of value.split(',')) {
    const separator = pair.indexOf(':');
    if (separator <= 0) continue;
    const pid = Number(pair.slice(0, separator));
    const ppid = Number(pair.slice(separator + 1));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    parents.set(pid, Number.isInteger(ppid) && ppid > 0 ? ppid : null);
  }
  return parents;
}

export interface PackedListenerDetail {
  pid: number;
  commandLine: string | null;
  image: string | null;
  createdAt: string | null;
}

/** pid, commandLine, imagePath, start - for listener pids only. */
export function parsePackedListenerDetails(value: string): PackedListenerDetail[] {
  const result: PackedListenerDetail[] = [];
  for (const record of splitRecords(value)) {
    const parts = fields(record);
    result.push({
      pid: toInt(parts[0]),
      commandLine: optional(parts[1]),
      image: optional(parts[2]),
      createdAt: optional(parts[3])
    });
  }
  return result;
}

/** Listener pids the OS could not return at all, comma separated. */
export function parseGoneList(value: string): number[] {
  if (value === '') return [];
  return value
    .split(',')
    .map((entry) => Number(entry))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export interface ReservedRange {
  start: number;
  end: number;
  administered: boolean;
}

/**
 * `netsh interface ipv4 show excludedportrange protocol=tcp` prints localized
 * headings, a `----` separator row, and then `Start Port` / `End Port` columns
 * that are numeric in every locale. The trailing `*` marks an administered
 * exclusion.
 *
 * Matching `digits digits [*]` and nothing else means a translated header, a
 * translated footer, or a locale-specific thousands separator can never turn
 * into a bogus range.
 */
export function parseExcludedRanges(text: string): ReservedRange[] {
  const ranges: ReservedRange[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(\d{1,5})\s+(\d{1,5})(\s*\*)?\s*$/.exec(raw);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!isPort(start) || !isPort(end) || end < start) continue;
    ranges.push({ start, end, administered: match[3] !== undefined });
  }
  return ranges;
}

export interface NormalizedAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
  wildcard: boolean;
}

/**
 * Reduces the bind addresses Windows reports to one comparable form.
 *
 * `0.0.0.0` and `::` are both "every interface", and a dual-stack listener
 * shows up as both - one row, not two. IPv4-mapped IPv6 (`::ffff:0.0.0.0`) is
 * the same wildcard wearing a different hat. A `%zone` suffix is dropped
 * because it never changes which interface a bind covers.
 */
export function normalizeAddress(raw: string): NormalizedAddress {
  const address = raw.trim().replace(/%.*$/, '');
  const family: 'IPv4' | 'IPv6' = address.includes(':') ? 'IPv6' : 'IPv4';

  if (address === '0.0.0.0' || address === '::' || address === '::ffff:0.0.0.0' || address === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return { address: 'any', family, wildcard: true };
  }
  if (address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1') {
    return { address: 'loopback', family, wildcard: false };
  }
  return { address, family, wildcard: false };
}

/**
 * Whole-machine CPU percentage from a delta of 100ns tick counters, matching
 * the unit both probe tiers report. Returns null rather than a number when the
 * counters went backwards, which happens when a pid is recycled between scans
 * and would otherwise render as a nonsense spike.
 */
export function percentCpu(
  previousTicks: number,
  previousAt: number,
  currentTicks: number,
  currentAt: number,
  cores: number
): number | null {
  const elapsedMs = currentAt - previousAt;
  if (elapsedMs <= 0 || cores <= 0) return null;
  const deltaTicks = currentTicks - previousTicks;
  if (deltaTicks < 0) return null;
  const cpuSeconds = deltaTicks / 1e7;
  return round1((cpuSeconds / (elapsedMs / 1000)) * (100 / cores));
}

/**
 * True when `whoami /groups` shows the process running at high integrity.
 * The SID is the stable signal; "High Mandatory Level" is a localized label.
 */
export function isElevatedFromWhoami(text: string): boolean {
  return /S-1-16-12288\b/.test(text);
}

export function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** True when `port` falls inside any excluded range Windows reported. */
export function inReservedRange(port: number, ranges: readonly ReservedRange[]): boolean {
  return ranges.some((range) => port >= range.start && port <= range.end);
}