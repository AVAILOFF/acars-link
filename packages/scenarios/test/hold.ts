// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { CompiledScenario } from '@acars/core';

/**
 * T50: the scenarios that hold the aircraft draw how long it lasts. A test that needs a known
 * length replaces the `draw` of `run.hold_min` with a fixed value (and `run.ufn` with `ufn`).
 */
export function withHoldMin(
  s: CompiledScenario,
  min: number | null,
  ufn = false,
  reason = 'FOD INSPECTION',
): CompiledScenario {
  return {
    ...s,
    steps: s.steps.map((x) =>
      x.kind === 'draw'
        ? {
            ...x,
            options: [
              {
                weight: 1,
                values: [
                  ['run.hold_min', { k: 'lit' as const, v: min }],
                  ...(x.options.some((o) => o.values.some(([n]) => n === 'run.ufn'))
                    ? ([['run.ufn', { k: 'lit' as const, v: ufn }]] as const)
                    : []),
                  // dep_fire: the fire starts at once.
                  ...(x.options.some((o) => o.values.some(([n]) => n === 'run.start_min'))
                    ? ([['run.start_min', { k: 'lit' as const, v: 0 }]] as const)
                    : []),
                  ...(x.options.some((o) => o.values.some(([n]) => n === 'run.reason'))
                    ? ([['run.reason', { k: 'lit' as const, v: reason }]] as const)
                    : []),
                ],
              },
            ],
          }
        : x,
    ),
  };
}
