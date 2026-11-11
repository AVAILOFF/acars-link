# T31/T32 — research on sources and assumptions (DRAFT FOR APPROVAL)

Verification date: **2026-10-15**. No code was changed and nothing is committed. Rule: `07`, "Realism rule". Marks: ✔ — confirmed by a source; ~ — partly confirmed / from a secondary source; ✗ — not found or unavailable (`[VERIFY]`).

Limits of the research: the search was general, and some pages were unavailable (airframes.io — connection refused, OpenSky `/data/aircraft` — 403, groups.io — 402). The primary sources (ARINC 618/620/622, Doc 9869, ADN) are behind paid access; I did not read their texts.

## Main conclusion

1. **There is no open, authoritative list of ground VHF ACARS stations (SITA/ARINC/AVICOM) with coordinates.** A real station "in line of sight" cannot be chosen without an assumption.
2. **The `AES:… GES:… .<reg>` line is the output format of a decoder (JAERO / inmarsat-sniffer), not what the cockpit shows.** The pilot does not see such a header on the CDU/MCDU (this is inferred from the fact that all the samples found are SDR decoder logs; I did not read the ARINC documents, so it is marked ~). So T32 is "as on listeners' tapes", not "as in the cockpit".
3. Satellites (Inmarsat GEO, Iridium from TLE) can be done with verified data, except the **mapping of GES codes to ground stations and exact delays**.
4. **I found no measured real delivery delays for VHF/SATCOM/Iridium.** Any delay number is an assumption.

## 1. Ground VHF stations

