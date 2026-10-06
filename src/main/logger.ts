/**
 * The bounded, redacted activity log.
 *
 * Two hard rules, both learned the hard way elsewhere: an in-memory ring is
 * capped so a long-running session cannot grow without bound, and every message
 * is redacted *before* it reaches memory or disk. Nothing here ever records a
 * command line verbatim at info level - a dev-server command line is a
 * plausible place for a token to appear in an --env style argument.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const LOG_CAPACITY = 400;

export interface LogEntry {
  seq: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

let entries: LogEntry[] = [];
let sequence = 0;
let filePath: string | null = null;

/**
 * Strips the shapes most likely to carry a secret in a process command line.
 * Deliberately aggressive: this log is a diagnostic aid, not an audit trail.
 */
export function redact(input: string): string {
  return input
    .replace(/(--?(?:api[-_]?key|token|secret|password|passwd|pwd|auth)[= ])\S+/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '***')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ***')
    .replace(/(^[A-Za-z]:\\[^\s"]*[\\/](?:\.env|\.npmrc|\.netrc)[^\s"]*)/gi, '$1');
}

export function initLog(directory: string): void {
  mkdirSync(directory, { recursive: true });
  filePath = path.join(directory, 'portgarden.log');
}

export function logFilePath(): string {
  return filePath ?? '';
}

export function logTail(): string[] {
  return entries.map((entry) => `[${entry.level}] ${entry.message}`);
}

function write(level: LogEntry['level'], message: string): void {
  const clean = redact(message);
  sequence += 1;
  const entry: LogEntry = { seq: sequence, at: Date.now(), level, message: clean };
  entries.push(entry);
  if (entries.length > LOG_CAPACITY) entries = entries.slice(entries.length - LOG_CAPACITY);
  if (!filePath) return;
  try {
    appendFileSync(filePath, `${new Date(entry.at).toISOString()} ${level.toUpperCase()} ${clean}\n`, 'utf8');
  } catch {
    // A log that cannot be written must never take the app down with it.
  }
}

export const logInfo = (message: string): void => write('info', message);
export const logWarn = (message: string): void => write('warn', message);
export const logError = (message: string): void => write('error', message);

/** Test seam: resets the ring and sequence without touching the file. */
export function resetLogForTest(): void {
  entries = [];
  sequence = 0;
}