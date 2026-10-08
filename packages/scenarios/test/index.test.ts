import { describe, expect, it } from 'vitest';
import { SCENARIOS_PACKAGE } from '../src/index.js';

describe('@acars/scenarios', () => {
  it('exports its package marker', () => {
    expect(SCENARIOS_PACKAGE).toBe('@acars/scenarios');
  });
});
