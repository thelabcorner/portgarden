import { describe, expect, it } from 'vitest';
import { buildAncestry, buildDescendants, type ParentMap } from './group.js';

function map(entries: Array<[number, number | null]>): ParentMap {
  return new Map(entries);
}

describe('buildAncestry', () => {
  it('walks to the root, nearest parent first', () => {
    const parents = map([
      [100, 90],
      [90, 80],
      [80, null]
    ]);
    expect(buildAncestry(parents, 100)).toEqual([90, 80]);
  });

  it('stops at a parent the snapshot does not know', () => {
    // Get-Process saw the child but the parent exited mid-scan. The chain is
    // honestly short rather than invented.
    const parents = map([[100, 90]]);
    expect(buildAncestry(parents, 100)).toEqual([90]);
  });

  it('treats pid 0 as no parent', () => {
    const parents = map([
      [100, 0],
      [4, 0]
    ]);
    expect(buildAncestry(parents, 100)).toEqual([]);
    expect(buildAncestry(parents, 4)).toEqual([]);
  });

  it('terminates on a cycle instead of hanging', () => {
    // ParentProcessId is a stale field on a reused pid, so a loop is a real
    // possibility rather than a theoretical one.
    const parents = map([
      [10, 20],
      [20, 30],
      [30, 10]
    ]);
    expect(buildAncestry(parents, 10)).toEqual([20, 30]);
  });

  it('survives a self-parent, which Windows can also report', () => {
    const parents = map([[10, 10]]);
    expect(buildAncestry(parents, 10)).toEqual([]);
  });

  it('returns an empty chain for an unknown pid', () => {
    expect(buildAncestry(map([]), 999)).toEqual([]);
  });
});

describe('buildDescendants', () => {
  it('collects the whole subtree breadth first', () => {
    const parents = map([
      [1, null],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 4]
    ]);
    expect(buildDescendants(parents, 1)).toEqual([2, 3, 4, 5]);
  });

  it('returns an empty list for a leaf', () => {
    expect(buildDescendants(map([[1, null], [2, 1]]), 2)).toEqual([]);
  });

  it('excludes the starting pid from its own child list', () => {
    const parents = map([
      [7, null],
      [8, 7]
    ]);
    expect(buildDescendants(parents, 7)).not.toContain(7);
  });

  it('terminates on a cycle', () => {
    const parents = map([
      [1, 2],
      [2, 1],
      [3, 1]
    ]);
    expect(buildDescendants(parents, 1).sort()).toEqual([2, 3]);
  });

  it('ignores processes whose parent is 0 or missing', () => {
    const parents = map([
      [1, null],
      [2, 1],
      [3, 0],
      [4, 999]
    ]);
    expect(buildDescendants(parents, 1)).toEqual([2]);
  });

  it('handles a deep chain without recursing', () => {
    // The map is 1 -> 2 -> ... -> 5000 with 5000 parentless, so 5000 is the root
    // and 1 the leaf. Both directions are checked from both ends because each
    // walk traverses the whole chain and either one could recurse.
    const parents = new Map<number, number | null>();
    for (let pid = 1; pid <= 5000; pid += 1) parents.set(pid, pid === 5000 ? null : pid + 1);
    expect(buildAncestry(parents, 1)).toHaveLength(4999);
    expect(buildAncestry(parents, 5000)).toHaveLength(0);
    expect(buildDescendants(parents, 1)).toHaveLength(0);
    expect(buildDescendants(parents, 5000)).toHaveLength(4999);
  });
});