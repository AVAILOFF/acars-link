// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { NAT_POINT, type NatTrack } from '@acars/core';
import {
  DataSourceError,
  expectOk,
  type FetchContext,
  isObj,
  parseJson,
  request,
} from './common.js';

/**
 * Active North Atlantic tracks from natTrak, the VATSIM oceanic clearance service (T27,
 * docs/06 "Океанический клиренс"; checked 2026-10-09): `GET
 * https://nattrak.vatsim.net/api/tracks` → `[{identifier, active, last_routeing, valid_from,
 * valid_to, last_active, concorde, flight_levels, direction, odd_or_even}]`. natTrak takes the
 * tracks from the real NAT track NOTAMs (`TracksService::getTracks`, github.com/vatsimnetwork/
 * nattrak). Kept: active tracks that are not natTrak's own Concorde tracks (`concorde` 1).
 * `last_routeing` is the track message route: `RATSU 63/20 64/30 64/40 63/50 MAXAR`. No key.
 * The service's terms of use are not published (`[VERIFY]` before a public release).
 */

export const NATTRAK_TRACKS_URL = 'https://nattrak.vatsim.net/api/tracks';

export async function fetchNatTracks(ctx: FetchContext): Promise<NatTrack[]> {
  const res = await request(ctx, NATTRAK_TRACKS_URL);
  expectOk(res, 'natTrak');
  return parseNatTracks(parseJson(res.body, 'natTrak'));
}

export function parseNatTracks(json: unknown): NatTrack[] {
  if (!Array.isArray(json)) throw new DataSourceError('natTrak: not a list of tracks');
  const out: NatTrack[] = [];
  for (const k of json) {
    if (!isObj(k) || k['active'] !== true || k['concorde'] === 1 || k['concorde'] === true) {
      continue;
    }
    const ident = k['identifier'];
    const routeing = k['last_routeing'];
    if (typeof ident !== 'string' || !/^[A-Z]{1,2}$/.test(ident)) continue;
    if (typeof routeing !== 'string') continue;
    const route = routeing.trim().split(/\s+/);
    if (route.length < 2 || !route.every((p) => NAT_POINT.test(p))) continue;
    const validFrom = Date.parse(String(k['valid_from']));
    const validTo = Date.parse(String(k['valid_to']));
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) continue;
    const levels = Array.isArray(k['flight_levels']) ? k['flight_levels'] : [];
    const levelsFt = levels.filter(
      (l): l is number => typeof l === 'number' && Number.isInteger(l) && l > 0,
    );
    out.push({ ident, route, validFrom, validTo, levelsFt });
  }
  return out.sort((a, b) => (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0));
}
