// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { HELP } from '../src/renderer/src/help.js';
import { MESSAGES } from '../src/renderer/src/i18n.js';
import {
  type Box,
  placeCard,
  type ReadyKey,
  readiness,
  TOUR_GAP,
  TOUR_STOPS,
  WELCOME_STEPS,
} from '../src/renderer/src/welcome.js';
import type { AppState, BridgeView } from '../src/shared/api.js';

/** T70: the readiness list (U-01, U-02), the tour card placement and the texts. */

const bridge = (b: Partial<BridgeView>): BridgeView =>
  ({
    link: 'closed',
    sim: null,
    running: false,
    paused: false,
    simRate: 1,
    detail: null,
    retryAt: null,
    protocol: null,
    commands: [],
    source: null,
    version: null,
    ...b,
  }) as BridgeView;

const app = (b: Partial<BridgeView>, flight = false): Pick<AppState, 'bridge' | 'flight'> => ({
  bridge: bridge(b),
  flight: flight ? ({} as AppState['flight']) : null,
});

const states = (items: ReturnType<typeof readiness>) =>
  Object.fromEntries(items.map((i) => [i.key, i.state])) as Record<ReadyKey, string>;

describe('readiness (U-01, U-02)', () => {
  const none = { simbriefUsername: '', hoppieCodeSet: false };
  const all = { simbriefUsername: 'pilot', hoppieCodeSet: true };

  it('a new profile: everything to do, each with its settings field; the OFP has none', () => {
    const items = readiness(app({}), none, { transport: 'hoppie' });
    expect(items.map((i) => i.key)).toEqual(['simbrief', 'network', 'bridge', 'sim', 'ofp']);
    expect(items.every((i) => i.state === 'todo')).toBe(true);
    expect(items.map((i) => i.fix?.field ?? null)).toEqual([
      'sb-user',
      'hoppie-code',
      'sim-choice',
      'sim-choice',
      null,
    ]);
    expect(items.find((i) => i.key === 'bridge')?.fix?.advanced).toBe(true);
  });

  it('all set: everything done, no fixes', () => {
    const items = readiness(app({ link: 'open', sim: 'connected', running: true }, true), all, {
      transport: 'hoppie',
    });
    expect(items.every((i) => i.state === 'ok' && i.fix === null)).toBe(true);
  });

  it('offline mode stands in for the Hoppie code', () => {
    const [, network] = readiness(app({}), none, { transport: 'offline' });
    expect(network).toMatchObject({ key: 'network', state: 'ok', offline: true, fix: null });
    expect(readiness(app({}), all, { transport: 'hoppie' })[1]?.offline).toBe(false);
  });

  it('bridge and simulator: connecting and the sim menu wait, a lost sim is to do', () => {
    const s = (b: Partial<BridgeView>) => states(readiness(app(b), all, { transport: 'hoppie' }));
    expect(s({ link: 'connecting' })).toMatchObject({ bridge: 'wait', sim: 'todo' });
    expect(s({ link: 'open', sim: null })).toMatchObject({ bridge: 'ok', sim: 'todo' });
    expect(s({ link: 'open', sim: 'disconnected' })).toMatchObject({ sim: 'todo' });
    expect(s({ link: 'open', sim: 'connecting' })).toMatchObject({ sim: 'wait' });
    expect(s({ link: 'open', sim: 'connected', running: false })).toMatchObject({ sim: 'wait' });
    expect(s({ link: 'open', sim: 'connected', running: true })).toMatchObject({ sim: 'ok' });
    // Without the bridge nothing is known about the sim (U-19).
    expect(s({ link: 'closed', sim: 'connected', running: true })).toMatchObject({ sim: 'todo' });
  });
});

describe('tour card placement', () => {
  const view = { w: 1180, h: 820 };
  const card = { w: 340, h: 180 };
  const g = TOUR_GAP;
  const inside = (p: { x: number; y: number }) =>
    p.x >= g && p.y >= g && p.x + card.w <= view.w - g && p.y + card.h <= view.h - g;

  it('right of the element when it fits, centred on it', () => {
    const rail: Box = { x: 0, y: 56, w: 88, h: 700 };
    expect(placeCard(rail, card, view)).toEqual({ x: 88 + g, y: 56 + 350 - 90 });
  });

  it('left of an element at the right edge', () => {
    const ctx: Box = { x: 820, y: 100, w: 360, h: 300 };
    expect(placeCard(ctx, card, view)).toEqual({ x: 820 - g - card.w, y: 160 });
  });

  it('below a full-width bar, above the bottom one; always inside the window', () => {
    const top: Box = { x: 0, y: 0, w: 1180, h: 56 };
    const bottom: Box = { x: 0, y: 780, w: 1180, h: 40 };
    expect(placeCard(top, card, view)).toEqual({ x: 420, y: 56 + g });
    expect(placeCard(bottom, card, view)).toEqual({ x: 420, y: 780 - g - card.h });
    for (const b of [
      top,
      bottom,
      { x: 0, y: 0, w: 1180, h: 820 },
      { x: 1100, y: 800, w: 80, h: 20 },
    ]) {
      expect(inside(placeCard(b, card, view)), JSON.stringify(b)).toBe(true);
    }
  });
});

describe('welcome and tour texts', () => {
  it('every step and stop has its texts in EN and RU', () => {
    for (const lang of ['en', 'ru'] as const) {
      const m: Readonly<Record<string, string>> = MESSAGES[lang];
      for (const s of WELCOME_STEPS) expect(m[`welcome.${s}.title`], s).toBeTruthy();
      for (const s of TOUR_STOPS) {
        expect(m[`tour.${s}.title`], s).toBeTruthy();
        expect(m[`tour.${s}.text`], s).toBeTruthy();
      }
    }
  });

  it('Help explains the interface in both languages', () => {
    for (const lang of ['en', 'ru'] as const) {
      const start = HELP[lang].find((s) => s.id === 'start');
      expect(start?.items.map((i) => i.id)).toContain('ui');
    }
  });
});
