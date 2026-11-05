# Changelog — unreleased

Changes since `v1.0.0` (2026-11-01) that are not in a release yet: branch
`task/T103-vdgs-departure-etd` (T89–T92, T22, T102, T103), branch
`fix/simconnect-dispatch-queue` (SimConnect messages) and branch `task/T88-ground-rescue` (T88,
built on the SimConnect fix), none merged into `master`. At the next `pnpm release` the section
of `CHANGELOG.md` is built from the `Merge task/…` commits as usual (the SimConnect fix is not a
`task/…` branch: add it by hand); this file is the detailed list and can be removed then.

## MAYDAY / PAN on the ground (T88) — 2026-11-04

Branch `task/T88-ground-rescue` (commit `1d8fd07`).

### New

- **Rescue services where the aircraft stands.** A MAYDAY or PAN PAN to the XATC station before
  take-off or after landing (OOOI: before OFF, after ON) calls the services of the airport of
  the flight within 5 NM of the aircraft (origin, destination, alternates, ETOPS airports, the
  diversion airport — the rule of the T69 flight report), with its planned runway. Before, the
  call went to the destination of the OFP.
- **No DIVERT / CONTINUE question on the ground** (`emergency_mayday`, `emergency_pan`): OPS
  answers `MAYDAY RCVD VIA ATC / EMERGENCY DESK ACTIVATED / RESCUE AND FIRE SERVICES ALERTED /
  AT <ICAO> / ADVISE INTENTIONS` (PAN: `RESCUE AND MEDICAL STANDBY`).
- **Trucks come to the aircraft at once** (bridge, `RescueController`): created beside the
  runway as on arrival, then straight across the airfield (no taxiways) to the aircraft.
  MAYDAY: they surround it while it stands, follow it while it rolls (they stop behind a
  take-off run past 60 kt), removed 10 min after the stop. PAN: they stand aside on an arc of
  100 m ahead of the nose (a game rule). The ambulance as before, at the parked aircraft.
  "Stands" goes by the ground speed only: the BlueBird 757 reports `SIM ON GROUND` = 0 at the
  stand.
- No airport of the flight within 5 NM (e.g. the aircraft at LEBL with a KHOU OFP): no
  vehicles, a line in the feed; the telex without `AT <ICAO>`.
- Scenario variable `flight.here` (the airport of the flight within 5 NM on the ground, null
  in the air).
- Assumptions approved by the user 2026-11-04: card T88 in `docs/07-roadmap-tasks.md`.
- Translations: ru by hand, de/fr/es/ja machine (DeepL).

### Protocol and recording format

- Bridge command `rescue_start`: optional `ground: true` (core `checkRescueStart` and the
  bridge `CommandCatalog`); sent only for a call on the ground, so an older bridge still takes
  calls in the air.
- Core option `rescueVersion` (1 = before T88, 2 = on the ground at the airport where the
  aircraft stands); the app records `rescueVersion: 2` in the header, recordings without it
  replay as 1. `cmd` line of a rescue on the ground: `"ground": true` in `data`. New core event
  `RESCUE_NO_AIRPORT`.

### To check in MSFS

- At the stand of the origin, XATC on: LOGON `X<FIR>`, CPDLC MAYDAY → `ROGER MAYDAY`, OPS
  `… ALERTED AT <origin>` without a DIVERT question; fire trucks drive from the runway to the
  aircraft and surround it, gone 10 min later. The same with PAN: trucks aside, ambulance at
  the aircraft with the parking brake set. MAYDAY in flight: as before.

## SimConnect messages were lost (bridge) — 2026-11-01

Branch `fix/simconnect-dispatch-queue` (commit `86340a8`).

### Fixed

- **`smoke_start`, `rescue_start` and `ping` answered `unavailable sim not connected`** while
  MSFS was connected and telemetry came in (installed 1.0.0, MSFS 2024, 2026-11-01).
  `SimConnect_CallDispatch` hands every waiting message to the callback in one call, and
  `acars_simconnect.dll` (T73) kept only the last one: the session's OPEN came together with
  the first `Sim` / `Pause_EX1` events and was overwritten, so the bridge never marked the
  session open. The library now queues the messages and gives them out one by one, as the
  managed wrapper did before T73. Assigned object ids of the smoke and the rescue vehicles and
  SimConnect exceptions could be lost the same way.
- Checked against MSFS 2024: `ping` and `smoke_start` answer ok, the OPEN status shows in the
  bridge log. The fix is in the native library only: `pnpm bridge:build` with the MSFS SDK
  (CI builds the bridge without SimConnect and does not cover it).

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
  Editor manual shipped with GSX Pro, "Reserved Lines"; checked 2026-11-05): limits narrow 5,
  wide 6, x 6 lines (were 6/7/7). Before, the gate on the narrow arrival board landed on that
  line and wiped GSX's scrolling text.
