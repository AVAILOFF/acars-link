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
