// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * "On this day in aviation history" (T29, docs/07): facts with a primary or institutional source
 * and the date it was checked. A fact goes out when its day and month are today's UTC date;
 * several on one day — one chosen from the seed (approved 2026-10-09).
 */
export interface AviationFact {
  /** `MM-DD` (UTC date of the event as the source gives it). */
  readonly day: string;
  readonly year: number;
  /** Upper-case telex text without the year. */
  readonly text: string;
  /** Short source for the telex, `SMITHSONIAN NASM`. */
  readonly source: string;
  readonly url: string;
  readonly checked: string;
}

const NASM = 'SMITHSONIAN NASM';
const BOEING = 'BOEING HISTORY';
const BOEING_URL =
  'https://www.boeing.com/content/dam/boeing/v2/company/history/pdf/Boeing_Products.pdf';
const ICAO = 'ICAO';
const ICAO_URL = 'https://www.icao.int/history-icao-and-chicago-convention';
const AIRBUS = 'AIRBUS';
const C = '2026-10-09';

/**
 * Sources (all checked 2026-10-09): Smithsonian National Air and Space Museum collection pages;
 * Boeing "Select Products in Boeing History" (first-flight dates — the first column of each
 * product's data table, or the text); ICAO "The History of ICAO and the Chicago Convention";
 * Airbus newsroom. Dates as the source gives them (local dates of the event).
 */
export const AVIATION_HISTORY: readonly AviationFact[] = [
  {
    day: '12-17',
    year: 1903,
    text: 'WRIGHT FLYER, FIRST POWERED FLIGHT AT KITTY HAWK, 12 SECONDS, 120 FT, ORVILLE WRIGHT AT THE CONTROLS',
    source: NASM,
    url: 'https://airandspace.si.edu/collection-objects/1903-wright-flyer/nasm_A19610048000',
    checked: C,
  },
  {
    day: '10-14',
    year: 1947,
    text: 'BELL X-1 GLAMOROUS GLENNIS IS THE FIRST AIRPLANE TO FLY FASTER THAN THE SPEED OF SOUND',
    source: NASM,
    url: 'https://airandspace.si.edu/collection-objects/bell-x-1-glamorous-glennis/nasm_A19510007000',
    checked: C,
  },
  {
    day: '05-20',
    year: 1927,
    text: 'LINDBERGH TAKES OFF FROM NEW YORK ALONE IN THE SPIRIT OF ST. LOUIS, 33 H 30 MIN LATER LANDS AT LE BOURGET',
    source: NASM,
    url: 'https://airandspace.si.edu/collection-objects/ryan-nyp-spirit-st-louis-charles-lindbergh/nasm_A19280021000',
    checked: C,
  },
  {
    day: '12-07',
    year: 1944,
    text: 'CHICAGO CONFERENCE ENDS, 52 STATES SIGN THE CONVENTION ON INTERNATIONAL CIVIL AVIATION',
    source: ICAO,
    url: ICAO_URL,
    checked: C,
  },
  {
    day: '04-04',
    year: 1947,
    text: 'THE CHICAGO CONVENTION COMES INTO FORCE, PICAO BECOMES ICAO',
    source: ICAO,
    url: ICAO_URL,
    checked: C,
  },
  {
    day: '12-20',
    year: 1957,
    text: 'FIRST FLIGHT OF THE BOEING 707-120',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '02-09',
    year: 1963,
    text: 'FIRST FLIGHT OF THE BOEING 727',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '04-09',
    year: 1967,
    text: 'FIRST FLIGHT OF THE BOEING 737',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '02-09',
    year: 1969,
    text: 'FIRST FLIGHT OF THE BOEING 747',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '09-26',
    year: 1981,
    text: 'FIRST FLIGHT OF THE BOEING 767',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '02-19',
    year: 1982,
    text: 'FIRST FLIGHT OF THE BOEING 757',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '06-12',
    year: 1994,
    text: 'FIRST FLIGHT OF THE BOEING 777',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '12-15',
    year: 2009,
    text: 'BOEING 787 DREAMLINER FIRST FLIGHT FROM PAINE FIELD TO BOEING FIELD',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '09-26',
    year: 2011,
    text: 'FIRST BOEING 787 DREAMLINER DELIVERED TO LAUNCH CUSTOMER ANA',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '03-20',
    year: 2011,
    text: 'FIRST FLIGHT OF THE BOEING 747-8 INTERCONTINENTAL',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '12-17',
    year: 1935,
    text: 'FIRST FLIGHT OF THE DOUGLAS DC-3',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '05-30',
    year: 1958,
    text: 'FIRST FLIGHT OF THE DOUGLAS DC-8, THE FIRST DOUGLAS JET TRANSPORT',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '02-25',
    year: 1965,
    text: 'FIRST FLIGHT OF THE DOUGLAS DC-9',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '08-29',
    year: 1970,
    text: 'FIRST FLIGHT OF THE MCDONNELL DOUGLAS DC-10',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '11-02',
    year: 1947,
    text: 'HOWARD HUGHES LIFTS THE H-4 FLYING BOAT OFF LONG BEACH HARBOR FOR ITS ONLY FLIGHT, ABOUT 1 MILE',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '03-17',
    year: 1924,
    text: 'FOUR DOUGLAS WORLD CRUISERS LEAVE SANTA MONICA FOR SEATTLE TO ATTEMPT THE FIRST FLIGHT AROUND THE GLOBE',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '07-01',
    year: 1927,
    text: 'BOEING MODEL 40A MAIL PLANES START AIRMAIL SERVICE SAN FRANCISCO - CHICAGO',
    source: BOEING,
    url: BOEING_URL,
    checked: C,
  },
  {
    day: '10-28',
    year: 1972,
    text: 'AIRBUS A300B1, THE FIRST TWIN-ENGINED WIDEBODY AIRLINER, MAKES ITS FIRST FLIGHT FROM TOULOUSE',
    source: AIRBUS,
    url: 'https://www.airbus.com/en/newsroom/stories/2022-10-28-october-50th-anniversary-of-the-first-flight-of-the-airbus-a300',
    checked: C,
  },
  {
    day: '02-22',
    year: 1987,
    text: 'FIRST FLIGHT OF THE AIRBUS A320, THE FIRST AIRLINER WITH DIGITAL FLY-BY-WIRE CONTROLS',
    source: AIRBUS,
    url: 'https://www.airbus.com/en/newsroom/news/2017-02-30-years-youngand-still-going-strong',
    checked: C,
  },
  {
    day: '04-27',
    year: 2005,
    text: 'FIRST FLIGHT OF THE AIRBUS A380 FROM TOULOUSE-BLAGNAC',
    source: AIRBUS,
    url: 'https://www.airbus.com/en/newsroom/press-releases/2005-04-a380-worlds-largest-commercial-aircraft-successfully-takes-to-the',
    checked: C,
  },
];
