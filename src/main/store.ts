/**
 * Persistence for settings.
 *
 * Two invariants worth stating:
 *
 * - The file lives in the user profile. An elevated instance writes exactly
 *   where a normal one reads, which is what makes "relaunch as administrator"
 *   a transparent upgrade rather than a second app.
 * - Writes are atomic (temp file + rename). A crash mid-write must not leave a
 *   truncated file that would then silently reset the protect list to defaults.
 */

import { app } from 'electron';
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { logWarn } from './logger.js';
import { DEFAULT_SETTINGS, parseSettings } from './settings.js';
import type { Settings } from '../shared/types.js';

let cached: Settings | null = null;
let filePath = '';

export function getSettings(): Settings {
  if (cached) return cached;
  const directory = path.join(app.getPath('userData'), 'config');
  mkdirSync(directory, { recursive: true });
  filePath = path.join(directory, 'settings.json');

  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn(`Settings file was unreadable; falling back to defaults: ${(error as Error).message}`);
    }
  }
  // parseSettings returns defaults for anything malformed, which is the whole
  // point: a bad file can never yield a half-applied configuration.
  cached = parseSettings(raw ?? DEFAULT_SETTINGS);
  return cached;
}

export function saveSettings(next: Settings): Settings {
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temp, filePath);
  cached = next;
  return cached;
}