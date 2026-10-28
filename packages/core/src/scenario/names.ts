// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Rng } from '../random/rng.js';

/**
 * Person names for `{name:crew}` / `{name:ops}` (docs/05 "Генераторы"): `K. TANAKA`.
 *
 * Version 1 (recordings before T43): the region of the origin airport's ICAO prefix. Version 2
 * (T43, approved 2026-10-15): the country of the airline (OpenFlights, `ext/airline.ts`), else
 * the origin's country (VATSpy, live data), else the ICAO prefix as in version 1; one name in ten
 * from another region; airlines with crews of many nationalities draw every name from all
 * regions (`names.mix`, `context.ts`). Lists are the most common surnames, ASCII,
 * uppercase. Order of the lists and of the regions is part of the replay contract: append,
 * don't reorder.
 */

export const NAME_KINDS = ['crew', 'ops'] as const;
export type NameKind = (typeof NAME_KINDS)[number];

const words = (s: string): readonly string[] => s.split(' ');

const SURNAMES = {
  en: words(
    'SMITH JONES WILLIAMS BROWN TAYLOR DAVIES WILSON EVANS JOHNSON MILLER ANDERSON THOMPSON',
  ),
  de: words(
    'MUELLER SCHMIDT SCHNEIDER FISCHER WEBER MEYER WAGNER BECKER SCHULZ HOFFMANN KOCH RICHTER',
  ),
  fr: words('MARTIN BERNARD DUBOIS THOMAS ROBERT RICHARD PETIT DURAND LEROY MOREAU SIMON LAURENT'),
  es: words(
    'GARCIA RODRIGUEZ GONZALEZ FERNANDEZ LOPEZ MARTINEZ SANCHEZ PEREZ GOMEZ JIMENEZ RUIZ DIAZ',
  ),
  it: words('ROSSI RUSSO FERRARI ESPOSITO BIANCHI ROMANO COLOMBO RICCI MARINO GRECO BRUNO GALLO'),
  ru: words(
    'IVANOV SMIRNOV KUZNETSOV POPOV VASILIEV PETROV SOKOLOV MIKHAILOV NOVIKOV FEDOROV MOROZOV VOLKOV',
  ),
  jp: words(
    'SATO SUZUKI TAKAHASHI TANAKA WATANABE ITO YAMAMOTO NAKAMURA KOBAYASHI KATO YOSHIDA YAMADA',
  ),
  tw: words('CHEN LIN HUANG CHANG LI WANG WU LIU TSAI YANG HSU CHENG'),
  cn: words('WANG LI ZHANG LIU CHEN YANG ZHAO HUANG ZHOU WU XU SUN'),
  kr: words('KIM LEE PARK CHOI JUNG KANG CHO YOON JANG LIM HAN OH'),
  // T43 regions, each with its source (checked 2026-10-15); diacritics dropped (Ä → A, Ł → L).
  // Digi- ja väestötietovirasto (DVV), Sukunimitilasto 2026-08-04 (avoindata.fi, CC BY 4.0):
  // living Finnish citizens, top 12.
  fi: words(
    'KORHONEN VIRTANEN MAKINEN NIEMINEN MAKELA HAMALAINEN LAINE HEIKKINEN KOSKINEN JARVINEN LEHTONEN LEHTINEN',
  ),
  // SCB, "Efternamn som slutar på -son klart vanligast" (population 2021-12-31): the ten -son
  // names the article names as the most common; Andersson first.
  se: words(
    'ANDERSSON JOHANSSON KARLSSON ERIKSSON NILSSON LARSSON JONSSON OLSSON SVENSSON PETTERSSON',
  ),
  // SSB, "Etternavn brukt av 200 eller flere" (ssb.no/375410, year not stated): top 12.
  no: words(
    'HANSEN JOHANSEN OLSEN LARSEN ANDERSEN PEDERSEN NILSEN KRISTIANSEN JENSEN KARLSEN JOHNSEN PETTERSEN',
  ),
  // Danmarks Statistik, Nyt 2016-01-14 (population 2016-01-01): the top 5 it names.
  dk: words('NIELSEN JENSEN HANSEN PEDERSEN ANDERSEN'),
  // Meertens Instituut, 2003 (via Onze Taal, "De frequentste achternamen"): top 10.
  nl: words('DE_JONG DE_VRIES JANSEN VAN_DEN_BERG BAKKER VAN_DIJK VISSER JANSSEN SMIT MEIJER'),
  // PESEL register, male surnames of living persons, 2026-01-20 (dane.gov.pl, CC0): top 12;
  // the male forms stand for both.
  pl: words(
    'NOWAK KOWALSKI WISNIEWSKI WOJCIK KOWALCZYK KAMINSKI LEWANDOWSKI ZIELINSKI WOZNIAK SZYMANSKI DABROWSKI KOZLOWSKI',
  ),
  // US Census Bureau, Frequently Occurring Surnames from the 2010 Census: top 10.
  us: words('SMITH JOHNSON WILLIAMS BROWN JONES GARCIA MILLER DAVIS RODRIGUEZ MARTINEZ'),
};

