/**
 * The check that stands between a stale row and an unrelated process.
 *
 * Windows recycles process ids. Between the scan that drew a row and the click
 * that acted on it, seconds pass; if the original process exited in that window
 * and its pid was reused, a naive `taskkill` would destroy something the user
 * never looked at and never agreed to.
 *
 * So identity is a triple - pid, creation instant, image path - and all three are
 * re-read in the main process immediately before anything is signalled. A single
 * matching component is not enough; the tuple has to match, and when it does not
 * the operation is refused with an explanation instead of a best guess.
 *
 * This is the same principle the reference app states for durable jobs: a
 * persisted pid alone is never authority to act on a process.
 */

import type { ProcessIdentity } from '../shared/types.js';

/**
 * Compares a recorded identity against a freshly read one.
 *
 * Components that were null when the row was drawn are skipped rather than
 * treated as a mismatch - Windows withholds creation time and image path for
 * protected processes, and refusing every kill of `System` because we cannot
 * read its metadata would be its own kind of wrong. The pid still has to match,
 * and the UI never offers a kill on a row whose identity is entirely unknown.
 */
export function identityMismatch(recorded: ProcessIdentity, live: ProcessIdentity): string | null {
  if (recorded.pid !== live.pid) {
    return `pid ${recorded.pid} is now a different process (live pid ${live.pid}).`;
  }
  if (recorded.createdAt !== null && live.createdAt !== null && recorded.createdAt !== live.createdAt) {
    return `pid ${recorded.pid} started at ${recorded.createdAt}, but the live process started at ${live.createdAt} - the pid was recycled.`;
  }
  if (recorded.image !== null && live.image !== null && !samePath(recorded.image, live.image)) {
    return `pid ${recorded.pid} is now ${live.image}, not ${recorded.image}.`;
  }
  return null;
}

export function sameIdentity(recorded: ProcessIdentity, live: ProcessIdentity): boolean {
  return identityMismatch(recorded, live) === null;
}

/**
 * Windows paths are case-insensitive, and the two sources spell them slightly
 * differently: `Get-Process` may return a short 8.3 name where the CIM provider
 * returns the long one. Trailing separators are stripped so `C:\a\` and `C:\a`
 * are not reported as a different process.
 */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}