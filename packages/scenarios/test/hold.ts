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