- Arrival board (`vdgs_arrival`) on narrow: `AFL / 1234 / UUEE / GATE / 15` — the `FROM` line
  is dropped; wide and x are unchanged (`AFL 1234 / FROM UUEE / GATE 15`).
- Scenario format: a `vdgs` display takes at most 6 lines in the schema, narrow 5 when the
  scenario is compiled; a scenario with more lines is refused at load.
- To check in MSFS: arrival at a narrow (6-character) board — 5 lines of the app, the gate on
  the 5th, GSX's scrolling line below.

## Language list — 2026-11-05

- Settings and welcome: the language list shows the languages by their own names only; the
  "machine translation" mark after German, French, Spanish and Japanese is gone
  (`SettingsControls.tsx`; `LANGUAGES[…].machine` and the string `set.language.machine` stay).

## Kinds of flight (T89–T92) — 2026-11-04

- **T89 kind of flight:** recognized from the OFP (FPL items 8a/8b and 18: medevac by
  `STS/HOSP|MEDEVAC`, cargo, ferry, business by flight type `G`, else scheduled; charter only
  by the user's choice); shown on the OFP panel with a choice until OUT and a question after
  loading the OFP (setting "Ask the kind of flight"); scenario field `operations`, variable
  `flight.kind`; the kind is in the flight report and the recording.
  - OFP: new fields `flightType`, `flightRules`, `item18` (`STS/`, `RMK/`) and
    `weights.freightKg` (`freight_added`, freight without bags; `cargoKg` keeps bags + freight).
  - Passenger scenarios run only on scheduled and charter flights: `unruly_passenger`,
    `unruly_followup`, `medical_onboard`, `vip_onboard`, `lost_baggage`, `rush_bags_followup`,
    `short_connection`, `connection_held` / `_made` / `_missed`, `ped_fire_cabin`,
    `connex_list`. `cmd_medical` stays for every kind (a crew member may fall ill).
  - "Run now" does not get round the kind: the feed says the scenario is not for this kind of
    flight; the list marks such scenarios.
  - The question answered once is not asked again when the same flight is reloaded with the
    same recognized kind; after OUT a change is refused.
  - Recording: `flightKind` in the header and in `tick` lines; recordings made before T89 are
    replayed without the filter (checked on three real recordings: same telexes).
  - Translations: ru by hand, de/fr/es/ja machine (DeepL).

### New — cargo flights (T90)

- Scenario pack `packages/scenarios/cargo/` (`operations: [cargo]`), signed `LOAD CONTROL` /
  `CARGO CONTROL`:
  - **preliminary and final loadsheets** without a PAX line: freight total only (no ULD count,
    no split by deck — neither is in the OFP), LMC of the freight only; `REQ LOADSHEET` repeats
    them (`cmd_req_loadsheet_cargo`);
  - **NOTOC** (25 %, reply ACK): UN number, class, IATA handling code, hold, packages;
    `CAO YES` only for UN3480 / UN3090 (lithium batteries, "Forbidden" on passenger aircraft);
  - **special load** (15 %, reply ACK): AVI, PER, PIL with COL (+2…+8 °C) or CRT (+15…+25 °C),
    HUM, VAL;
  - irregular: late truck (5 %, delay 10–30 min), damaged ULD (6 %, only when the freight LMC
    is negative — the same kilograms as the final loadsheet), weight correction (6 %, LMC
    positive), hub sort moved (4 %, cruise, for information), temperature container failure
    (3 %, delay 15–30 min).
- Aircraft families **A300** (A306, A30B), **B767** (B762/B763/B764), **MD-11** (MD11) for
  `aircraft.*`, `{hold}` and the T54 rescue category (8–10, as wide-bodies).
- Sources (checked 2026-11-04): 49 CFR 172.101 Hazardous Materials Table (govinfo, revised
  2025-10-01); IATA handling codes as listed by SAS Cargo "Special handling codes" (valid
  2026-03-18); ICAO Doc 8643 (doc8643.icao.int data).

### New — charter and ferry flights (T91)

- `packages/scenarios/charter/` (`operations: [charter_pax]`, signed `CHARTER HANDLING`):
  - **tour group change** (50 %, only when the passenger LMC is not 0): no-show or late group,
    the same `LMC PAX` as the final loadsheet;
  - **tour operator representative**, **sports team** (oversize equipment, catering ordered by
    the charterer), **VIP charter** (car to the aircraft) — 30 % each, at most one per flight
    (group `charter_story`); the VIP charter excludes `vip_onboard`;
  - **transfer at the destination** (60 %, 100 NM before TOD): coaches for the passengers of
    the loadsheet.
- `packages/scenarios/ferry/` (`operations: [ferry]`):
  - **crew-only loadsheet** at STD − 7 min (`CREW ONLY / NO PAX NO CARGO`, no LMC);
    `REQ LOADSHEET` repeats it or says when it comes;
  - **ferry permit** (15 %, reply ACK): `SPECIAL FLIGHT PERMIT` for a US registration
    (N + digit; 14 CFR 21.197(a)(1)), else `PERMIT TO FLY` (EASA Part 21, 21.A.701); no permit
    numbers or limitations are made up;
  - **ferry after maintenance** (30 %): `RELEASE TO SERVICE SIGNED`;
  - **positioning for the next flight**: only with a real departure of the airline from
    AeroDataBox FIDS (`ops.next_real`), never with a made-up number.

### New — business aviation (T92)

- **Recognized by aircraft type**: 16 families of business jets and turboprops by ICAO Doc 8643
  (Citation, Challenger, Global, Gulfstream, Falcon, Learjet, Phenom, Praetor, PC-24,
  HondaJet, Vision, Hawker, Eclipse, King Air, PC-12, TBM); BBJ / ACJ share the airliners'
  designators and stay recognized by flight type `G` only. The OFP panel names the basis:
  "Aircraft type: C68A" (all six languages).
- `packages/scenarios/bizav/` (`operations: [bizav]`, header `FLIGHT SUPPORT`): handling and
  FBO confirmed, fuel release (OFP block fuel), catering for the OFP passengers, **eAPIS**
  arrival manifest into the US (destination K / PA / PH from outside; STD − 60 min,
  19 CFR 122.22(b)(2)), principal late (5 %, delay 15–45 min), car at the aircraft and crew
  hotel before TOD; `REQ LOADSHEET` → `NO LOADSHEET ISSUED / MASS AND BALANCE BY CREW`.
- Flights **without an airline**, with the registration as callsign, run through (station
  `OPS{flight}` → `OPSN680AB`, XATC on, no VDGS).

### Changed

- **LMC by kind of flight** (only with the kind filter, i.e. recordings since T89): no passenger
  LMC on a cargo flight (before, up to +5 PAX on a 0 PAX OFP), no LMC at all on a ferry flight;
  the other draws of the flight data stay the same. Choosing another kind before OUT recomputes
  it.
- **Passenger lines of shared scenarios** are left out on cargo and ferry flights:
  `BAGGAGE BELT`, `TRANSFER PAX`, `PAX CARE ARRANGED`, `PAX REBOOKING`, `PAX INFO SENT`,
  `CABIN CREW MAY INFORM PASSENGERS`, `EXPECT LATE PAX AND BAGS`, `PAX TRANSFER BY ROAD`;
  `TRANSFER PAX` only on scheduled flights.
- Which kinds get which shared scenarios:
  - passenger loadsheets — scheduled, charter, medevac (not cargo, ferry, business);
  - `dg_notoc` (`CAO NO`) — scheduled, charter, medevac;
  - `connex_list`, `short_connection`, `connection_*` — scheduled only;
  - `next_leg`, `aircraft_change`, `welcome_turnaround` (the next leg may be made up) — not on
    ferry and business flights;
  - `crew_info`, `gate_assignment`, `gate_reassignment`, `arrival_info`, `vdgs_arrival`,
    `vdgs_divert` — not on business flights.
- Scenario format: variables `flight.if_pax` / `flight.if_no_pax` (for optional `~` lines),
  `ops.ferry_permit`, `ops.next_real`, `ops.us_arrival`; `FlightKindInfo.aircraftType` and the
  rule `aircraft_type` (docs/05).
- Translations: ru by hand, de/fr/es/ja machine (DeepL).

### Not done (decisions of 2026-11-04)

- No made-up next leg (ferry to a maintenance base, the owner changing the next leg of a jet).
- No PPR / airport slots for business aviation (no checked table).
- No supernumeraries on cargo flights (not in the OFP).
- **T93 air ambulance** postponed: it needs T88 (rescue `standby`), which is only on the
  unmerged branch `task/T88-ground-rescue`.

### Known limits

- The sender (Hoppie station) is still the template of the settings (`OPS{flight}`); the
  persona (`LOAD CONTROL`, `CHARTER HANDLING`, `FLIGHT SUPPORT`) is in the header or footer.
- `crew_info` on a cargo flight still lists a senior cabin crew member and the cabin crew count.
- Recordings made with the kind filter before these changes (T89 builds only) replay a cargo
  flight without a loadsheet; recordings on A300 / B767 / MD-11 and business types may differ,
  as these types now have a family.
- No airport-planning documents of the freighters were read: holds are named as on the other
  wide-bodies, no ULD positions.

### To check in MSFS

1. Cargo OFP (e.g. PMDG 777F, 0 PAX, freight > 0): kind "Cargo"; loadsheets without PAX fit the
   MCDU; NOTOC with `CAO YES` (or "Run now"), reply ACK.
2. Charter by hand: no CONNEX or connections in the flight; a charter message ("Run now").
3. OFP with 0 PAX and no freight: kind "Ferry"; `CREW ONLY` loadsheet, no passenger scenarios.
4. Business jet with Hoppie (e.g. WT CJ4, type C25C), no airline, registration as callsign:
   kind "Business", basis "Aircraft type: C25C"; `FLIGHT SUPPORT` messages; a pilot reply gets
   through.
