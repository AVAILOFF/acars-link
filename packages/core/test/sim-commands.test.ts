// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  checkSimCommand,
  isSimCommandName,
  SIM_COMMAND_LIMITS,
  SIM_COMMANDS,
} from '../src/sim/commands.js';

describe('sim commands (T21)', () => {
  it('whitelist', () => {
    expect(SIM_COMMANDS).toEqual([
      'ping',
      'smoke_start',
      'smoke_stop',
      'rescue_start',
      'rescue_stop',
    ]);
    expect(isSimCommandName('ping')).toBe(true);
    expect(isSimCommandName('set_lvar')).toBe(false);
    expect(isSimCommandName(1)).toBe(false);
  });

  it('checks the smoke arguments like the bridge (T34)', () => {
    expect(checkSimCommand('smoke_start', { lat: 34.44, lon: 135.22 })).toBeNull();
    expect(checkSimCommand('smoke_start', { lat: 34.44 })).toMatch(/lat and lon/);
    expect(checkSimCommand('smoke_start', { lat: 91, lon: 0 })).toMatch(/lat/);
    expect(checkSimCommand('smoke_start', { lat: 0, lon: 181 })).toMatch(/lon/);
    expect(checkSimCommand('smoke_start', { lat: '34', lon: 135 })).toMatch(/lat/);
    expect(checkSimCommand('smoke_stop', {})).toBeNull();
    expect(checkSimCommand('smoke_stop', { x: 1 })).toMatch(/no arguments/);
  });

  it('accepts ping without arguments', () => {
    expect(checkSimCommand('ping', {})).toBeNull();
  });

  it('refuses what the bridge would refuse', () => {
    expect(checkSimCommand('set_lvar', {})).toMatch(/unknown command/);
    expect(checkSimCommand('ping', null)).toMatch(/object/);
    expect(checkSimCommand('ping', [1])).toMatch(/object/);
    expect(checkSimCommand('ping', { x: 1 })).toBe('ping takes no arguments');
    expect(checkSimCommand('ping', { 'Bad-Name': 1 })).toMatch(/bad arg name/);
    expect(checkSimCommand('ping', { x: { y: 1 } })).toMatch(/string, number or boolean/);
    expect(checkSimCommand('ping', { x: Number.NaN })).toMatch(/string, number or boolean/);
    expect(checkSimCommand('ping', { s: 'x'.repeat(SIM_COMMAND_LIMITS.maxStringArg + 1) })).toMatch(
      /string, number or boolean/,
    );
    const many = Object.fromEntries(
      Array.from({ length: SIM_COMMAND_LIMITS.maxArgs + 1 }, (_, i) => [`a${i}`, i]),
    );
    expect(checkSimCommand('ping', many)).toBe('too many args');
  });
});
