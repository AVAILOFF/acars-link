import { describe, expect, it } from 'vitest';
import { BRIDGE_EXE, bridgeExePath, startBridge } from '../src/main/bridge-process.js';

describe('bridge process', () => {
  it('looks for the exe in resources/bridge', () => {
    expect(bridgeExePath('/res').replaceAll('\\', '/')).toBe(`/res/bridge/${BRIDGE_EXE}`);
  });

  it('does nothing when the exe is not there (dev run)', () => {
    expect(startBridge('/no/such/resources', 47830)).toBeNull();
  });
});
