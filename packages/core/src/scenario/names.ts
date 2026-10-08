import type { Rng } from '../random/rng.js';

/**
 * Person names for `{name:crew}` / `{name:ops}` (docs/05 "Генераторы"): `K. TANAKA`.
 *
 * docs/05 asks for names "by the airline's country"; the OFP has no airline country, so
 * the origin airport's ICAO region stands in for it. Lists are the most common surnames
 * of each region (public statistics), ASCII, uppercase. Order is part of the replay
 * contract: append, don't reorder.
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
};

type Region = keyof typeof SURNAMES;

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

export function regionOf(icao: string): Region {
  return PREFIXES[icao.slice(0, 2)] ?? PREFIXES[icao.slice(0, 1)] ?? 'en';
}

export function personName(_kind: NameKind, origIcao: string, rng: Rng): string {
  return `${rng.pick([...INITIALS])}. ${rng.pick(SURNAMES[regionOf(origIcao)])}`;
}
