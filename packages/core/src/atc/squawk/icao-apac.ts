// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * ICAO Asia and Pacific Regions Air Navigation Plan (eANP), Volume II, Part IV (ATM),
 * Table ATM II-APAC-2 "SSR Codes Allocation Plan of the Asia and Pacific Regions", pages IV-28
 * to IV-31 (amendments up to APAC-II 24/04, February 2026), document of July 2026:
 * https://www.icao.int/sites/default/files/APAC/APAC-ANP/APAC-new-eANP-Vol-II_July-2026.pdf,
 * taken 2026-10-09. GENERATED — do not edit by hand. © ICAO: [VERIFY] reuse terms before a
 * public release (docs/08, decision 9; approved for personal use 2026-10-09, docs/07 T24).
 *
 * Block: first code, last code (octal), `I` international or `D` domestic, restriction note
 * (11–16 of the table, such blocks are not used: 11 not in western Fukuoka FIR, 12 not
 * southbound, 13 eastbound/northeast bound only, 14 not in north-eastern Australia, 15 only to
 * China, Manila and Taipei FIRs, 16 not to or over the Fukuoka FIR). Notes 1–10 are applied:
 * they narrow a block to a range (1 = 1600–1637 … 10 = 6450–6477; 4/5 = xx00 international,
 * xx01–xx07 domestic). A full block `0100`–`0177` includes its xx00 code; the selector never
 * hands out codes ending in 00. Note `*`: all codes are available for domestic use in Australia
 * and New Zealand except where indicated. No codes are issued for the Auckland Oceanic,
 * Anchorage and Oakland Oceanic, Honiara, Nauru and Sanya FIRs.
 *
 * `firs`: FIR ids of the airports in that FIR as VATSpy.dat v2610.1 `[Airports]` names them
 * (Australia: the VATSpy sectors named "Brisbane (…)" / "Melbourne (…)"; Japan: the ACC areas
 * of the Fukuoka FIR) — approved mapping, docs/07 T24.
 */

export const ICAO_APAC_VERSION = 'eANP Vol II Table ATM II-APAC-2 (APAC-II 24/04, 2026-02)';

export interface ApacFir {
  readonly firs: readonly string[];
  readonly blocks: readonly (readonly [string, string, 'I' | 'D', string | null])[];
}

