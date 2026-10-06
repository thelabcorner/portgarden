/**
 * Closing and terminating processes, safely.
 *
 * Windows has no SIGTERM. `process.kill(pid)` in Node calls `TerminateProcess`,
 * which cannot be caught and is equivalent to a forced kill - so there is no
 * version of "graceful then forceful with a pause" to build here. What Windows
 * does offer is:
 *
 *   Close     `taskkill /PID n`          sends WM_CLOSE to a window. Only a
 *                                         windowed process can accept it; a
 *                                         console or headless process is
 *                                         refused, and the refusal is the
 *                                         operating system's own sentence.
 *   Terminate `taskkill /F /T /PID n`    hard, uncatchable, plus the child tree.
 *
 * So the honest ladder is Close, then Terminate, with the real refusal text in
 * between. Nothing here escalates on the user's behalf, and no outcome is
 * dressed up as something it is not.
 *
 * Every path re-reads the live identity first. See identity.ts for why a pid on
 * its own is not authority to end a process.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { isElevated } from './elevation.js';
import { identityMismatch } from './identity.js';
import { logInfo, logWarn } from './logger.js';
import { readLiveIdentity } from './probe.js';
import { getSettings } from './store.js';
import type { KillOutcome, KillRequest } from '../shared/types.js';

function outcome(request: KillRequest, patch: Partial<KillOutcome>): KillOutcome {
  return {
    ok: false,
    pid: request.pid,
    method: request.method,
    tree: request.method === 'terminate',
    code: 'taskkill',
    message: null,
    ...patch
  };
}

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** `taskkill`'s exit codes, kept next to the mapping that depends on them. */
const EXIT_ACCESS_DENIED = 5;
const EXIT_CANNOT_TERMINATE = 128;

interface TaskkillResult {
  code: number;
  /** Windows' own words, passed through untouched. */
  text: string;
}

function taskkill(args: string[]): Promise<TaskkillResult> {
  return new Promise((resolve) => {
    execFile('taskkill.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? ((error as unknown as { code: number }).code)
        : error
          ? 1
          : 0;
      const combined = `${String(stdout).trim()} ${String(stderr).trim()}`.trim();
      resolve({ code, text: combined });
    });
  });
}

export async function performKill(request: KillRequest): Promise<KillOutcome> {
  const live = await readLiveIdentity(request.pid);

  if (!live.found) {
    logInfo(`pid ${request.pid} had already exited before the action.`);
    return outcome(request, { code: 'gone', message: `Process ${request.pid} has already exited.` });
  }

  const mismatch = identityMismatch(request.identity, {
    pid: live.pid,
    createdAt: live.createdAt,
    image: live.image
  });
  if (mismatch) {
    logWarn(`Refused to act on pid ${request.pid}: ${mismatch}`);
    return outcome(request, { code: 'identity', message: `${mismatch} Nothing was terminated.` });
  }

  const settings = getSettings();
  if (settings.protect.includes(live.name) && !request.allowProtected) {
    logWarn(`Refused to act on protected process "${live.name}" (pid ${request.pid}).`);
    return outcome(request, {
      code: 'protected',
      message: `"${live.name}" is on the protect list. Unprotect it in Settings, or confirm the override, to terminate it.`
    });
  }

  // Unprivileged, a process owned by someone else cannot be signalled at all.
  // Saying so up front is better than spawning taskkill to be told "Access is
  // denied" and then guessing why.
  if (!isElevated() && live.owner !== null && live.owner !== '' && live.owner !== currentUser()) {
    return outcome(request, {
      code: 'requires-elevation',
      message: `"${live.name}" is owned by ${live.owner}. Relaunch Port Garden as administrator to act on processes you do not own.`
    });
  }

  const args = request.method === 'close' ? ['/PID', String(request.pid)] : ['/F', '/T', '/PID', String(request.pid)];
  const result = await taskkill(args);

  if (result.code === 0) {
    logInfo(`${request.method === 'close' ? 'Closed' : 'Terminated'} pid ${request.pid} (${live.name})${request.method === 'terminate' ? ' with its child tree' : ''}.`);
    return outcome(request, { ok: true, code: null });
  }

  const verbatim = result.text.replace(/\s+/g, ' ').trim() || `taskkill exited with code ${result.code}.`;

  if (request.method === 'close' && result.code === EXIT_CANNOT_TERMINATE) {
    // The expected path for every headless dev server: WM_CLOSE needs a window.
    logWarn(`Close was refused for pid ${request.pid}: ${verbatim}`);
    return outcome(request, { code: 'taskkill', message: `${verbatim} Close only works on a process with a window; this one is headless. Use Terminate.` });
  }
  if (result.code === EXIT_ACCESS_DENIED) {
    logWarn(`Access denied for pid ${request.pid}: ${verbatim}`);
    return outcome(request, {
      code: 'requires-elevation',
      message: `${verbatim} Port Garden is not running as administrator.`
    });
  }

  logWarn(`${request.method} failed for pid ${request.pid}: ${verbatim}`);
  return outcome(request, { code: 'taskkill', message: verbatim });
}

/** Exposed for the tests, which assert on the code/message split. */
export const KILL_EXIT = { ACCESS_DENIED: EXIT_ACCESS_DENIED, CANNOT_TERMINATE: EXIT_CANNOT_TERMINATE } as const;