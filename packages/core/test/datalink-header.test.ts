// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcarsCore,
  aesHeaderTokens,
  B78X_PROFILE,
  checkText,
  compileScenario,
  DEFAULT_PROFILE,
  formatMessage,
  generateSyntheticFlight,
  gesCode,
  LinkChannel,
  type LinkPosition,
  linkHeaderLines,
  type OutboundMessage,
  parseSimbriefOfp,
  type ScenarioDef,
  type VhfStation,
  withLinkHeader,
} from '../src/index.js';

/** T32: AES/GES header of the data link, wrap by tokens, the state of the link. */

const ofp = parseSimbriefOfp(
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'ofp', 'rctp-rjbb-a35k-kgs.json'), 'utf8'),
  ),
);
const flight = generateSyntheticFlight({ ofp });

describe('GES codes and header tokens (A7, A8, A9)', () => {
  it('the first code of the table per satellite; none for satellites without a row', () => {
    expect(gesCode('AOR-W')).toBe('43');
    expect(gesCode('AMER')).toBe('05');
    expect(gesCode('APAC')).toBe('50');
    expect(gesCode('EMEA')).toBe('90');
    for (const id of ['AOR-E', 'IOR', 'POR', 'nope']) expect(gesCode(id)).toBeNull();
  });

  it('decoder format of the samples: AES:hex GES:xx 2 .REG', () => {
    expect(aesHeaderTokens('4249ea', '50', 'vq-blq')).toEqual([
      'AES:4249EA',
      'GES:50 2',
      '.VQ-BLQ',
    ]);
    expect(aesHeaderTokens('3B75A8', 'D0', null)).toEqual(['AES:3B75A8', 'GES:D0 2']);
  });

  it('no header without a valid hex or a known GES code', () => {
    expect(aesHeaderTokens(undefined, '50', 'X')).toBeNull();
    expect(aesHeaderTokens('4249E', '50', 'X')).toBeNull();
    expect(aesHeaderTokens('4249EG', '50', 'X')).toBeNull();
    expect(aesHeaderTokens('4249EA', null, 'X')).toBeNull();
  });
});

describe('wrap by tokens (A11)', () => {
  const tokens = ['AES:4249EA', 'GES:50 2', '.VQ-BLQ'];

  it('narrow display: whole tokens per line, the registration is never cut', () => {
    expect(linkHeaderLines(tokens, DEFAULT_PROFILE)).toEqual(['AES:4249EA GES:50 2', '.VQ-BLQ']);
  });

  it('wide display: one line', () => {
    expect(linkHeaderLines(tokens, B78X_PROFILE)).toEqual(['AES:4249EA GES:50 2 .VQ-BLQ']);
  });

  it('a token longer than a line is wrapped by the formatter rules, every line fits', () => {
    const tiny = { ...DEFAULT_PROFILE, id: 'tiny', lineWidth: 8 };
    const lines = linkHeaderLines(tokens, tiny);
    expect(lines.every((l) => l.length <= 8)).toBe(true);
    expect(lines.join('').replaceAll(' ', '')).toBe('AES:4249EAGES:502.VQ-BLQ');
  });

  it('goes in front of a formatted message through the formatter', () => {
    const msg = formatMessage({ header: 'OPS MSG RJBB', body: 'RWY 24R CLOSED' }, DEFAULT_PROFILE);
    const out = withLinkHeader(msg, linkHeaderLines(tokens, DEFAULT_PROFILE), DEFAULT_PROFILE);
    expect(out.lines.slice(0, 3)).toEqual(['AES:4249EA GES:50 2', '.VQ-BLQ', 'OPS MSG RJBB']);
    expect(out.lines.slice(3)).toEqual(msg.lines.slice(1));
    expect(checkText(out.text, DEFAULT_PROFILE)).toEqual([]);
    expect(withLinkHeader(msg, [], DEFAULT_PROFILE)).toBe(msg);
  });
});

const pos = (lat: number, lon: number, altFt: number): LinkPosition => ({
  lat,
  lon,
  altFt,
  onGround: false,
});
const msg = { scenarioId: 'x', kind: 'telex', t: 0, toPilot: false } as unknown as OutboundMessage;
const AIRCRAFT = { icaoHex: '4249ea', reg: 'VQ-BLQ' };

