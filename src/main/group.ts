/**
 * Parent and child relationships, computed from one snapshot.
 *
 * Windows `taskkill /T` walks the tree itself, at kill time, from whatever it
 * sees then. Showing the user a scope computed a moment earlier is still worth
 * doing - they need to know whether they are about to end three processes or
 * thirty - so the UI says "children at kill time may differ" rather than
 * pretending our count is authoritative.
 *
 * Every walk here is visited-set guarded. `ParentProcessId` is a stale field on
 * a reused pid, so a cycle is a real possibility, not a theoretical one.
 */

/** pid -> parent pid. `null` means Windows reported no parent. */
export type ParentMap = ReadonlyMap<number, number | null>;

/** Ancestor pids, nearest parent first, excluding `pid` itself. */
export function buildAncestry(parents: ParentMap, pid: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let current = parents.get(pid) ?? null;
  while (current !== null && current > 0 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parents.get(current) ?? null;
  }
  return chain;
}

/** Descendant pids in breadth-first order, excluding `pid` itself. */
export function buildDescendants(parents: ParentMap, pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    if (parent === null || parent <= 0) continue;
    const bucket = children.get(parent);
    if (bucket) bucket.push(child);
    else children.set(parent, [child]);
  }

  const found: number[] = [];
  const seen = new Set<number>([pid]);
  const queue: number[] = [pid];
  while (queue.length > 0) {
    const next = children.get(queue.shift()!);
    if (!next) continue;
    for (const child of next) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}