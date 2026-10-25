import type { Ofp } from '../ofp/types.js';

/**
 * Night curfews of destinations (T42 item 4, docs/07): airports where landings are banned for
 * part of the night, each with its source and the date it was checked. Only the hours are taken
 * from the documents, no text. Approved 2026-10-25: airports with night quotas or noise limits
 * only (EGCC, EGLL, EHAM, EDDM) are not curfews and are left out; so are airports without an
 * official source (EDDS, EDDL, BER, RKSS: secondary or conflicting sources only). No entry, no
 * curfew message.
 */
export interface CurfewRule {
  /** Local `HH:MM`: the latest scheduled landing; the curfew starts here. */
  readonly start: string;
  /** Late arrivals may still land this many minutes after `start` (delay allowance). */
  readonly allowanceMin: number;
}

export interface Curfew {
  readonly icao: string;
  readonly rule: CurfewRule;
  /** Other hours on a weekday of the local date of `start`, 0 = Sunday. */
  readonly days?: Readonly<Partial<Record<number, CurfewRule>>>;
  /** Other hours for an arrival from abroad: origin ICAO prefix differs from the airport's. */
  readonly intl?: CurfewRule;
  /** What the rule leaves out (approved simplifications). */
  readonly note?: string;
  readonly source: string;
  readonly url: string;
  readonly checked: string;
}

export const CURFEWS: readonly Curfew[] = [
  {
    icao: 'YSSY',
    rule: { start: '23:00', allowanceMin: 0 },
    source: 'Sydney Airport Curfew Act 1995; DITRDCSA curfew brief',
    url: 'https://www.infrastructure.gov.au/infrastructure-transport-vehicles/vehicles/aviation/environmental/curfews/SydneyAirport/SydneyCurfewBrief',
    checked: '2026-10-25',
  },
  {
    icao: 'YPAD',
    rule: { start: '23:00', allowanceMin: 0 },
    source: 'Adelaide Airport Curfew Act 2000; Adelaide Airport curfew information',
    url: 'https://corporate.adelaideairport.com.au/?p=744',
    checked: '2026-10-25',
  },
  {
    icao: 'EDDF',
    // Scheduled before 23:00, delayed: may land until 00:00 without a permit.
    rule: { start: '23:00', allowanceMin: 60 },
    source: 'Hessisches Wirtschaftsministerium, FAQ Nachtfluege (Planfeststellungsbeschluss 2007)',
    url: 'https://wirtschaft.hessen.de/sites/wirtschaft.hessen.de/files/2021-07/18-08-29_faq_nachtfluege_online_0.pdf',
    checked: '2026-10-25',
  },
  {
    icao: 'EDDH',
    rule: { start: '23:00', allowanceMin: 60 },
    source: 'Hamburg Airport, Bericht Nachtflugbeschraenkung 2026-07',
    url: 'https://www.hamburg-airport.de/resource/blob/94866/dcbbcac9616de93ce9c1cfefa4dae7cf/bericht-nachtflugbeschraenkung-2026-07-data.pdf',
    checked: '2026-10-25',
  },
  {
    icao: 'LSZH',
    // Scheduled operations until 23:00, delays until 23:30 without a permit.
    rule: { start: '23:00', allowanceMin: 30 },
    source: 'Flughafen Zuerich, Betriebszeiten (2025)',
    url: 'https://www.flughafen-zuerich.ch/de/unternehmen/magazin/2025/politik_betriebszeiten',
    checked: '2026-10-25',
  },
  {
    icao: 'LSGG',
    // Arrivals banned 00:00-05:00 (VIL 748.131.1).
    rule: { start: '00:00', allowanceMin: 0 },
    source: 'Slot Coordination Switzerland, restrictions Geneva',
    url: 'https://www.slotcoordination.ch/restrictions_gva',
    checked: '2026-10-25',
  },
  {
    icao: 'EGLC',
    // Delays: 22:00-22:30 Sunday to Friday, 12:30-13:00 on Saturday.
    rule: { start: '22:00', allowanceMin: 30 },
    days: { 6: { start: '12:30', allowanceMin: 30 } },
    note: 'bank holiday hours and the 25 December closure are not modelled',
    source: 'ACL, LCY Local Rules (planning conditions), October 2024',
    url: 'https://acl-uk.org/wp-content/uploads/2025/01/LCY-Local-Rules.pdf',
    checked: '2026-10-25',
  },
  {
    icao: 'LFPO',
    rule: { start: '23:30', allowanceMin: 0 },
    source: 'Assemblee nationale, reponse 15/QE1167 (decision ministerielle 1968-04-04)',
    url: 'https://www2.assemblee-nationale.fr/questions/detail/15/qe/1167/(vue)/pdf',
    checked: '2026-10-25',
  },
  {
    icao: 'NZWN',
    // Delayed flights: 30 more minutes.
    rule: { start: '00:00', allowanceMin: 30 },
    intl: { start: '01:00', allowanceMin: 30 },
    note: 'the 60 min later start on statutory holidays is not modelled',
    source: 'Wellington Airport, curfew (Noise Management Plan)',
    url: 'https://www.wellingtonairport.co.nz/community-hub/noise/wellington-airport-curfew/',
    checked: '2026-10-25',
  },
  {
    icao: 'CYTZ',
    rule: { start: '23:00', allowanceMin: 0 },
    source: 'Billy Bishop Airport, noise management policies (Tripartite Agreement)',
    url: 'https://www.billybishopairport.com/community/noise-management-program/noise-management-policies/',
    checked: '2026-10-25',
  },
  {
    icao: 'KSNA',
    rule: { start: '23:00', allowanceMin: 0 },
    source: 'City of Newport Beach, John Wayne Airport curfew (County Ordinance 85-255)',
    url: 'https://www.newportbeachca.gov/home/showpublisheddocument?id=64438',
    checked: '2026-10-25',
  },
  {
    icao: 'RJOO',
    rule: { start: '21:00', allowanceMin: 0 },
    source: 'MLIT press release 2018 (Itami operating hours 07:00-21:00)',
    url: 'https://www.mlit.go.jp/report/press/kouku18_hh_000035.html',
    checked: '2026-10-25',
  },
  {
    icao: 'RJFF',
    rule: { start: '22:00', allowanceMin: 0 },
    source: 'Fukuoka City, airport pamphlet (operating hours 07:00-22:00)',
    url: 'https://www.city.fukuoka.lg.jp/kowan/kukotaisaku/shisei/documents/pamphlet1.pdf',
    checked: '2026-10-25',
  },
];

