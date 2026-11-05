// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Airports that have fully implemented Airport Collaborative Decision Making (A-CDM), T102
 * item 4 (docs/07): the departure board of `sim/vdgs_departure` shows the airline's TOBT only
 * here. The list is EUROCONTROL's "fully implemented in 35 airports across Europe" (the page
 * gives no date of its own and no licence; only the airport names are taken, the ICAO codes are
 * ours). Approved by the user 2026-11-05. No entry, no departure board: GSX shows its own.
 */
export interface AcdmAirport {
  readonly icao: string;
  readonly name: string;
  readonly source: string;
  readonly url: string;
  readonly checked: string;
}

const EUROCONTROL = {
  source: 'EUROCONTROL, Airport collaborative decision-making (A-CDM), "Implementation"',
  url: 'https://www.eurocontrol.int/concept/airport-collaborative-decision-making',
  checked: '2026-11-05',
} as const;

const NAMES: readonly (readonly [string, string])[] = [
  ['LEAL', 'Alicante'],
  ['EHAM', 'Amsterdam'],
  ['LEBL', 'Barcelona'],
  ['LIME', 'Bergamo'],
  ['EDDB', 'Berlin Brandenburg'],
  ['EBBR', 'Brussels'],
  ['EKCH', 'Copenhagen'],
  ['EDDL', 'Dusseldorf'],
  ['EDDF', 'Frankfurt'],
  ['LSGG', 'Geneva'],
  ['EDDH', 'Hamburg'],
  ['EFHK', 'Helsinki'],
  ['LPPT', 'Lisbon'],
  ['EGLL', 'London Heathrow'],
  ['EGKK', 'London Gatwick'],
  ['EGSS', 'London Stansted'],
  ['LFLL', 'Lyon'],
  ['LEMD', 'Madrid'],
  ['LEMG', 'Malaga'],
  ['LIML', 'Milan Linate'],
  ['LIMC', 'Milan Malpensa'],
  ['EDDM', 'Munich'],
  ['LIRN', 'Naples'],
  ['LFMN', 'Nice'],
  ['ENGM', 'Oslo'],
  ['LEPA', 'Palma de Mallorca'],
  ['LFPG', 'Paris CDG'],
  ['LFPO', 'Paris Orly'],
  ['LKPR', 'Prague'],
  ['EVRA', 'Riga'],
  ['LIRF', 'Rome Fiumicino'],
  ['EDDS', 'Stuttgart'],
  ['LIPZ', 'Venice'],
  ['LOWW', 'Vienna'],
  ['LSZH', 'Zurich'],
];

export const ACDM_AIRPORTS: readonly AcdmAirport[] = NAMES.map(([icao, name]) => ({
  icao,
  name,
  ...EUROCONTROL,
}));

const BY_ICAO = new Set(ACDM_AIRPORTS.map((a) => a.icao));

/** The airport has fully implemented A-CDM ({@link ACDM_AIRPORTS}). */
export function isAcdmAirport(icao: string): boolean {
  return BY_ICAO.has(icao.toUpperCase());
}
