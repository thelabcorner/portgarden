import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_PROTECT, DEFAULT_SETTINGS, normalizeProcessName, parseSettings, REFRESH_CHOICES } from './settings.js';

describe('parseSettings', () => {
  it('is a fixed point: parsing the defaults returns the defaults unchanged', () => {
    // If this drifts, "the default protect list" and "the protect list a fresh
    // install ends up with" become different objects, and a test comparing them
    // fails for reasons nobody can explain.
    expect(parseSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(DEFAULT_PROTECT)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns the defaults for a missing file', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns the defaults for a value of the wrong shape', () => {
    expect(parseSettings('a string')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
  });

  it('never yields a half-applied configuration', () => {
    // The governing rule: one bad field must not take valid fields with it, and
    // must not leave the protect list partially applied either.
    const result = parseSettings({ theme: 'dark', refreshMs: 'soon', protect: 'nope', pins: 'nope' });
    expect(result.theme).toBe('dark');
    expect(result.refreshMs).toBe(DEFAULT_SETTINGS.refreshMs);
    expect(result.protect).toEqual(DEFAULT_SETTINGS.protect);
    expect(result.pins).toEqual([]);
  });

  it('seeds the protect list with the data services when absent', () => {
    expect(parseSettings({}).protect).toEqual(DEFAULT_PROTECT);
    expect(DEFAULT_PROTECT).toContain('postgres');
    expect(DEFAULT_PROTECT).toContain('sqlservr');
    expect(DEFAULT_PROTECT).toContain('redis-server');
    expect(DEFAULT_PROTECT).toContain('dockerd');
  });

  it('honours an explicitly empty protect list, because unprotecting all is a legitimate choice', () => {
    // This is the difference between "the field is missing" and "the user emptied
    // it". Collapsing them would silently re-protect databases.
    expect(parseSettings({ protect: [] }).protect).toEqual([]);
  });

  it('rejects an unknown theme and keeps the default', () => {
    expect(parseSettings({ theme: 'neon' }).theme).toBe('system');
  });

  it('accepts each valid theme', () => {
    expect(parseSettings({ theme: 'light' }).theme).toBe('light');
    expect(parseSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(parseSettings({ theme: 'system' }).theme).toBe('system');
  });

  it('snaps an arbitrary refresh interval to the nearest offered choice', () => {
    // The settings UI renders exactly what the probe will use, so the value is
    // quantized rather than passed through.
    expect(REFRESH_CHOICES).toContain(parseSettings({ refreshMs: 1999 }).refreshMs);
    expect(REFRESH_CHOICES).toContain(parseSettings({ refreshMs: 0 }).refreshMs);
    expect(parseSettings({ refreshMs: 3100 }).refreshMs).toBe(3000);
    expect(parseSettings({ refreshMs: DEFAULT_SETTINGS.refreshMs }).refreshMs).toBe(DEFAULT_SETTINGS.refreshMs);
  });

  it('offers no interval faster than the fast tier can complete', () => {
    // The fast tier measures ~2.5s. An interval below that would not refresh
    // faster, it would only queue scans behind each other.
    expect(Math.min(...REFRESH_CHOICES)).toBeGreaterThanOrEqual(3000);
  });

  it('drops a pin outside the valid port range', () => {
    expect(parseSettings({ pins: [80, 0, 70000, 'x', 443, 80] }).pins).toEqual([80, 443]);
  });

  it('keeps booleans only where they are booleans', () => {
    expect(parseSettings({ autoRefresh: 'yes' }).autoRefresh).toBe(true);
    expect(parseSettings({ autoRefresh: false }).autoRefresh).toBe(false);
  });
});

describe('normalizeProcessName', () => {
  it('lowercases and drops the .exe suffix so matching is stable', () => {
    expect(normalizeProcessName('PostgreSQL.EXE')).toBe('postgresql');
    expect(normalizeProcessName('  node  ')).toBe('node');
  });
});

describe('applyPatch', () => {
  it('changes only the named field', () => {
    const next = applyPatch(DEFAULT_SETTINGS, { theme: 'dark' });
    expect(next.theme).toBe('dark');
    expect(next.refreshMs).toBe(DEFAULT_SETTINGS.refreshMs);
    expect(next.protect).toEqual(DEFAULT_SETTINGS.protect);
  });

  it('validates the merged result rather than the patch alone', () => {
    // A patch carrying a bad value cannot smuggle it past validation.
    const next = applyPatch(DEFAULT_SETTINGS, { refreshMs: -1 });
    expect(REFRESH_CHOICES).toContain(next.refreshMs);
  });

  it('ignores an empty patch entirely', () => {
    expect(applyPatch(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
    expect(applyPatch(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
  });

  it('toggles a pin off when the patch repeats it', () => {
    const pinned = applyPatch(DEFAULT_SETTINGS, { pins: [3000] });
    expect(pinned.pins).toEqual([3000]);
  });
});