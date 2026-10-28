// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Regenerates packages/core/src/ext/openflights.ts from the OpenFlights data (T43):
//
//   node tools/openflights/generate.mjs <dir> packages/core/src/ext/openflights.ts
//
// <dir> holds airlines.dat, airports.dat, routes.dat from
// https://github.com/jpatokal/openflights/tree/master/data (docs/06 "OpenFlights").
// Not part of `pnpm check`; run `pnpm lint:fix` after it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, outPath] = process.argv;
if (!dir || !outPath) {
  console.error('usage: node tools/openflights/generate.mjs <dir> <out.ts>');
  process.exit(1);
}

/** One CSV line of the .dat files (quoted strings, `\N` = null). */
function csv(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => (c === '\\N' ? '' : c));
}
const rows = (name) =>
  readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(csv);

const ICAO_AIRLINE = /^[A-Z]{3}$/;
const ICAO_AIRPORT = /^[A-Z]{4}$/;

// airlines.dat: id, name, alias, IATA, ICAO, callsign, country, active
const airlineById = new Map();
const countries = new Map(); // ICAO → Set of countries of active airlines with that code
for (const [id, , , , icao, , country, active] of rows('airlines.dat')) {
  if (!ICAO_AIRLINE.test(icao)) continue;
  airlineById.set(id, icao);
  if (active === 'Y' && country) {
    if (!countries.has(icao)) countries.set(icao, new Set());
    countries.get(icao).add(country);
  }
}

// airports.dat: id, name, city, country, IATA, ICAO, …
const airportById = new Map();
for (const [id, , , , , icao] of rows('airports.dat')) {
  if (ICAO_AIRPORT.test(icao)) airportById.set(id, icao);
}

// routes.dat: airline, airline id, source, source id, dest, dest id, codeshare, stops, equipment
const from = new Map(); // airline ICAO → Set of source airports
const routesFrom = new Map(); // airline ICAO → source airport → dest airport → Set of equipment
for (const [, airlineId, , sourceId, , destId, codeshare, stops, equipment] of rows('routes.dat')) {
  if (codeshare === 'Y') continue; // operated by another airline
  const airline = airlineById.get(airlineId);
  const airport = airportById.get(sourceId);
  if (airline === undefined || airport === undefined) continue;
  if (!from.has(airline)) from.set(airline, new Set());
  from.get(airline).add(airport);
  // Hubs and routes from them (T53): direct routes to a known airport only.
  const dest = airportById.get(destId);
  if (dest === undefined || dest === airport || (stops ?? '0').trim() !== '0') continue;
  if (!routesFrom.has(airline)) routesFrom.set(airline, new Map());
  const bySource = routesFrom.get(airline);
  if (!bySource.has(airport)) bySource.set(airport, new Map());
  const byDest = bySource.get(airport);
  if (!byDest.has(dest)) byDest.set(dest, new Set());
  for (const eq of (equipment ?? '').trim().split(/\s+/)) if (eq !== '') byDest.get(dest).add(eq);
}

// The hub (T53, approved by the user 2026-10-15): the airport with the most own direct routes of
// the airline; a tie for the most leaves the airline without a hub (nothing is picked at random).
const hubs = new Map(); // airline ICAO → { hub, routes: Map dest → Set of equipment }
for (const [airline, bySource] of routesFrom) {
  let best = 0;
  let hub = null;
  for (const [airport, byDest] of bySource) {
    if (byDest.size > best) [best, hub] = [byDest.size, airport];
    else if (byDest.size === best) hub = null;
  }
  if (hub !== null) hubs.set(airline, { hub, routes: bySource.get(hub) });
}

// planes.dat: name, IATA, ICAO. An ICAO type with two different IATA codes is left out.
const planeIata = new Map();
for (const [, iata, icao] of rows('planes.dat')) {
  const t = (icao ?? '').trim();
  if (!/^[A-Z0-9]{2,4}$/.test(t) || !/^[A-Z0-9]{3}$/.test(iata ?? '')) continue;
  planeIata.set(t, planeIata.has(t) && planeIata.get(t) !== iata ? null : iata);
}

