# SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
# Copyright (c) 2026 AVAILOFF

"""Generates packages/core/src/atc/squawk/{eur-cal,faa-nbcap,icao-apac}.ts from the sources.

Step 2: python -I generate.py <dir> packages/core/src/atc/squawk  (see README.md)

Inputs in <dir>: cal.xls (EUROCONTROL CAL v4.13), nbcap-b3.json (parsed FAA JO 7110.66H
TBL B-3), apac-cells.json (parsed ICAO APAC eANP Vol II Table ATM II-APAC-2), VATSpy.dat.
"""
import json
import re
import sys

import xlrd

# Licence header of every source file (T62, tools/spdx/header.mjs).
HEADER = [
    "// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary",
    "// Copyright (c) 2026 AVAILOFF",
    "",
]

dl, out = sys.argv[1], sys.argv[2]


def oct2(v):
    v = str(v).strip()
    return None if v == '' else str(int(float(v))).zfill(2)


# ---------------- EUROCONTROL CAL ----------------
b = xlrd.open_workbook(f'{dl}/cal.xls')
s = b.sheet_by_name('CAL')
ps = b.sheet_by_name('PAs')
pas = {}
for i in range(ps.nrows):
    name = str(ps.row(i)[0].value).strip()
    if name:
        pas[name] = str(ps.row(i)[1].value).split()
rows = []
for r in range(1, s.nrows):
    c = [str(x.value).strip() for x in s.row(r)]
    series, frm, to = oct2(c[0]), oct2(c[1]), oct2(c[2])
    if c[8] != 'A' or c[5] not in ('CIV', 'CIV_MIL', '') or c[6] != 'ENR':
        continue
    rows.append([series + frm, series + to, c[3], ' '.join(c[4].split()), ' '.join(c[9].split()),
                 ' '.join(c[10].split()), ' '.join(c[11].split())])
rows.sort()
lines = HEADER + [
    "/**",
    " * EUROCONTROL, Secondary Surveillance Radar Code Allocation List for the ICAO EUR Region (CAL),",
    " * attachment to ICAO EUR Doc 023, version 4.13, published 2026-03-04,",
    " * https://www.eurocontrol.int/publication/secondary-surveillance-radar-code-allocation-list-icao-eur-region-cal",
    " * (file eurocontrol-icao-eur-cal-v4-13.xls), taken 2026-10-09. GENERATED — do not edit by hand.",
    " *",
    " * Only the rows a departure can get a code from: assignment (`A/R` = A), civil (`CIV`, `CIV_MIL`,",
    " * empty), en-route (`ENR`). Row: first code, last code (octal, inclusive), participating area,",
    " * assigning units (state prefixes, ICAO units, CCAMS states), destinations, via, protection —",
    " * the last three as space-separated tokens (`ALL`, prefixes, PA names, 1-letter regions).",
    " * Reuse terms of the CAL are not stated on the page: [VERIFY] before a public release",
    " * (docs/08, decision 9; approved for personal use 2026-10-09, docs/07 T24).",
    " */",
    "",
    "export const EUR_CAL_VERSION = '4.13 (2026-03-04)';",
    "",
    "/** Participating areas (sheet `PAs`): name → member states / units. */",
    "export const EUR_CAL_PAS: Readonly<Record<string, readonly string[]>> = {",
]
for k, v in pas.items():
    lines.append(f"  '{k}': [{', '.join(repr(x) for x in v)}],".replace('"', "'"))
lines += ["};", "",
          "/** `[from, to, pa, units, destinations, via, protection]`. */",
          "export const EUR_CAL_ROWS: readonly (readonly [string, string, string, string, string, string, string])[] = ["]
for r in rows:
    lines.append('  [' + ', '.join("'" + x + "'" for x in r) + '],')