export const ICAO_APAC_FIRS: Readonly<Record<string, ApacFir>> = {
  BANGKOK: {
    firs: ['VTBB'],
    blocks: [
      ['0700', '0777', 'I', null],
      ['1001', '1077', 'D', null],
      ['1100', '1177', 'D', null],
      ['1200', '1277', 'D', null],
      ['1300', '1377', 'D', null],
      ['1400', '1477', 'D', null],
      ['3300', '3377', 'D', null],
      ['4200', '4277', 'D', null],
      ['4300', '4377', 'D', null],
      ['4400', '4477', 'D', null],
      ['4500', '4577', 'D', null],
      ['6100', '6177', 'I', null],
      ['7200', '7277', 'D', null],
    ],
  },
  BEIJING: {
    firs: ['ZBPE'],
    blocks: [
      ['0001', '0077', 'I', null],
      ['0600', '0677', 'D', null],
      ['2300', '2377', 'D', null],
      ['3000', '3077', 'I', null],
      ['3400', '3477', 'D', null],
    ],
  },
  BRISBANE: {
    firs: [
      'YARA',
      'YARL',
      'YASH',
      'YBAR',
      'YBUR',
      'YCNK',
      'YCOL',
      'YCVN',
      'YDEN',
      'YDOS',
      'YFLD',
      'YGAH',
      'YGOL',
      'YHWE',
      'YIND',
      'YINE',
      'YINL',
      'YINS',
      'YISA',
      'YKEN',
      'YKIY',
      'YKPL',
      'YLIG',
      'YMLD',
      'YMNN',
      'YMOR',
      'YNSA',
      'YOCN',
      'YRYS',
      'YSDY',
      'YSTR',
      'YSWY',
      'YTBP',
      'YTRS',
      'YTRT',
      'YTSN',
      'YWEG',
      'YWIL',
    ],
    blocks: [
      ['0300', '0377', 'I', '14'],
      ['0400', '0477', 'I', '14'],
      ['1001', '1077', 'I', null],
      ['1100', '1177', 'I', null],
      ['1200', '1277', 'I', null],
    ],
  },
  CHENNAI: {
    firs: ['VOMF'],
    blocks: [
      ['0200', '0277', 'D', null],
      ['0600', '0677', 'I', null],
      ['2700', '2777', 'D', null],
      ['3300', '3377', 'D', null],
    ],
  },
  COLOMBO: {
    firs: ['VCCF'],
    blocks: [
      ['4000', '4077', 'D', null],
      ['7300', '7377', 'I', null],
    ],
  },
  DELHI: {
    firs: ['VIDF'],
    blocks: [
      ['0200', '0277', 'D', null],
      ['0500', '0577', 'I', null],
      ['3300', '3377', 'D', null],
      ['6300', '6377', 'D', null],
    ],
  },
  DHAKA: {
    firs: ['VGFR'],
    blocks: [
      ['4100', '4177', 'D', null],
      ['4700', '4777', 'I', null],
      ['5500', '5577', 'D', null],
      ['5600', '5677', 'D', null],
    ],
  },
  FUKUOKA: {
    firs: ['RJBG', 'RJDG', 'RJTG'],
    blocks: [
      ['0400', '0477', 'D', null],
      ['1001', '1077', 'D', null],
      ['1100', '1177', 'D', null],
      ['1200', '1277', 'D', null],
      ['1300', '1377', 'D', null],
      ['1400', '1477', 'D', null],
      ['1500', '1577', 'D', null],
      ['1700', '1777', 'D', null],
      ['2001', '2077', 'D', null],
      ['2100', '2177', 'D', null],
      ['2200', '2277', 'D', null],
      ['2300', '2377', 'D', null],
      ['2400', '2477', 'D', null],
      ['2500', '2577', 'D', null],
      ['3100', '3177', 'I', '13'],
      ['3200', '3277', 'I', null],
      ['3300', '3377', 'D', null],
      ['3400', '3477', 'D', null],
      ['3600', '3677', 'I', null],
      ['3700', '3777', 'I', null],
      ['4600', '4677', 'D', null],
      ['4700', '4777', 'D', null],
      ['5200', '5277', 'D', '11'],
      ['5300', '5377', 'D', null],
      ['5400', '5477', 'D', null],
      ['5500', '5577', 'D', null],
      ['5600', '5677', 'D', null],
      ['5700', '5777', 'D', null],
      ['6000', '6077', 'I', null],
      ['6100', '6177', 'I', '13'],
      ['6200', '6277', 'D', null],
      ['6400', '6477', 'D', null],
      ['7000', '7077', 'I', '13'],
      ['7300', '7377', 'D', null],
    ],
  },
  GUANGZHOU: {
    firs: ['ZGZU'],
    blocks: [
      ['0600', '0677', 'D', null],
      ['2400', '2477', 'D', null],
      ['3100', '3177', 'I', null],
      ['3400', '3477', 'D', null],
      ['4500', '4577', 'D', null],
    ],
  },
  HANOI: {
    firs: ['VVHN'],
    blocks: [
      ['1700', '1777', 'I', null],
      ['4100', '4177', 'D', null],
      ['4600', '4677', 'D', null],
      ['7000', '7077', 'I', null],
    ],
  },
  'HO CHI MINH': {
    firs: ['VVHM'],
    blocks: [
      ['5500', '5577', 'I', null],
      ['5600', '5677', 'I', null],
      ['5700', '5777', 'D', null],
      ['6000', '6077', 'D', null],
    ],
  },
  'HONG KONG, CHINA': {
    firs: ['VHHK'],
    blocks: [
      ['3300', '3377', 'I', '15'],
      ['3500', '3577', 'I', null],
      ['5100', '5177', 'I', null],
      ['5200', '5277', 'D', null],
      ['5300', '5377', 'I', null],
      ['5700', '5777', 'I', '16'],
    ],
  },
  INCHEON: {
    firs: ['RKDA', 'RKRR'],
    blocks: [
      ['0200', '0277', 'D', null],
      ['0300', '0377', 'D', null],
      ['1600', '1677', 'D', null],
      ['4100', '4177', 'I', null],
      ['4200', '4277', 'D', null],
      ['4300', '4377', 'I', '12'],
      ['4400', '4477', 'I', '12'],
      ['4500', '4577', 'D', null],
      ['5000', '5077', 'D', null],
      ['5100', '5177', 'D', null],
      ['5200', '5277', 'D', null],
      ['6600', '6677', 'D', null],
      ['6700', '6777', 'D', null],
      ['7100', '7177', 'I', null],
      ['7200', '7277', 'D', null],
      ['7400', '7477', 'D', null],
    ],
  },
  JAKARTA: {
    firs: ['WIIF'],
    blocks: [
      ['1700', '1777', 'D', null],
      ['2300', '2377', 'I', null],
      ['2400', '2477', 'I', null],
      ['2500', '2577', 'D', null],
      ['3300', '3377', 'D', null],
      ['4700', '4777', 'D', null],
      ['6200', '6277', 'D', null],
      ['6400', '6477', 'D', null],
      ['6700', '6777', 'I', null],
      ['7100', '7177', 'I', null],
      ['7200', '7277', 'D', null],
    ],
  },
  KABUL: {
    firs: ['OAKX'],
    blocks: [
      ['5300', '5377', 'D', null],
      ['7100', '7177', 'I', null],
    ],
  },
  KARACHI: {
    firs: ['OPKR'],
    blocks: [
      ['1300', '1377', 'D', null],
      ['3200', '3277', 'D', null],
      ['3400', '3477', 'D', null],
      ['4300', '4377', 'D', null],
      ['7200', '7277', 'I', null],
      ['7400', '7477', 'D', null],
    ],
  },
  KATHMANDU: {
    firs: ['VNSM'],
    blocks: [
      ['0100', '0177', 'D', null],
      ['2500', '2577', 'I', null],
    ],
  },
  KOLKATA: {
    firs: ['VECF'],
    blocks: [
      ['0200', '0277', 'D', null],
      ['0400', '0477', 'I', null],
      ['2600', '2677', 'D', null],
      ['3300', '3377', 'D', null],
    ],
  },
  'KOTA KINABALU': {
    firs: ['WBFC'],
    blocks: [
      ['0400', '0477', 'I', null],
      ['0500', '0577', 'D', null],
      ['2001', '2077', 'I', null],
      ['3100', '3177', 'D', null],
      ['5200', '5277', 'D', null],
    ],
  },
  'KUALA LUMPUR': {
    firs: ['WMFC'],
    blocks: [
      ['0300', '0377', 'D', null],
      ['2100', '2177', 'I', null],
      ['2600', '2677', 'I', null],
      ['3000', '3077', 'D', null],
      ['3400', '3477', 'D', null],
      ['4000', '4077', 'D', null],
      ['5100', '5177', 'D', null],
      ['5400', '5477', 'I', null],
    ],
  },
  KUNMING: {
    firs: ['ZPKM'],
    blocks: [
      ['2200', '2277', 'D', null],
      ['2300', '2377', 'D', null],
      ['6400', '6447', 'I', null],
      ['7300', '7377', 'D', null],
    ],
  },
  LAHORE: {
    firs: ['OPLR'],
    blocks: [
      ['0100', '0177', 'D', null],
      ['2001', '2077', 'D', null],
      ['3600', '3677', 'D', null],
      ['4200', '4277', 'D', null],
      ['4400', '4477', 'D', null],
      ['4500', '4577', 'I', null],
    ],
  },
  LANZHOU: {
    firs: ['ZLHW'],
    blocks: [
      ['1100', '1177', 'D', null],
      ['2100', '2177', 'D', null],
      ['6200', '6217', 'I', null],
    ],
  },
  MALE: {
    firs: ['VRMF'],
    blocks: [
      ['0200', '0277', 'D', null],
      ['7400', '7477', 'I', null],
    ],
  },
  MANILA: {
    firs: ['RPHI'],
    blocks: [
      ['0300', '0377', 'D', null],
      ['0600', '0677', 'D', null],
      ['2700', '2777', 'I', null],
      ['4000', '4077', 'D', null],
      ['4200', '4277', 'D', null],
      ['6500', '6577', 'I', null],
    ],
  },
  MELBOURNE: {
    firs: [
      'YASP',
      'YASW',
      'YAUG',
      'YBIK',
      'YBKE',
      'YBLA',
      'YDAL',
      'YELW',
      'YESP',
      'YFOR',
      'YGEL',
      'YGTH',
      'YGUN',
      'YGVE',
      'YHUO',
      'YHYD',
      'YJAR',
      'YKAT',
      'YLEA',
      'YLEO',
      'YMEK',
      'YMTK',
      'YMUN',
      'YMZI',
      'YNEW',
      'YOLW',
      'YOXL',
      'YPAR',
      'YPIY',
      'YPOT',
      'YSCR',
      'YSNO',
      'YTBD',
      'YWAR',
      'YWOL',
      'YWON',
      'YWRA',
      'YYWE',
    ],
    blocks: [
      ['1300', '1377', 'I', null],
      ['1400', '1477', 'I', null],
      ['1500', '1577', 'I', null],
    ],
  },
  MUMBAI: {
    firs: ['VABF'],
    blocks: [
      ['0200', '0277', 'D', null],
      ['0300', '0377', 'I', null],
      ['3300', '3377', 'D', null],
      ['6300', '6377', 'D', null],
    ],
  },
  NADI: {
    firs: ['NFFF', 'NFFJ'],
    blocks: [
      ['0500', '0577', 'I', null],
      ['3400', '3477', 'D', null],
    ],
  },
  'NEW ZEALAND': {
    firs: ['NZAA', 'NZCB', 'NZCK', 'NZCS', 'NZCT', 'NZOH'],
    blocks: [['0200', '0277', 'I', null]],
  },
  'PHNOM PENH': {
    firs: ['VDPF'],
    blocks: [
      ['1600', '1637', 'I', null],
      ['5010', '5077', 'D', null],
    ],
  },
  'PORT MORESBY': {
    firs: ['AYPM'],
    blocks: [
      ['0300', '0377', 'D', null],
      ['0400', '0477', 'D', null],
      ['7400', '7477', 'I', null],
    ],
  },
  PYONGYANG: {
    firs: ['ZKKP'],
    blocks: [
      ['0500', '0577', 'D', null],
      ['4000', '4077', 'I', null],
    ],
  },
  SHANGHAI: {
    firs: ['ZSHA'],
    blocks: [
      ['0100', '0177', 'I', null],
      ['0700', '0777', 'D', null],
      ['1001', '1077', 'D', null],
      ['2700', '2777', 'D', null],
      ['6300', '6377', 'I', null],
    ],
  },
  SHENYANG: {
    firs: ['ZYSH'],
    blocks: [
      ['1100', '1177', 'D', null],
      ['1200', '1277', 'I', null],
      ['2500', '2577', 'D', null],
      ['6450', '6477', 'I', null],
      ['7300', '7377', 'D', null],
    ],
  },
  SINGAPORE: {
    firs: ['WSJC'],
    blocks: [
      ['0001', '0077', 'D', null],
      ['0100', '0177', 'I', null],
      ['2200', '2277', 'I', null],
      ['4200', '4277', 'D', null],
      ['4300', '4377', 'D', null],
      ['4600', '4677', 'D', null],
    ],
  },
  TAHITI: {
    firs: ['NTTC', 'NTTT'],
    blocks: [['2600', '2677', 'I', null]],
  },
  TAIBEI: {
    firs: ['RCAA'],
    blocks: [
      ['0300', '0377', 'D', null],
      ['0600', '0677', 'D', null],
      ['1001', '1077', 'D', null],
      ['1100', '1177', 'D', null],
      ['1500', '1577', 'D', null],
      ['2001', '2077', 'D', null],
      ['2100', '2177', 'D', null],
      ['2600', '2677', 'I', null],
      ['4300', '4377', 'D', null],
      ['4400', '4477', 'D', null],
      ['4500', '4577', 'D', null],
      ['4600', '4677', 'D', null],
      ['6200', '6277', 'I', null],
      ['7200', '7277', 'D', null],
    ],
  },
  'UJUNG PANDANG': {
    firs: ['WAAF'],
    blocks: [
      ['1600', '1677', 'D', null],
      ['4100', '4177', 'I', null],
      ['4400', '4477', 'D', null],
      ['4500', '4577', 'D', null],
      ['4600', '4677', 'D', null],
      ['5000', '5077', 'I', null],
      ['5600', '5677', 'D', null],
      ['6300', '6377', 'D', null],
      ['6600', '6677', 'I', null],
      ['7000', '7077', 'I', null],
      ['7200', '7277', 'D', null],
    ],
  },
  'ULAAN BATAAR': {
    firs: ['ZMUB'],
    blocks: [
      ['0300', '0377', 'D', null],
      ['0400', '0477', 'D', null],
      ['4200', '4277', 'I', null],
      ['4400', '4477', 'D', null],
    ],
  },
  URUMQI: {
    firs: ['ZWUQ'],
    blocks: [
      ['1001', '1077', 'D', null],
      ['2300', '2377', 'D', null],
      ['4500', '4577', 'D', null],
      ['6220', '6237', 'I', null],
    ],
  },
  VIENTIANE: {
    firs: ['VLVT'],
    blocks: [
      ['0200', '0277', 'D', null],
      ['1640', '1677', 'I', null],
    ],
  },
  WUHAN: {
    firs: ['ZHWH'],
    blocks: [
      ['0300', '0377', 'D', null],
      ['1500', '1577', 'D', null],
      ['4000', '4077', 'D', null],
      ['6240', '6277', 'I', null],
    ],
  },
  YANGON: {
    firs: ['VYYF'],
    blocks: [
      ['5000', '5000', 'I', null],
      ['5001', '5007', 'D', null],
      ['5200', '5200', 'I', null],
      ['5201', '5207', 'D', null],
    ],
  },
};
