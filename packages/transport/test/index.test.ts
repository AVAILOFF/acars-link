import { describe, expect, it } from 'vitest';
import { TRANSPORT_PACKAGE } from '../src/index.js';

describe('@acars/transport', () => {
  it('exports its package marker', () => {
    expect(TRANSPORT_PACKAGE).toBe('@acars/transport');
  });
});
