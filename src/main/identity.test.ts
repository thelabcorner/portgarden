import { describe, expect, it } from 'vitest';
import { identityMismatch, sameIdentity } from './identity.js';
import type { ProcessIdentity } from '../shared/types.js';

const identity: ProcessIdentity = {
  pid: 8123,
  createdAt: '2026-09-24T09:36:50.9653530Z',
  image: 'C:\\Program Files\\nodejs\\node.exe'
};

describe('identityMismatch', () => {
  it('accepts an identity that matches on every available component', () => {
    expect(identityMismatch(identity, { ...identity })).toBeNull();
    expect(sameIdentity(identity, { ...identity })).toBe(true);
  });

  it('refuses when the creation instant differs, which is pid reuse', () => {
    // This is the case the whole module exists for: the row was drawn, the
    // process exited, and Windows handed its pid to something else. Without this
    // check the user's click destroys an unrelated process.
    const mismatch = identityMismatch(identity, { ...identity, createdAt: '2026-09-24T11:02:01.0000000Z' });
    expect(mismatch).not.toBeNull();
    expect(mismatch).toContain('recycled');
  });

  it('refuses when the image path differs', () => {
    const mismatch = identityMismatch(identity, { ...identity, image: 'C:\\Windows\\System32\\svchost.exe' });
    expect(mismatch).not.toBeNull();
    expect(mismatch).toContain('not');
  });

  it('compares image paths case-insensitively, as Windows does', () => {
    expect(identityMismatch(identity, { ...identity, image: 'c:\\program files\\nodejs\\NODE.EXE' })).toBeNull();
  });

  it('treats a trailing separator as the same path', () => {
    expect(identityMismatch(identity, { ...identity, image: 'C:\\Program Files\\nodejs\\node.exe\\' })).toBeNull();
  });

  it('refuses outright when the pid itself differs', () => {
    const mismatch = identityMismatch(identity, { ...identity, pid: 8124 });
    expect(mismatch).toContain('different process');
  });

  it('skips a component Windows withheld rather than failing closed on it', () => {
    // Refusing every kill of `System` because we cannot read its metadata would be
    // its own kind of wrong. The pid still has to match.
    const withheld: ProcessIdentity = { pid: 4, createdAt: null, image: null };
    expect(identityMismatch(withheld, { pid: 4, createdAt: '2026-09-24T09:36:50Z', image: 'C:\\Windows\\System32\\ntoskrnl.exe' })).toBeNull();
  });

  it('still refuses a withheld-component identity when the pid differs', () => {
    const withheld: ProcessIdentity = { pid: 4, createdAt: null, image: null };
    expect(identityMismatch(withheld, { pid: 5, createdAt: null, image: null })).not.toBeNull();
  });

  it('compares creation instants exactly rather than approximately', () => {
    // Two starts one millisecond apart are two different processes; rounding here
    // would reopen the hole the check exists to close.
    const other: ProcessIdentity = { ...identity, createdAt: '2026-09-24T09:36:50.9653531Z' };
    expect(identityMismatch(identity, other)).not.toBeNull();
  });
});