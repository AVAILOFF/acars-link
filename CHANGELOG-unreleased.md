# Changelog — unreleased

Changes since `v1.0.0` (2026-11-01) that are not in a release yet: branch
`task/T103-vdgs-departure-etd` (T89–T92, T22, T102, T103), not merged into `master`. At the
next `pnpm release` the section of `CHANGELOG.md` is built from the `Merge task/…` commits as
usual; this file is the detailed list and can be removed then.

## Departure board on the GSX VDGS (T102, T103) — 2026-11-05

### New

- **Departure board at A-CDM airports** (scenario `vdgs_departure`, on by default). At the
  departure stand of the 35 airports where EUROCONTROL lists A-CDM as fully implemented
  (`packages/core/src/ext/acdm-airports.ts`) the app replaces GSX's own `flight_information`
  board (static SimBrief times) with:
  - flight, destination, runway and SID from the start of the flight;
  - from TOBT − 30 min the airline's **TOBT** and a countdown `TTD nnMIN` (no countdown on
    narrow displays), in UTC;
  - a blank time line once the TOBT is reached;
  - not off block 15 min after the TOBT: red **FLIGHT SUSPENDED / NEW TOBT REQUIRED**
    (`FLIGHT / SUSPND / NEW / TOBT / REQRD` on narrow) until a pilot `DELAY` gives a new TOBT;
  - taken down at off-block (OUT).

  TOBT = scheduled off-block + the airline's delay (late start, pilot `DELAY`, irregular
  scenarios); the ATFM slot (`slot_ctot`) moves the CTOT, not the TOBT. Timings from Düsseldorf
  Airport "Airport-CDM Flight Crew Briefing" v5.0 (2022-08-16), 2.8; no TSAT, no CTOT on the
  board. Rewritten every minute of flight time.
- **Departure board away from A-CDM airports** (scenario `vdgs_departure_etd`, **off by
  default**, not a reproduction of a real display): the same board with the **ETD** (every
  delay, the slot included) and `TTD`, without FLIGHT SUSPENDED.
- **SafeDock FLEX** displays (10 characters, 5 lines): every VDGS message now has a `flex`
  variant (the `narrow` lines unless a scenario gives its own), so arrival and diversion boards
  show on FLEX stands too.
- Scenario format: `vdgs` step fields `at: orig | dest` and `replaces: flight_information`,
  `vdgs: stop`, blank lines `""`, display `flex`; variables `flight.tobt`,
  `flight.minutes_to_tobt`, `flight.minutes_to_etd`, `ofp.orig_acdm` (docs/05).
- Translations: ru by hand, de/fr/es/ja machine (DeepL).

### Fixed (found in MSFS 2024 with GSX Pro, 2026-11-05)

- GSX kept its own departure board: a replacing message must also be listed in the file's
  `"overrides": { "stock": [...] }` (GSX sample `sample_chock_override.json`, VGDS editor
  manual "Override System"); the same `id` alone only added a page.
- The board came late: the `sched_out − 60` trigger was fitted to a late start and moved by a
  `DELAY` (board only about TOBT − 33 min), and it changed the late-start timing of the other
  pre-departure messages at A-CDM airports. The trigger is now `est_out − 180`: the board is
  up from the first minute, the other messages keep their timing.
- FLEX stands (e.g. EDDF A19) showed GSX's text: no `flex` variant was written.

### Known limits

- An airport handler script that sets the board itself wins over the app's file (GSX manual,
  "Overriding Stock Messages"). Example: Aerosoft EDDF 2.5 (`EDDF-Aerosoft_handler.py`, VATSIM
  CDM / SimBrief) — at EDDF the app's board does not show.
- "Time from the sim" fixes the sim offset at the start of the flight: moving the sim clock
  later does not move the board's clock.

### Checked by a human

- EGLL (iniBuilds), narrow display: the board replaces GSX's from the first minute; TOBT,
  `DELAY 20` → new TOBT outside the 30 min window → blank time lines.

### Recording format

- `cmd` line of a taken-down board: `"data": {"action": "stop"}` (`tools/replay/src/format.ts`).

## T22 fix — 2026-11-05

- VDGS: the last line of narrow, wide and x displays is GSX's scrolling line (VGDS Message
  Editor manual, "Reserved Lines"): limits narrow 5, wide 6, x 6 lines; the arrival board on
  narrow no longer puts the gate on that line.

## Kinds of flight (T89–T92) — 2026-11-04

- **T89 kind of flight:** recognized from the OFP (FPL items 8a/8b and 18: medevac by
  `STS/HOSP|MEDEVAC`, cargo, ferry, business by flight type `G`, else scheduled; charter only
  by the user's choice); shown on the OFP panel with a choice until OUT and a question after
  loading the OFP (setting "Ask the kind of flight"); scenario field `operations`, variable
  `flight.kind`; the kind is in the flight report and the recording.
- **T90 cargo:** preliminary and final loadsheets without passengers (freight LMC only),
  `REQ LOADSHEET`, NOTOC (`CAO YES` for UN3480/UN3090), special loads by IATA handling codes,
  late truck, damaged ULD, weight correction, hub sort moved, temperature container failure;
  freighter families A300, B767, MD-11.
- **T91 charter and ferry:** tour group change, tour operator representative, sports team, VIP
  charter, transfer at the destination; crew-only loadsheet, ferry permit, ferry after
  maintenance, positioning with a real next departure; connections only on scheduled flights.
- **T92 business aviation:** recognized by aircraft type (16 families) or flight type `G`;
  flight support pack (handling / FBO, fuel release, catering, eAPIS into the US, principal
  late, arrival car and crew hotel); no airline loadsheet, crew list, gate, VDGS or made-up
  next leg; flights without an airline.
