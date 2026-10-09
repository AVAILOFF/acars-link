/**
 * Air shows (T29, docs/07): dates and places from the shows' official sites, each with its source
 * and the date it was checked. A show is reported when the destination is within 50 km of the
 * venue and the local arrival date is one of the show days (approved 2026-10-09). Update once a
 * year; a show without published dates is left out.
 */
export interface AirShow {
  /** Upper-case ASCII, `FARNBOROUGH INTERNATIONAL AIRSHOW`. */
  readonly name: string;
  /** Venue, `FARNBOROUGH AIRPORT`. */
  readonly site: string;
  readonly lat: number;
  readonly lon: number;
  /** First and last day, local dates `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  /** Short source for the telex, `FARNBOROUGHAIRSHOW.COM`. */
  readonly source: string;
  /** Page the dates come from. */
  readonly url: string;
  readonly checked: string;
}

/**
 * Dates from the organisers' pages (checked 2026-10-09); venue positions — the aerodrome of the
 * show from OurAirports `airports.csv` (public domain). Left out: shows of 2026 already over,
 * Farnborough (no date of the next show published), Seoul ADEX 2027 (start only), Bahrain
 * International Airshow (no dates on the site). Third-party calendars disagreed with the
 * organisers (Airshow China: 10–15 Nov elsewhere, 7–13 Dec on airshow.com.cn) — not used.
 */
export const AIR_SHOWS: readonly AirShow[] = [
  {
    name: 'AIRSHOW CHINA (ZHUHAI)',
    site: 'ZHUHAI JINWAN',
    lat: 22.006399,
    lon: 113.375999,
    from: '2026-12-07',
    to: '2026-12-13',
    source: 'AIRSHOW.COM.CN',
    url: 'https://www.airshow.com.cn/',
    checked: '2026-10-09',
  },
  {
    name: 'AERO INDIA',
    site: 'AIR FORCE STATION YELAHANKA, BENGALURU',
    lat: 13.1355,
    lon: 77.606,
    from: '2027-02-08',
    to: '2027-02-12',
    source: 'AEROINDIA.GOV.IN',
    url: 'https://aeroindia.gov.in/',
    checked: '2026-10-09',
  },
  {
    name: 'AUSTRALIAN INTERNATIONAL AIRSHOW',
    site: 'AVALON AIRPORT, VICTORIA',
    lat: -38.040269,
    lon: 144.467196,
    from: '2027-02-23',
    to: '2027-02-28',
    source: 'AIRSHOW.COM.AU',
    url: 'https://www.airshow.com.au/',
    checked: '2026-10-09',
  },
  {
    name: 'PARIS AIR SHOW',
    site: 'PARIS-LE BOURGET',
    lat: 48.962276,
    lon: 2.436539,
    from: '2027-06-14',
    to: '2027-06-20',
    source: 'SIAE.FR',
    url: 'https://www.siae.fr/en/',
    checked: '2026-10-09',
  },
  {
    name: 'ROYAL INTERNATIONAL AIR TATTOO',
    site: 'RAF FAIRFORD',
    lat: 51.683568,
    lon: -1.789172,
    from: '2027-07-16',
    to: '2027-07-18',
    source: 'AIRTATTOO.COM',
    url: 'https://www.airtattoo.com/',
    checked: '2026-10-09',
  },
  {
    name: 'EAA AIRVENTURE OSHKOSH',
    site: 'WITTMAN REGIONAL AIRPORT, OSHKOSH',
    lat: 43.9844,
    lon: -88.557,
    from: '2027-07-26',
    to: '2027-08-01',
    source: 'EAA.ORG',
    url: 'https://www.eaa.org/eaa/about-eaa/eaa-media-room/airventure-news-releases/airventure-dates-through-2029',
    checked: '2026-10-09',
  },
  {
    name: 'DUBAI AIRSHOW',
    site: 'DUBAI WORLD CENTRAL',
    lat: 24.896171,
    lon: 55.16235,
    from: '2027-11-15',
    to: '2027-11-19',
    source: 'DUBAIAIRSHOW.AERO',
    url: 'https://www.dubaiairshow.aero/',
    checked: '2026-10-09',
  },
];
