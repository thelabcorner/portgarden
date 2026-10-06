/**
 * Settings: the single validator for everything Port Garden persists.
 *
 * Kept free of any `electron` import so it can be unit-tested directly, and it
 * is the *only* place a settings shape is validated - the store does not
 * second-guess it.
 *
 * The governing rule is the reference app's: an unreadable or malformed file
 * yields the defaults, never a previous load's values and never a partially
 * applied merge. A corrupt settings file must never be able to hand the app a
 * half-configured protect list.
 */

import type { Settings, ThemePreference } from '../shared/types.js';
import { isPort } from './parse.js';

/**
 * Windows `TerminateProcess` cannot be caught. Doing that to a database means
 * a crash-recovery cycle at best and data loss at worst, so these ship
 * protected out of the box. They are ordinary entries in the same protect list
 * the user can edit - pre-seeding rather than hardcoding is deliberate, so an
 * unprotect is a visible act rather than a code change.
 *
 * Kept in the exact order `normalizeProtect` produces, so that parsing the
 * defaults yields the defaults unchanged. Without that, the defaults object and
 * the parsed shape drift apart, and the two disagree about what a given list
 * means - which is exactly the kind of drift this project has one validator to
 * prevent.
 */
export const DEFAULT_PROTECT: readonly string[] = [
  'com.docker.backend',
  'docker-proxy',
  'dockerd',
  'elastic',
  'influxd',
  'mariadbd',
  'mongod',
  'mssql',
  'mysqld',
  'postgres',
  'redis-server',
  'sqlagent',
  'sqlservr',
  'vmcompute',
  'wslservice'
];

/**
 * The fast tier measures ~2.5s end to end, so an interval at or below that would
 * only queue scans back to back. 60s is the point where a machine nobody is
 * changing stops needing to be re-read.
 */
export const REFRESH_CHOICES: readonly number[] = [3000, 5000, 10_000, 30_000, 60_000];

export const DEFAULT_SETTINGS: Settings = {
  refreshMs: 3000,
  autoRefresh: true,
  theme: 'system',
  protect: [...DEFAULT_PROTECT],
  pins: [],
  closeToTray: true,
  launchAtLogin: false
};

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/**
 * Image names are stored and compared lower-cased with no `.exe` suffix so the
 * protect list matches `Get-Process`'s `ProcessName` regardless of how the user
 * typed the entry.
 */
export function normalizeProcessName(value: string): string {
  return value.trim().toLowerCase().replace(/\.exe$/, '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeProtect(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_PROTECT];
  const names = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeProcessName)
    .filter((entry) => entry.length > 0);
  return [...new Set(names)].sort();
}

function normalizePins(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ports = value.filter((entry): entry is number => typeof entry === 'number' && isPort(entry));
  return [...new Set(ports)].sort((a, b) => a - b);
}

/**
 * Validates a settings object field by field, substituting the default for any
 * field that is missing or the wrong type. Only `protect` and `pins` are
 * user-meaningful enough to tolerate a bad value; `refreshMs` snaps to the
 * nearest offered choice rather than accepting an arbitrary number, so the
 * settings UI can render exactly what the probe will use.
 */
export function parseSettings(raw: unknown): Settings {
  const input = asRecord(raw);

  const requested = typeof input['refreshMs'] === 'number' ? input['refreshMs'] : DEFAULT_SETTINGS.refreshMs;
  const refreshMs = REFRESH_CHOICES.reduce((nearest, choice) =>
    Math.abs(choice - requested) < Math.abs(nearest - requested) ? choice : nearest
  , REFRESH_CHOICES[0]!);

  const theme = THEMES.includes(input['theme'] as ThemePreference) ? (input['theme'] as ThemePreference) : DEFAULT_SETTINGS.theme;

  return {
    refreshMs,
    autoRefresh: bool(input['autoRefresh'], DEFAULT_SETTINGS.autoRefresh),
    theme,
    protect: 'protect' in input ? normalizeProtect(input['protect']) : [...DEFAULT_PROTECT],
    pins: 'pins' in input ? normalizePins(input['pins']) : [],
    closeToTray: bool(input['closeToTray'], DEFAULT_SETTINGS.closeToTray),
    launchAtLogin: bool(input['launchAtLogin'], DEFAULT_SETTINGS.launchAtLogin)
  };
}

/** A patch is applied by validating the merged result, never field by field. */
export function applyPatch(current: Settings, patch: unknown): Settings {
  const input = asRecord(patch);
  return parseSettings({
    refreshMs: 'refreshMs' in input ? input['refreshMs'] : current.refreshMs,
    autoRefresh: 'autoRefresh' in input ? input['autoRefresh'] : current.autoRefresh,
    theme: 'theme' in input ? input['theme'] : current.theme,
    protect: 'protect' in input ? input['protect'] : current.protect,
    pins: 'pins' in input ? input['pins'] : current.pins,
    closeToTray: 'closeToTray' in input ? input['closeToTray'] : current.closeToTray,
    launchAtLogin: 'launchAtLogin' in input ? input['launchAtLogin'] : current.launchAtLogin
  });
}