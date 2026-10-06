/**
 * A pid file for the running instance.
 *
 * This exists because a tray-only Port Garden is genuinely hard to identify from
 * outside. It has no window to match on, and Electron's executable path does not
 * contain the app name, so neither `MainWindowTitle` nor a command-line match
 * finds it. The practical result was an app that kept running invisibly, held the
 * single-instance lock, and silently prevented a new build from starting while
 * appearing to have been stopped.
 *
 * The recorded start time is not decoration: it is the same defence the rest of
 * the app uses. Windows recycles pids, and a pid file that outlives its process
 * would otherwise point at whatever inherited the number.
 */

import { app } from 'electron';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { logWarn } from './logger.js';

export interface PidRecord {
  pid: number;
  /** Approximate epoch-ms the process started, for pid-reuse detection. */
  startedAt: number;
  version: string;
}

function pidFilePath(): string {
  return path.join(app.getPath('userData'), 'portgarden.pid');
}

export function writePidFile(): void {
  try {
    const directory = path.dirname(pidFilePath());
    mkdirSync(directory, { recursive: true });
    const record: PidRecord = {
      pid: process.pid,
      // `process.uptime()` is exact enough to spot a different process on the
      // same pid, which is the only thing this value is for.
      startedAt: Math.round(Date.now() - process.uptime() * 1000),
      version: app.getVersion()
    };
    writeFileSync(pidFilePath(), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    // Losing the pid file costs discoverability, not correctness. It must never
    // be the reason the app fails to start.
    logWarn(`Could not write the pid file: ${(error as Error).message}`);
  }
}

export function removePidFile(): void {
  try {
    rmSync(pidFilePath(), { force: true });
  } catch {
    // Already gone, or unwritable. Neither matters at this point.
  }
}

export function readPidFile(): PidRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(pidFilePath(), 'utf8')) as Partial<PidRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt, version: typeof parsed.version === 'string' ? parsed.version : '' };
  } catch {
    return null;
  }
}
