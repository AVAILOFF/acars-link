import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from '../src/index.js';

describe('@acars/core', () => {
  it('exports its package marker', () => {
    expect(CORE_PACKAGE).toBe('@acars/core');
  });
});
