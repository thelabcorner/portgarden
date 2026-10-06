/**
 * The live preload bridge, kept apart from the type declarations so `types.ts`
 * stays free of runtime code.
 */

import type { GardenApi } from './types.js';

declare global {
  interface Window {
    portGarden: GardenApi;
  }
}

export const api: GardenApi = window.portGarden;