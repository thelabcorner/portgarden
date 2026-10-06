/**
 * Elevation, and the one explicit way to obtain it.
 *
 * Elevation is never implicit: this module reports the current token, and the
 * only way to change it is `relaunchElevated`, which the user has to press. The
 * app is built to be useful unprivileged - the processes that matter on a dev
 * machine are the user's own - so "see more" is opt-in and "kill something" is
 * never gated behind it.
 *
 * One source of truth: the value is computed once at startup from `whoami /groups`
 * and cached. The probe scripts also report an elevation flag, but that is
 * ignored rather than consulted twice, because two readings of one fact is two
 * answers waiting to disagree.
 */

import { app } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { logInfo, logWarn } from './logger.js';
import { isElevatedFromWhoami } from './parse.js';

let elevated: boolean | null = null;

/** True when this process holds a high-integrity (administrator) token. */
export function isElevated(): boolean {
  if (elevated !== null) return elevated;
  elevated = false;
  try {
    const output = execFileSync('whoami.exe', ['/groups'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    elevated = isElevatedFromWhoami(output);
  } catch (error) {
    logWarn(`Could not determine elevation: ${(error as Error).message}`);
  }
  logInfo(elevated ? 'Running elevated.' : 'Running without administrator rights.');
  return elevated;
}

/** Only the elevated relaunch sets this, and it makes the badge authoritative. */
export function isElevatedRelaunch(): boolean {
  return process.argv.includes('--elevated');
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Restarts this app with an administrator token.
 *
 * `Start-Process -Verb RunAs` is used rather than a privileged helper because a
 * helper would need a signed binary, an `SMAuthorizedClients` entry and
 * notarization - weeks of work and a second attack surface, to reach the small
 * minority of rows the user cannot act on anyway. The cost of this approach is
 * that the whole window runs with rights it does not need; the mitigation is the
 * persistent badge, which is why `elevated` is pushed into every state push and
 * rendered in the title bar rather than buried in a settings page.
 */
export async function relaunchElevated(): Promise<{ ok: boolean; message: string }> {
  if (isElevated()) return { ok: false, message: 'Already running as administrator.' };

  // Unpackaged, electron-vite launches `electron <projectDir>`; that argument
  // has to be carried over or the relaunched process has no app to load. A
  // packaged build has no such argument.
  const argument = app.isPackaged ? null : app.getAppPath();
  const argumentList = argument === null ? '' : `-ArgumentList ${quoteForPowerShell(argument)}`;
  const command = `Start-Process -FilePath ${quoteForPowerShell(process.execPath)}${argumentList} -Verb RunAs`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) {
          const cancelled = /canceled by the user|cancelled by the user|-2147024891/i.test(stderr);
          const message = cancelled
            ? 'Administrator launch was cancelled.'
            : `Administrator launch failed: ${(stderr || error.message).trim()}`;
          logWarn(message);
          resolve({ ok: false, message });
          return;
        }
        logInfo('Relaunched with administrator rights.');
        // The old instance quits so the user is not left with two windows; the
        // elevated instance deliberately does not take the single-instance lock,
        // because the unelevated one has not finished releasing it yet.
        setTimeout(() => app.quit(), 150);
        resolve({ ok: true, message: 'Restarting as administrator…' });
      }
    );
  });
}