| Fact | Status | Source |
|---|---|---|
| ICAO ACARS frequencies: 131.525, 131.725, 131.825 MHz (ARINC/SITA networks) | ~ | [RadioReference ACARS wiki](https://wiki.radioreference.com/index.php/ACARS) (secondary) |
| Open SITA/ARINC list with coordinates | ✗ | search on 2026-10-15: only amateur tables found |
| Amateur table of VDL2 stations (address, nearest airport, approximate coordinates); in one version the coordinate signs were mixed up | ~ | [acars-vdl2 groups.io](https://acars-vdl2.groups.io/g/main/topic/acars_ground_stations/33062909) — no licence, page not readable |
| VDL2 stations themselves transmit their identifier and approximate coordinates in the squitter (this is how the tables are built) | ~ | [forum thread](https://acars-vdl2.groups.io/g/main/topic/acars_ground_stations/33062909), [RadioReference](https://forums.radioreference.com/threads/acars-v-vdl2-ground-stations.312221/) |
| Station address: "1…" — ARINC, "2…" — SITA | ~ | RadioReference (forum) |
| USA: licensed sites in the FCC ULS (geo search) | ~ | tip from a forum member; US data only, not checked for ACARS stations |
| HFDL (not VHF): ARINC published a table of 16 stations with coordinates | ~ | [Btown Monitoring Post](http://monitor-post.blogspot.com/p/vhf-acars-hfdl-aka-hf-acars.html), table from 2019 |

**Options for T31 (VHF):**
- **A. Station = airport.** Take the nearest airport from the OurAirports data already in use (public domain) as a "nominal station"; the name is the airport's ICAO code. Assumption: real stations are not at every airport and not under these names.
- **B. Coverage radius from any airport instead of stations.** "VHF is available" if the distance to the nearest airport is ≤ R NM (radio horizon `1.23·√h` NM for height in feet — a standard formula, ✔ common knowledge, but I did not look for a citable source). Assumption: real coverage is uneven (oceans, Africa, parts of Russia).
- **C. Do not name the VHF station at all**, show only "VHF / SATCOM" and the link type. Fewest assumptions, but there is no "station in the window".
- Building a real database ourselves (from the squitter) is out of scope.

## 2. Satellites

### Inmarsat (GEO)
| Fact | Status | Source |
|---|---|---|
| I-3 ocean regions: AOR-W 54°W, AOR-E 15.5°W, IOR 64.5°E, POR 178°E | ✔ (secondary) | [FCC questions/satellite table](https://www.fcctestonline.com/question_pools/element_7/7-A-060.htm), [hamstudy](https://hamstudy.org/browse/C3_2009/96) |
| I-4 satellites: Americas 98°W, EMEA 25°E, Asia-Pacific 143.5°E | ✔ | [FAA, 2009](https://www.faa.gov/media/99696) |
| L-band decoders show 25°E, 54°W, 98°W, 143°E (satellites 4A4F4, 3F5, 4F3, 4F1) | ~ | [acars_notes/L-Band.md](https://github.com/AngelODeath/acars_notes/blob/main/L-Band.md) (amateur note) |
| Aero H/I and Swift64 are closed (2023); Classic Aero (H+) continues, SwiftBroadband-Safety is the successor; no Classic Aero closure date found | ~ | [RunwayGirl 2020](https://runwaygirlnetwork.com/2020/10/08/inmarsat-to-stop-supporting-swift64-by-year-end-aero-h-i-in-2023/), [FAA/Viasat 2026](https://www.faa.gov/media/97301) |
| Exact sub-satellite latitudes/longitudes of the current slot shifts (I-3F4 drifted to 53°W) | ✗ | longitudes change; check with the operator before use `[VERIFY]` |

For rough geometry (whether a satellite is visible from a point, the elevation angle) the longitude on the equator is enough, with an orbit height of 35,786 km (common knowledge). No licence problems (facts). Which satellite actually serves an aircraft is decided by the real network by zones — **I did not find tables of the overlap zones** (✗): choosing "the nearest by longitude with elevation > 5–10°" will be an assumption.

### Iridium
| Fact | Status | Source |
|---|---|---|
| CelesTrak: only the **Iridium NEXT** group (`gp.php?GROUP=iridium-NEXT&FORMAT=csv`); there is no plain "Iridium" group without NEXT; the TLE format for the group is not stated on the page, CSV is | ✔ | [CelesTrak NORAD/elements](https://celestrak.org/NORAD/elements/) |
| The TLE format (5-digit numbers) does not cover objects after 2026-07-11; CSV/OMM is recommended | ✔ | same page. Iridium NEXT numbers are < 70000, but **OMM CSV/JSON**, not TLE, must be parsed |
| GP update about every 2 h; catalog requests no more than once per hour; on a non-200 response — stop and tell a human | ✔ | [usage policy](https://celestrak.org/usage-policy.php) (updated 2026-05-22) |
| **Licence/redistribution terms are not stated** | ✗ | the same page is silent. The source data is Space-Track, which has historically had restrictions on passing data to third parties | [Space-Track discussion](https://www.projectpluto.com/groups/guide-user/msg4767.htm), the current text of the agreement was not read |
| CelesTrak mission: data is "freely available" — this is not a licence | ✔ | usage policy |

Conclusion: **downloading it ourselves on the user's machine (the user's app) and putting it into the user's flight recording is acceptable** (we do not distribute the dataset in the repository; cache ≥ 2 h). **Do not commit TLE to the repository and do not ship it in a release** without written permission. Test fixtures are trimmed to 2–3 records; their terms are also not defined `[AT RELEASE]`.
Unresolved: **how ACARS goes over Iridium (SBD/ARINC 622) and what the header looks like in decoders — not found** (✗; I did not read the format in the iridium-toolkit code).

### SGP4
| Fact | Status |
|---|---|
| `satellite.js` 7.1.0, **MIT** licence (derived from the MIT package by Brandon Rhodes; the README mentions UCSC) | ✔ [GitHub](https://github.com/shashwatak/satellite-js), package.json |
| No `dependencies`; has optional WASM builds (`#wasm-*`), TS types included, `type: module` | ✔ package.json |
| Accepts OMM (`json2satrec`) and TLE (`twoline2satrec`), `propagate(satrec, Date)`, `eciToGeodetic`, `ecfToLookAngles` | ✔ README |
| Size ≈ 37 KB minified (7.0.0) | ~ third-party tracker |
| Does not import Node/DOM | ~ README is silent; **check the package before use** (`import` graph and the `purity` test) |
| Compatibility with the core: `propagate` takes a `Date`; the core does not call `Date.now()` but can build a `Date` from the `Clock` | invariant 4 ✔ when time is passed from the `Clock` |

Options: (a) `satellite.js` as a dependency in `packages/core` — check purity (`purity.test.ts`), core dependency policy; (b) **write SGP4 ourselves** — not possible without a reference, high risk; (c) vendor the needed part (MIT allows this, a copy of the licence is needed); (d) move SGP4 to `data-sources`/main and pass ready satellite positions to the core (recommended — the core stays without a new dependency, the positions are written to the recording as `CoreInput.data`).

## 3. Delivery delays

Found:
- GEO: round-trip propagation delay ≈ 500–600 ms (patent, forum) ~ [Infinite Flight, SATCOM ACARS](https://community.infiniteflight.com/t/satcom-acars-receiving-decoding-acars-from-inmarsat-uhf-part-i/1114538).
- Retry of an unacknowledged VHF message after 10 s (second-hand) ~; Iridium SBD — resend after 180 s in the patent description of the worst case ~ [US7904081](https://patents.justia.com/patent/7904081).
- CPDLC: application limit 30 s; RCP 240: transaction ≤ 240 s in 99.9 % (ACP 210 s) ✔ [ICAO PBCS FAQ](https://icao.int/EURNAT/Other%20Meetings%20Seminars%20and%20Workshops/NAT%20PBCS%20WORKSHOP/1st%20NAT%20PERFORMANCE%20BASED%20COMMUNICATIONS%20AND%20SURVEILLANCE%20WORKSHOP/PPT05%20-%20RCP_RSP%20FAQ%20for%20ICAO%20PBCS%20workshop.pdf) (this is a requirement for the full transaction, not for a single delivery).

**There are no measured distributions of ACARS delivery time over VHF/Inmarsat/Iridium (✗).** All the numbers below will have to be assumed.

## 4. AES/GES headers and ICAO hex

Real samples (decoders, not documentation) ~:
- `AES:4249EA GES:50 2 .VQ-BLQ !` — GES 50 = 4F1 143°E (L-Band.md).
- `TC AES:3B75A8 GES:D0 2 .F-UJCH !` — GES D0 = 4F3 98°W.
- `AES:AE07EAGES:022.50107A!` (run-together variant).
- Others: `AES:C2B3EB GES:05 2 .77703A !`, `AES:3C6503 GES:05 2 .D-AIHC !`, `AES:AA75EF GES:02 2 .N773UA` ([RadioReference](https://forums.radioreference.com/threads/acars-the-future-inmarsat.330782/page-2) and search).

What is known: AES — 6 hex digits = the 24-bit ICAO address of the aircraft ✔ (usually, from several samples; in `.77703A` the registration is replaced by hex when there is no registration); GES — 2 hex digits, the ground station code; "2" — the mode; `.XXXX` — the registration; `!` — a flag/acknowledgement (the interpretation is mine, **~ inference**). There is no exact description of the fields — the ARINC 618/620 specification was not read (✗); the JAERO code (MIT) can be used as a reference for the fields.
GES codes ↔ satellites: a table exists only for L-band frequencies (43, 44, 02 → 3F5/54°W; 05, D0, 02 → 4F3/98°W; 50, 82, 85 → 4F1/143°E; 90, C5, C1 → 4A4F4/25°E) ~ amateur; GES 02 appears for two satellites — there is no one-to-one mapping. The location of physical stations by code — ✗.

Aircraft ICAO hex:
| Source | Licence | Conclusion |
|---|---|---|
| Entry in the aircraft profile | — | ✔ no assumptions; the only out-of-the-box option |
| OpenSky aircraft database | page unavailable (403); data terms: non-commercial research/education, internal tests, government purposes; any other copy requires permission for commercial use ✗ | do not use without reading the terms `[AT RELEASE]` |
| ADS-B Exchange basic-ac-db | no explicit licence; commercial use — written permission; no bulk transfer ✗ | do not use |
| Civil aviation registers (FAA and others) | not checked | candidate to clarify `[VERIFY]` |
| Algorithmic derivation of hex from the registration | for the USA (N-number→ICAO) the algorithm is deterministic and known, other countries need tables | not checked |

In a simulator the registration often does not match a real aircraft; the natural option is for the user to enter the hex (or take it from SimBrief/OFP, if it is there — `[VERIFY]`, I did not look for the field in the OFP).

## 5. Wrapping for narrow displays

I **did not find** real wrapping rules for the header line (✗). The existing formatter (`docs/03-architecture.md`, T05) already wraps at a space, width 24 (B77x 27, B78x 30). The header `AES:xxxxxx GES:xx 2 .REG !` is ≈ 26–33 characters and does not fit in 24. So the rule is an assumption (the project's). Proposed: split by tokens (`AES:…` / `GES:… 2` / `.REG`), never break a token; if a token is longer than the line — the formatter's hard wrap. The header goes **before** the formatter as part of the body, not bypassing it (invariant 9).

## Assumptions for approval

| No. | Assumption | How it differs from reality / will the pilot notice | Recommendation |
|---|---|---|---|
| A1 | A VHF "station" = the nearest OurAirports airport within the radio horizon (option A+B) | real stations are other points, some areas have no coverage; the pilot will not notice | **Yes**, marked "nominal station". Alternative C is cheaper but loses the point of the "window" |
| A2 | VHF radius: `1.23·√height_ft` NM, capped at, for example, 200 NM | in reality depends on the antenna/network | **Yes**, provided the formula is approved; I did not check the source of the formula — needs verification |
| A3 | GEO choice by longitude and elevation angle (> 5°), no zone tables | real networks assign the GES by their own plan | **Yes**, take the list of satellites from section 2 (54°W, 15.5°W, 64.5°E, 178°E, 98°W, 25°E, 143.5°E) |
| A4 | Iridium: the nearest one visible from TLE by SGP4, with elevation > 8°… | Iridium NEXT is 66 + spares; handover is simplified; **how ACARS goes over Iridium has not been studied** | **Defer**; in T31 do VHF+Inmarsat first |
| A5 | Delays: VHF 2–10 s, Inmarsat 5–30 s, Iridium 15–60 s (these numbers are **made up by me as an order of magnitude**, no sources) | real distributions are unknown; in practice the pilot will notice only very large ones | **Yes, only as configurable constants** with an honest note; deterministic jitter from the `Rng` |
| A6 | The user's app downloads the TLE (cache ≥ 2 h, OMM CSV/JSON), not committed to the repository; the flight recording contains the elements used | CelesTrak/Space-Track terms on redistribution are not defined | **Yes**, `[AT RELEASE]` — find out the terms; do not distribute for now |
| A7 | The `AES:… GES:… .REG` header is a decoder format, not a cockpit one. Show it in the message as a "listener tape" or only in the status window | there is no such header in the real cockpit | **Only in the status window and optionally in the message text (off by default)** |
| A8 | GES code: take from the L-band table (section 4) by satellite; for the ambiguous 02 — the first one in the table | the codes are real, but their binding to a specific flight is made up | **Yes**, with a note |
| A9 | ICAO hex: entered in the aircraft profile; without an entry — the header is not shown | the pilot will see an empty AES | **Yes**; open databases — after `[AT RELEASE]` |
| A10 | SGP4 in `data-sources`/main (satellite.js, MIT), the core receives positions in `CoreInput.data` | a dependency outside the core | **Yes**; (d) from section 2 |
| A11 | Header wrapping rule by tokens (section 5) | — | **Yes** |

## Proposed scope

**T31 (narrowed):** a `datalink` profile (VHF/SATCOM), a nominal VHF station (A1–A2), Inmarsat GEO from the table (A3), a configurable delay with deterministic jitter (A5), a delivery queue in the core via `Clock`/`Rng`; satellite and station positions — in `CoreInput.data`/the recording. **Iridium + TLE + SGP4 — move to a separate card** (A4, A6, A10) after the terms and the protocol are clarified.
**T32:** a status window (station/satellite, transmission time), the AES/GES header from the samples, hex from the profile (A7–A9), wrapping by tokens (A11). Depends on T31.

## Report

## T31/T32 — research
Done: research of sources, a document for approval.
Files: `docs/_drafts/T31-T32-research.md` (not in git).
Checks: code was not changed, checks were not run.
Human check: none.
Notes (out of scope): the working tree contains other people's changes (T33: `context.ts`, `irregular.test.ts`, `dest_fire.yaml`) — did not touch them.
Open questions: approval of A1–A11; CelesTrak/Space-Track and OpenSky terms; the primary ARINC 618/620 sources were not read; the ACARS-over-Iridium format was not found.
