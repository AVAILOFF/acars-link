# SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
# Copyright (c) 2026 AVAILOFF

"""Step 1 of the squawk tables (T24): text positions of the PDF tables -> JSON.

    python -I extract.py <dir>

<dir> holds the downloaded sources (see README.md):
  nbcap.pdf      FAA Order JO 7110.66H (NBCAP)
  apac-eanp.pdf  ICAO APAC eANP Volume II (July 2026)
Writes <dir>/nbcap-b3.json (TBL B-3 rows) and <dir>/apac-cells.json (Table ATM II-APAC-2 cells).
Needs pypdf.
"""
import json
import re
import sys

import pypdf

src = sys.argv[1]


def text_items(path, pages):
    """(page index in `pages`, x, y, text) of every text run."""
    reader = pypdf.PdfReader(path)
    items = []
    for k, pi in enumerate(pages):
        def visit(text, cm, tm, font, size, k=k):
            t = text.strip()
            if t:
                x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
                y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
                items.append((k, round(x, 1), round(y, 1), t))
        reader.pages[pi].extract_text(visitor_text=visit)
    return items


# ---- FAA NBCAP, Appendix B, TBL B-3 (pages 8-16 of the PDF) ----
items = text_items(f'{src}/nbcap.pdf', range(7, 16))
rows = {}
for p, x, y, t in items:
    rows.setdefault((p, y), []).append((x, t))
nbcap = {}
for (p, y), cells in sorted(rows.items(), key=lambda kv: (kv[0][0], -kv[0][1])):
    cells.sort()
    ids = [t for x, t in cells if x < 240]
    if len(ids) != 1 or not re.fullmatch(r'K?Z[A-Z]{2}', ids[0]):
        continue
    code = ''.join(t for x, t in cells if 240 <= x < 300)
    thru = ''.join(t for x, t in cells if 320 <= x < 370)
    prio = ''.join(t for x, t in cells if x >= 370)
    if not re.fullmatch(r'\d{4}', code) or (thru and not re.fullmatch(r'\d{4}', thru)):
        raise SystemExit(f'NBCAP: unexpected row {cells}')
    nbcap.setdefault(ids[0], []).append({'from': code, 'to': thru or None, 'priority': prio})
json.dump(nbcap, open(f'{src}/nbcap-b3.json', 'w'), indent=1)
print('NBCAP', len(nbcap), 'ARTCCs')

# ---- ICAO APAC eANP Vol II, Table ATM II-APAC-2 (pages IV-28..IV-31 = PDF pages 193-196) ----
items = text_items(f'{src}/apac-eanp.pdf', range(192, 196))
FIRS = ['BANGKOK', 'BEIJING', 'BRISBANE', 'CHENNAI', 'COLOMBO', 'DHAKA', 'DELHI', 'FUKUOKA',
        'GUANGZHOU', 'HANOI', 'HO CHI MINH', 'HONG KONG, CHINA', 'INCHEON', 'JAKARTA', 'KABUL',
        'KARACHI', 'KATHMANDU', 'KOLKATA', 'KOTA KINABALU', 'KUALA LUMPUR', 'KUNMING', 'LAHORE',
        'LANZHOU', 'MALE', 'MANILA', 'MELBOURNE', 'MUMBAI', 'NADI', 'NEW ZEALAND', 'PHNOM PENH',
        'PORT MORESBY', 'PYONGYANG', 'SHANGHAI', 'SHENYANG', 'SINGAPORE', 'TAHITI', 'TAIBEI',
        'UJUNG PANDANG', 'ULAAN BATAAR', 'URUMQI', 'VIENTIANE', 'WUHAN', 'YANGON']


def ends(page, y):
    """Columns (left x, first code, last code) from the row of last codes ("0077" …)."""
    e = sorted([i for i in items if i[0] == page and abs(i[2] - y) < 1 and re.fullmatch(r'\d{4}', i[3])],
               key=lambda i: i[1])
    return [(i[1] - 3, int(i[3], 8) & ~0o77, int(i[3], 8)) for i in e]


A = sorted([c for y in (693.7, 697.8) for c in ends(0, y)])
A[0] = (A[0][0], 0o1, A[0][2])        # 0001-0077
A[8] = (A[8][0], 0o1001, A[8][2])     # 1001-1077
B = ends(0, 106.6)
B[0] = (B[0][0], 0o2001, B[0][2])     # 2001-2077
C = ends(1, 234.4)
D = ends(2, 365.9)
for code in ('7500', '7600', '7700'):  # single codes, no row of last codes
    it = next(i for i in items if i[0] == 2 and abs(i[2] - 376.2) < 1 and i[3] == code)
    D.append((it[1] - 3, int(code, 8), int(code, 8)))
D.sort()


def section(page, y):
    return {0: A if y > 117 else B, 1: B if y > 245 else C, 2: C if y > 377 else D}.get(page, D)


cells = {}
for page in range(4):
    for n in [i for i in items if i[0] == page and i[3] in FIRS]:
        if page == 3 and n[2] < 300:
            continue
        row = sorted([i for i in items if i[0] == page and abs(i[2] - n[2]) < 1.5 and i[1] > 100
                      and i[3] not in FIRS], key=lambda i: i[1])
        out = cells.setdefault(n[3], [])
        for c in row:
            cx = c[1] + 2.6 * len(c[3])  # centre of the text: wide cells ("D(11)") start left of the column
            col = max((k for k in section(page, n[2]) if k[0] <= cx), key=lambda k: k[0])
            frm, to = oct(col[1])[2:].zfill(4), oct(col[2])[2:].zfill(4)
            if out and out[-1]['from'] == frm:
                out[-1]['cell'] += c[3]   # "I" + "(13)"
            else:
                out.append({'from': frm, 'to': to, 'cell': c[3]})
json.dump(cells, open(f'{src}/apac-cells.json', 'w'), indent=1)
print('APAC', len(cells), 'FIRs')
