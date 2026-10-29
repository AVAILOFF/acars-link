// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_EXE,
  BRIDGE_TOKEN_ENV,
  bridgeArgs,
  bridgeEnv,
  bridgeExePath,
  startBridge,
} from '../src/main/bridge-process.js';

describe('bridge process', () => {
  it('looks for the exe in resources/bridge', () => {
    expect(bridgeExePath('/res').replaceAll('\\', '/')).toBe(`/res/bridge/${BRIDGE_EXE}`);
  });

  it('does nothing when the exe is not there (dev run)', () => {
    expect(startBridge('/no/such/resources', 47830, 'auto', 'tok')).toBeNull();
  });

  it('"Automatic" is the bridge default (T59); MSFS and X-Plane are fixed with --source', () => {
    expect(bridgeArgs(47830, 'auto')).toEqual(['--port', '47830']);
    expect(bridgeArgs(47830, 'msfs')).toEqual(['--port', '47830', '--source', 'simconnect']);
    expect(bridgeArgs(47831, 'xplane')).toEqual(['--port', '47831', '--source', 'xplane']);
  });

  it('T65: the launch token goes in the environment, never on the command line', () => {
    expect(bridgeEnv({ PATH: 'p' }, 'tok-123')).toEqual({
      PATH: 'p',
      [BRIDGE_TOKEN_ENV]: 'tok-123',
    });
    for (const sim of ['auto', 'msfs', 'xplane'] as const) {
      expect(bridgeArgs(47830, sim).join(' ')).not.toContain('tok-123');
    }
  });
});