lines += ['];', '']
open(f'{out}/eur-cal.ts', 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
print('CAL rows', len(rows))

# ---------------- FAA NBCAP ----------------
nb = json.load(open(f'{dl}/nbcap-b3.json'))
lines = HEADER + [
    "/**",
    " * FAA Order JO 7110.66H, National Beacon Code Allocation Plan (NBCAP), 2024-05-06, Appendix B,",
    " * TBL B-3 \"ARTCC Assignments\",",
    " * https://www.faa.gov/documentLibrary/media/Order/2024-04-04_Order_JO_7110.66H_National_Beacon_Code_Allocation_Plan_(NBCAP)_FINAL.pdf,",
    " * taken 2026-10-09. US Government work (public domain). GENERATED — do not edit by hand.",
    " *",
    " * Row: first code, last code or null (a full block: `2600` = 2601–2677, paragraph 8.d; the",
    " * non-discrete base code is normally not assigned), category/priority as printed: E external,",
    " * I internal, M military, S special use; P/S/T primary/secondary/tertiary, `-n` adaptation",
    " * sequence (TBL B-1, B-2). `ATOP` = oceanic automation.",
    " */",
    "",
    "export const FAA_NBCAP_VERSION = 'JO 7110.66H (2024-05-06)';",
    "",
    "export const FAA_NBCAP_ARTCC: Readonly<Record<string, readonly (readonly [string, string | null, string])[]>> = {",
]
for k in sorted(nb):
    lines.append(f"  {k}: [")
    for r in nb[k]:
        to = 'null' if r['to'] is None else f"'{r['to']}'"
        lines.append(f"    ['{r['from']}', {to}, '{r['priority']}'],")
    lines.append("  ],")
lines += ["};", ""]
open(f'{out}/faa-nbcap.ts', 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
print('NBCAP ARTCCs', len(nb))

# ---------------- ICAO APAC ----------------
cells = json.load(open(f'{dl}/apac-cells.json'))
NOTES = {  # footnotes 1-10: code ranges inside the block
    '1': ('1600', '1637'), '2': ('1640', '1677'), '3': ('5010', '5077'),
    '6': ('6200', '6217'), '7': ('6220', '6237'), '8': ('6240', '6277'),
    '9': ('6400', '6447'), '10': ('6450', '6477'),
}
RESTRICT = {'11', '12', '13', '14', '15', '16'}
apac = {}
for fir, cs in cells.items():
    out_blocks = []
    for c in cs:
        cell = c['cell'].replace(' ', '')
        frm, to = c['from'], c['to']
        if cell in ('I(4)D', 'I(5)D'):  # 4/5: xx00 international, xx01-xx07 domestic
            base = frm[:2] + '00'
            out_blocks.append([base, base, 'I', None])
            out_blocks.append([frm[:2] + '01', frm[:2] + '07', 'D', None])
            continue
        m = re.fullmatch(r'(I|D)?\(?(\d+)?\)?', cell)
        if m is None:
            raise SystemExit(f'cell {fir} {cell}')
        kind, note = m.group(1), m.group(2)
        if kind is None:  # Brisbane "14": a note without I/D (international use not available NE)
            kind = 'I'
        if note in NOTES:
            frm, to = NOTES[note]
            note = None
        out_blocks.append([frm, to, kind, note])
    apac[fir] = out_blocks

FIR_IDS = {
    'BANGKOK': ['VTBB'], 'BEIJING': ['ZBPE'], 'CHENNAI': ['VOMF'], 'COLOMBO': ['VCCF'],
    'DHAKA': ['VGFR'], 'DELHI': ['VIDF'], 'FUKUOKA': ['RJBG', 'RJDG', 'RJTG'],
    'GUANGZHOU': ['ZGZU'], 'HANOI': ['VVHN'], 'HO CHI MINH': ['VVHM'], 'HONG KONG, CHINA': ['VHHK'],
    'INCHEON': ['RKDA', 'RKRR'], 'JAKARTA': ['WIIF'], 'KABUL': ['OAKX'], 'KARACHI': ['OPKR'],
    'KATHMANDU': ['VNSM'], 'KOLKATA': ['VECF'], 'KOTA KINABALU': ['WBFC'], 'KUALA LUMPUR': ['WMFC'],
    'KUNMING': ['ZPKM'], 'LAHORE': ['OPLR'], 'LANZHOU': ['ZLHW'], 'MALE': ['VRMF'], 'MANILA': ['RPHI'],
    'MUMBAI': ['VABF'], 'NADI': ['NFFF', 'NFFJ'], 'PHNOM PENH': ['VDPF'], 'PORT MORESBY': ['AYPM'],
    'PYONGYANG': ['ZKKP'], 'SHANGHAI': ['ZSHA'], 'SHENYANG': ['ZYSH'], 'SINGAPORE': ['WSJC'],
    'TAHITI': ['NTTC', 'NTTT'], 'TAIBEI': ['RCAA'], 'UJUNG PANDANG': ['WAAF'], 'ULAAN BATAAR': ['ZMUB'],
    'URUMQI': ['ZWUQ'], 'VIENTIANE': ['VLVT'], 'WUHAN': ['ZHWH'], 'YANGON': ['VYYF'],
    'NEW ZEALAND': ['NZAA', 'NZCB', 'NZCK', 'NZCS', 'NZCT', 'NZOH'],
}
# Australian VATSpy sectors by name prefix.
names = {}
sec = ''
for line in open(f'{dl}/VATSpy.dat', encoding='utf-8', errors='replace'):
    line = line.strip()
    if line.startswith('['):
        sec = line
        continue
    c = line.split('|')
    if sec == '[FIRs]' and len(c) >= 4 and re.fullmatch('[A-Z]{4}', c[0]) and c[3] == c[0]:
        names.setdefault(c[0], c[1])
FIR_IDS['BRISBANE'] = sorted(k for k, v in names.items() if k.startswith('Y') and v.startswith('Brisbane'))
FIR_IDS['MELBOURNE'] = sorted(k for k, v in names.items() if k.startswith('Y') and v.startswith('Melbourne'))
missing = set(apac) - set(FIR_IDS)
if missing:
    raise SystemExit(f'no ids for {missing}')

lines = HEADER + [
    "/**",
    " * ICAO Asia and Pacific Regions Air Navigation Plan (eANP), Volume II, Part IV (ATM),",
    " * Table ATM II-APAC-2 \"SSR Codes Allocation Plan of the Asia and Pacific Regions\", pages IV-28",
    " * to IV-31 (amendments up to APAC-II 24/04, February 2026), document of July 2026:",
    " * https://www.icao.int/sites/default/files/APAC/APAC-ANP/APAC-new-eANP-Vol-II_July-2026.pdf,",
    " * taken 2026-10-09. GENERATED — do not edit by hand. © ICAO: [VERIFY] reuse terms before a",
    " * public release (docs/08, decision 9; approved for personal use 2026-10-09, docs/07 T24).",
    " *",
    " * Block: first code, last code (octal), `I` international or `D` domestic, restriction note",
    " * (11–16 of the table, such blocks are not used: 11 not in western Fukuoka FIR, 12 not",
    " * southbound, 13 eastbound/northeast bound only, 14 not in north-eastern Australia, 15 only to",
    " * China, Manila and Taipei FIRs, 16 not to or over the Fukuoka FIR). Notes 1–10 are applied:",
    " * they narrow a block to a range (1 = 1600–1637 … 10 = 6450–6477; 4/5 = xx00 international,",
    " * xx01–xx07 domestic). A full block `0100`–`0177` includes its xx00 code; the selector never",
    " * hands out codes ending in 00. Note `*`: all codes are available for domestic use in Australia",
    " * and New Zealand except where indicated. No codes are issued for the Auckland Oceanic,",
    " * Anchorage and Oakland Oceanic, Honiara, Nauru and Sanya FIRs.",
    " *",
    " * `firs`: FIR ids of the airports in that FIR as VATSpy.dat v2610.1 `[Airports]` names them",
    " * (Australia: the VATSpy sectors named \"Brisbane (…)\" / \"Melbourne (…)\"; Japan: the ACC areas",
    " * of the Fukuoka FIR) — approved mapping, docs/07 T24.",
    " */",
    "",
    "export const ICAO_APAC_VERSION = 'eANP Vol II Table ATM II-APAC-2 (APAC-II 24/04, 2026-02)';",
    "",
    "export interface ApacFir {",
    "  readonly firs: readonly string[];",
    "  readonly blocks: readonly (readonly [string, string, 'I' | 'D', string | null])[];",
    "}",
    "",
    "export const ICAO_APAC_FIRS: Readonly<Record<string, ApacFir>> = {",
]
for fir in sorted(apac):
    lines.append(f"  '{fir}': {{")
    lines.append(f"    firs: [{', '.join(repr(x) for x in FIR_IDS[fir])}],".replace('"', "'"))
    lines.append("    blocks: [")
    for blk in apac[fir]:
        note = 'null' if blk[3] is None else f"'{blk[3]}'"
        lines.append(f"      ['{blk[0]}', '{blk[1]}', '{blk[2]}', {note}],")
    lines.append("    ],")
    lines.append("  },")
for fir in sorted(set(FIR_IDS) - set(apac)):
    lines.append(f"  '{fir}': {{ firs: [{', '.join(repr(x) for x in FIR_IDS[fir])}], blocks: [] }},".replace('"', "'"))
lines += ["};", ""]
open(f'{out}/icao-apac.ts', 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
print('APAC FIRs', len(apac), 'AU', len(FIR_IDS['BRISBANE']), len(FIR_IDS['MELBOURNE']))
