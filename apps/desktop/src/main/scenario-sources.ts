// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { ScenarioSource } from './controller.js';

/**
 * The scenarios the app ships: the base pack (`packages/scenarios/base/*.yaml`), the pilot
 * command handlers (`packages/scenarios/commands/*.yaml`, T12) and the live-data scenarios
 * (`packages/scenarios/external/*.yaml`, T13) and the irregular ones
 * (`packages/scenarios/irregular/*.yaml`, T14) and the sim-effect ones
 * (`packages/scenarios/sim/*.yaml`, T22 VDGS), embedded into the main bundle
 * at build time, so the app needs no path to the repository at run time.
 */
const files = {
  ...import.meta.glob<string>('../../../../packages/scenarios/base/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>('../../../../packages/scenarios/commands/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>('../../../../packages/scenarios/external/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>('../../../../packages/scenarios/irregular/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>('../../../../packages/scenarios/sim/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

export const BASE_SCENARIOS: readonly ScenarioSource[] = Object.entries(files)
  .map(([path, source]) => ({ file: path.slice(path.lastIndexOf('/') + 1), source }))
  .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