const sorted = (it) => [...it].sort();
const q = (s) => JSON.stringify(s);
const routeLines = sorted(from.keys()).map((a) => `  ${a}: '${sorted(from.get(a)).join(' ')}',`);
// An ICAO code shared by active airlines of different countries says nothing: left out.
const countryLines = sorted(countries.keys())
  .filter((a) => countries.get(a).size === 1)
  .map((a) => `  ${a}: ${q([...countries.get(a)][0])},`);
const hubLines = sorted(hubs.keys()).map((a) => `  ${a}: '${hubs.get(a).hub}',`);
const hubRouteLines = sorted(hubs.keys()).map((a) => {
  const r = hubs.get(a).routes;
  const list = sorted(r.keys()).map((d) => `${d}:${sorted(r.get(d)).join(',')}`);
  return `  ${a}: '${list.join(' ')}',`;
});
const planeLines = sorted(planeIata.keys())
  .filter((t) => planeIata.get(t) !== null)
  .map((t) => `  ${t}: '${planeIata.get(t)}',`);

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  outPath,
  // Licence header (T62, tools/spdx/header.mjs): the derived table stays under the ODbL.
  `// SPDX-License-Identifier: ODbL-1.0
// Data: OpenFlights.org, Open Database License 1.0; see THIRD-PARTY-NOTICES.md

/**
 * OpenFlights airline and route data (T43), https://openflights.org/data.php, files of
 * github.com/jpatokal/openflights/tree/master/data (last changed 2017-02-02), taken ${today}.
 * GENERATED by tools/openflights/generate.mjs — do not edit by hand.
 *
 * License: the OpenFlights databases are under the Open Database License (ODbL 1.0), contents
 * under the Database Contents License; route data (Airline Route Mapper) is public domain, airline
 * data from Wikipedia may be under the GFDL. Source: OpenFlights.org. This derived table is
 * under the ODbL as well. Non-commercial use (commercial licences on request from OpenFlights).
 *
 * Route data stopped being updated in June 2014: "the airline flew from this airport" is all it
 * is used for, never flight numbers or times. The airline countries are the "country" of active
 * airlines (the "active" flag is not reliable). Hubs and the routes from them (T53) give the
 * next leg after a flight into the hub, by aircraft type as flown in 2014.
 */

/** Airline ICAO → ICAO airports it had own (not codeshare) departures from, space-separated. */
export const OPENFLIGHTS_ROUTES: Readonly<Record<string, string>> = {
${routeLines.join('\n')}
};

/** Airline ICAO → country (as OpenFlights names it). */
export const OPENFLIGHTS_AIRLINE_COUNTRY: Readonly<Record<string, string>> = {
${countryLines.join('\n')}
};

/**
 * Airline ICAO → its hub (T53): the airport with the most own direct routes; an airline with a
 * tie for the most has none.
 */
export const OPENFLIGHTS_HUB: Readonly<Record<string, string>> = {
${hubLines.join('\n')}
};

/**
 * Airline ICAO → own direct routes from its hub (T53), space-separated \`DEST:EQ,EQ\`: the
 * destination and the IATA aircraft type codes flown on it (may be none).
 */
export const OPENFLIGHTS_HUB_ROUTES: Readonly<Record<string, string>> = {
${hubRouteLines.join('\n')}
};

/** ICAO aircraft type designator → IATA aircraft type code (planes.dat; T53). */
export const OPENFLIGHTS_PLANE_IATA: Readonly<Record<string, string>> = {
${planeLines.join('\n')}
};
`,
);
console.log(
  `wrote ${outPath}: ${routeLines.length} airlines with routes, ${countryLines.length} countries, ` +
    `${hubLines.length} hubs, ${planeLines.length} aircraft types`,
);
