import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards CLAUDE.md invariants 3 and 4 for packages/core/src.
// Biome (biome.json overrides) catches restricted imports/globals; this catches
// member calls that a global-name rule can't (Math.random, Date.now, new Date()).
const SRC = join(import.meta.dirname, '..', 'src');

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bMath\.random\s*\(/, 'Math.random — use the injected Rng (invariant 4)'],
  [/\bDate\.now\s*\(/, 'Date.now — use the injected Clock (invariant 4)'],
  [/\bnew\s+Date\s*\(\s*\)/, 'new Date() — use the injected Clock (invariant 4)'],
  [/\bperformance\.now\s*\(/, 'performance.now — use the injected Clock (invariant 4)'],
  [
    /\bcrypto\.(getRandomValues|randomUUID)\s*\(/,
    'crypto randomness — use the injected Rng (invariant 4)',
  ],
  [/\bfrom\s+['"](node:|electron|react)/, 'Node/Electron/React import (invariant 3)'],
  [
    /\bimport\s*\(\s*['"](node:|electron|react)/,
    'dynamic Node/Electron/React import (invariant 3)',
  ],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|mts|cts)$/.test(e.name) ? [p] : [];
  });
}

describe('core purity', () => {
  it('has source files to check', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(0);
  });

  it('does not use ambient time, randomness or platform imports', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const [re, why] of FORBIDDEN) {
          if (re.test(line)) violations.push(`${relative(SRC, file)}:${i + 1} ${why}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
