// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import {
  DRONE_RISK_CHECKED,
  DRONE_RISK_DEFAULT,
  droneMultiplier,
  droneProbability,
  isDroneRiskKey,
  isDroneRiskValue,
} from '../src/drone-risk.js';

describe('drone_activity multiplier by country (T38)', () => {
  it('levels A–D from docs/07', () => {
    expect(droneMultiplier(DRONE_RISK_DEFAULT, 'RU')).toBe(5);
    for (const c of ['DE', 'DK', 'LT', 'BE', 'NO', 'AE', 'QA', 'KW', 'BH']) {
      expect(droneMultiplier(DRONE_RISK_DEFAULT, c), c).toBe(2);
    }
    for (const c of ['US', 'GB', 'NL', 'PL', 'SE', 'FI', 'LV', 'EE']) {
      expect(droneMultiplier(DRONE_RISK_DEFAULT, c), c).toBe(1);
    }
    expect(droneMultiplier(DRONE_RISK_DEFAULT, 'JP')).toBe(0.3);
    expect(DRONE_RISK_CHECKED).toBe('2026-10-09');
  });

  it('the chance at 3 %: 15 / 6 / 3 / 0.9 %', () => {
    const p = (c: string | null) => droneProbability(0.03, DRONE_RISK_DEFAULT, c);
    expect(p('RU')).toBe(0.15);
    expect(p('DE')).toBe(0.06);
    expect(p('US')).toBe(0.03);
    expect(p('JP')).toBe(0.009);
  });

  it('country unknown → the `*` row', () => {
    expect(droneProbability(0.03, DRONE_RISK_DEFAULT, null)).toBe(0.009);
  });

  it('a manual percent goes through the factor, at most 100 %', () => {
    expect(droneProbability(0.1, DRONE_RISK_DEFAULT, 'RU')).toBe(0.5);
    expect(droneProbability(0.5, DRONE_RISK_DEFAULT, 'RU')).toBe(1);
    expect(droneProbability(0, DRONE_RISK_DEFAULT, 'RU')).toBe(0);
  });

  it('a table without `*`: other countries ×1', () => {
    expect(droneProbability(0.03, { RU: 10 }, 'FR')).toBe(0.03);
    expect(droneProbability(0.03, { RU: 10 }, 'RU')).toBeCloseTo(0.3, 10);
  });

  it('key and value checks', () => {
    expect(isDroneRiskKey('RU')).toBe(true);
    expect(isDroneRiskKey('*')).toBe(true);
    for (const k of ['ru', 'RUS', '', '**', '1A']) expect(isDroneRiskKey(k), k).toBe(false);
    expect(isDroneRiskValue(0)).toBe(true);
    expect(isDroneRiskValue(100)).toBe(true);
    for (const v of [-1, 101, Number.NaN, '2', null]) expect(isDroneRiskValue(v)).toBe(false);
  });
});
