import { OPENFLIGHTS_AIRLINE_COUNTRY, OPENFLIGHTS_ROUTES } from './openflights.js';

/**
 * Does the airline have own departures from the airport (OpenFlights routes, data of 2014; T43)?
 * Only that, never a flight number or a time.
 */
export function airlineDepartsFrom(airline: string | null, airport: string): boolean {
  if (airline === null) return false;
  return (OPENFLIGHTS_ROUTES[airline] ?? '').split(' ').includes(airport);
}

/** Country of the airline as OpenFlights names it (`Finland`); null when unknown. */
export function airlineCountry(airline: string | null): string | null {
  return airline === null ? null : (OPENFLIGHTS_AIRLINE_COUNTRY[airline] ?? null);
}

/**
 * Low-cost carriers (T43): ICAO "List of Low-Cost-Carriers (LCCs) based on ICAO definition", as of
 * 2017-06-13 (icao.int/sustainability, LCC-List.pdf, checked 2026-10-15; only codes of carriers
 * still flying taken). Terms of use of the list are not stated [ПРОВЕРИТЬ].
 */
const LCC_ICAO = [
  ...['RYR', 'EZY', 'EZS', 'WZZ', 'VLG', 'NAX', 'TRA', 'TVF', 'PGT', 'EWG'],
  ...['SWA', 'JBU', 'NKS', 'FFT', 'AAY', 'WJA', 'GLO', 'AZU', 'VIV', 'VOI'],
  ...['AXM', 'AIQ', 'XAX', 'TGW', 'JSA', 'JST', 'JJP', 'CEB', 'IGO', 'SEJ', 'APJ', 'VJC'],
  ...['ABY', 'FDB', 'KNE', 'JZR', 'LNI', 'TWB', 'JNA'],
];
/**
 * Subsidiaries of the listed LCCs founded after the list (easyJet Europe, Ryanair UK, Buzz,
 * Lauda Europe, Wizz Air Malta / UK, Norwegian Air Sweden / International): assumption,
 * confirmed by the user 2026-10-15.
 */
const LCC_SUBSIDIARIES = ['EJU', 'RUK', 'RYS', 'LDM', 'WMT', 'WUK', 'NOZ', 'IBK'];

/**
 * Hub carriers whose passengers mostly connect (Emirates, Etihad, Qatar Airways, Singapore
 * Airlines, Cathay Pacific, Turkish Airlines): the user's examples and three alike, confirmed
 * 2026-10-15.
 */
const HUB_ICAO = ['UAE', 'ETD', 'QTR', 'SIA', 'CPA', 'THY'];

const TYPES: ReadonlyMap<string, AirlineType> = new Map([
  ...[...LCC_ICAO, ...LCC_SUBSIDIARIES].map((a) => [a, 'LCC'] as const),
  ...HUB_ICAO.map((a) => [a, 'HUB'] as const),
]);

/** `LCC` (short turnarounds), `HUB` (connections around two hours), `OTHER`. */
export type AirlineType = 'LCC' | 'HUB' | 'OTHER';

export function airlineType(airline: string | null): AirlineType {
  return (airline === null ? undefined : TYPES.get(airline)) ?? 'OTHER';
}