const MIN = 60_000;
const DAY = 86_400_000;

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Latest landing (epoch ms UTC) of the first curfew after the scheduled landing at the
 * destination: start of the rule + allowance. Null without an entry or a UTC offset. A flight
 * scheduled inside the curfew gets the next night's, far ahead, so no message (approved).
 */
export function latestLanding(ofp: Ofp): number | null {
  const dest = ofp.destination;
  const entry = CURFEWS.find((c) => c.icao === dest.icao);
  const offsetH = dest.utcOffsetH;
  if (entry === undefined || offsetH === null) return null;
  const t = ofp.times;
  const on = t.schedOnMs ?? t.schedInMs - (t.taxiInSec ?? 300) * 1000;
  // Local wall clock as if it were UTC.
  const onLocal = on + offsetH * 3_600_000;
  const intl = entry.intl !== undefined && !ofp.origin.icao.startsWith(dest.icao.slice(0, 2));
  const dayStart = Math.floor(onLocal / DAY) * DAY;
  for (const day of [dayStart, dayStart + DAY]) {
    // 1970-01-01 was a Thursday.
    const weekday = (day / DAY + 4) % 7;
    const rule = (intl ? entry.intl : entry.days?.[weekday]) ?? entry.rule;
    const start = day + minutesOf(rule.start) * MIN;
    if (start > onLocal) return start + rule.allowanceMin * MIN - offsetH * 3_600_000;
  }
  return null;
}