describe('the window state of the link', () => {
  it('SATCOM with a GES code: the header; its last delivery', () => {
    const ch = new LinkChannel(true, 's', undefined, AIRCRAFT);
    const t = 1_000_000;
    const west = pos(40, -50, 37_000); // AOR-W 54°W
    ch.process(t, west, [], [msg]);
    expect(ch.view).toMatchObject({
      link: { kind: 'satcom', station: 'AOR-W', ges: '43' },
      header: 'AES:4249EA GES:43 2 .VQ-BLQ',
      held: 0,
      inFlight: 1,
      last: null,
    });
    let out: OutboundMessage[] = [];
    for (let s = 1; out.length === 0 && s <= 40; s++) out = ch.process(t + s * 1000, west, [], []);
    expect(out[0]?.link?.header).toEqual(['AES:4249EA', 'GES:43 2', '.VQ-BLQ']);
    expect(ch.view.last).toMatchObject({ delayMs: out[0]?.link?.delayMs });
  });

  it('no header on VHF, for a satellite without a code, or without the hex', () => {
    const stations: VhfStation[] = [{ icao: 'EDDF', lat: 50, lon: 8.5 }];
    const vhf = new LinkChannel(true, 's', undefined, AIRCRAFT);
    vhf.process(1, pos(50, 9, 30_000), stations, []);
    expect(vhf.view).toMatchObject({ link: { kind: 'vhf' }, header: null });

    const aoe = new LinkChannel(true, 's', undefined, AIRCRAFT);
    aoe.process(1, pos(50, -30, 37_000), [], []);
    expect(aoe.view).toMatchObject({ link: { station: 'AOR-E', ges: null }, header: null });

    const nohex = new LinkChannel(true, 's', undefined, { reg: 'VQ-BLQ' });
    nohex.process(1, pos(40, -50, 37_000), [], []);
    expect(nohex.view.header).toBeNull();
  });

  it('the last delivery survives a state round trip', () => {
    const ch = new LinkChannel(true, 's', undefined, AIRCRAFT);
    const west = pos(40, -50, 37_000);
    ch.process(1_000, west, [], [msg]);
    for (let s = 1; s <= 40; s++) ch.process(1_000 + s * 1000, west, [], []);
    const copy = new LinkChannel(true, 's', JSON.parse(JSON.stringify(ch.getState())), AIRCRAFT);
    expect(copy.view.last).toEqual(ch.view.last);
    expect(copy.view.last).not.toBeNull();
  });
});

describe('core: the header in the message text (off by default)', () => {
  const def: ScenarioDef = {
    id: 'ping',
    version: 1,
    category: 'irregular',
    title: 'ping',
    enabled_by_default: true,
    trigger: { on: 'phase_enter', phase: 'CRUISE' },
    steps: [{ send: { body: 'PING' } }],
  };

  function fly(datalink: { headerInText?: boolean; icaoHex?: string }) {
    const core = AcarsCore.create({
      ofp,
      scenarios: [compileScenario(def)],
      seed: 'hdr',
      datalink: { satcom: true, ...datalink },
    });
    core.startFlight();
    const out: OutboundMessage[] = [];
    flight.snapshots.forEach((s) => {
      out.push(...core.tick({ now: s.t, telemetry: s }).outbound);
    });
    return out;
  }

  it('SATCOM (APAC, GES 50): the link carries the header; the text only when asked', () => {
    const plain = fly({ icaoHex: '4249EA' });
    expect(plain).toHaveLength(1);
    expect(plain[0]?.link).toMatchObject({ kind: 'satcom', station: 'APAC' });
    expect(plain[0]?.link?.header?.slice(0, 2)).toEqual(['AES:4249EA', 'GES:50 2']);
    expect(plain[0]?.message.text.startsWith('AES:')).toBe(false);

    const inText = fly({ icaoHex: '4249EA', headerInText: true });
    expect(inText[0]?.message.text.startsWith('AES:4249EA GES:50 2')).toBe(true);
    expect(inText[0]?.message.text).toContain('PING');
    expect(checkText(inText[0]?.message.text ?? '', DEFAULT_PROFILE)).toEqual([]);
  });

  it('without the hex there is no header even when asked', () => {
    const r = fly({ headerInText: true });
    expect(r[0]?.link?.header).toBeUndefined();
    expect(r[0]?.message.text.startsWith('AES:')).toBe(false);
  });
});
