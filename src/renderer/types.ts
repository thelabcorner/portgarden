/**
 * Renderer-side contracts.
 *
 * `GardenApi` is defined in `shared/types.ts` because the preload also builds it;
 * defining it in both places would let the two drift, and a drifted bridge fails
 * at runtime as an `undefined` on a method nothing type-checks.
 */

export type { AppState, GardenApi, HistoryEntry, HttpIdentity, KillOutcome } from '../shared/types.js';