export type Region = keyof typeof SURNAMES;
/** All regions in a fixed order (multinational crews draw from these). */
export const REGIONS = Object.keys(SURNAMES) as readonly Region[];

/**
 * Country (as OpenFlights / VATSpy name it) → region. Countries without a list of their own
 * are absent: the next source of the region is used.
 */
const COUNTRIES: Readonly<Record<string, Region>> = {
  Finland: 'fi',
  Sweden: 'se',
  Norway: 'no',
  Denmark: 'dk',
  Netherlands: 'nl',
  Poland: 'pl',
  'United States': 'us',
  Germany: 'de',
  Austria: 'de',
  France: 'fr',
  Spain: 'es',
  Italy: 'it',
  Russia: 'ru',
  Japan: 'jp',
  Taiwan: 'tw',
  China: 'cn',
  'Hong Kong': 'cn',
  Macau: 'cn',
  'South Korea': 'kr',
  'United Kingdom': 'en',
};

export function countryRegion(country: string | null): Region | null {
  return country === null ? null : (COUNTRIES[country] ?? null);
}

/**
 * Airlines whose crews come from many countries (T43): Emirates (140+ nationalities, 2023),
 * Etihad (~150, 2025), Qatar Airways (50+, 2004). No open statistics of the mix by country:
 * every region is equally likely (assumption).
 */
export const MULTINATIONAL_AIRLINES: ReadonlySet<string> = new Set(['UAE', 'ETD', 'QTR']);

/** `names.mix`: `none` (version 1), `some` (one in ten from elsewhere), `all`. */
export type NameMix = 'none' | 'some' | 'all';

/** ICAO location prefix → region; the longest matching prefix wins. Default `en`. */
const PREFIXES: Readonly<Record<string, Region>> = {
  ED: 'de',
  ET: 'de',
  LO: 'de',
  LF: 'fr',
  LE: 'es',
  LI: 'it',
  U: 'ru',
  RJ: 'jp',
  RO: 'jp',
  RC: 'tw',
  Z: 'cn',
  VH: 'cn',
  VM: 'cn',
  RK: 'kr',
};

const INITIALS = 'ABCDEGHJKLMNPRST';

function isRegion(r: string): r is Region {
  return r in SURNAMES;
}

export function regionOf(icao: string): Region {
  return PREFIXES[icao.slice(0, 2)] ?? PREFIXES[icao.slice(0, 1)] ?? 'en';
}

/**
 * `K. TANAKA` of `region` (`names.region`; unknown → by the ICAO prefix of `origIcao`). With
 * mix `none` the draws are those of version 1: initial, surname.
 */
export function personName(
  _kind: NameKind,
  origIcao: string,
  rng: Rng,
  region: string | null = null,
  mix: NameMix = 'none',
): string {
  let r: Region = region !== null && isRegion(region) ? region : regionOf(origIcao);
  if (mix === 'all') r = rng.pick(REGIONS);
  else if (mix === 'some' && rng.int(1, 10) === 1) {
    r = rng.pick(REGIONS.filter((x) => x !== r));
  }
  return `${rng.pick([...INITIALS])}. ${rng.pick(SURNAMES[r]).replaceAll('_', ' ')}`;
}
