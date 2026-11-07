# Changelog

ACARS Link releases: SemVer, an annotated tag `vX.Y.Z` on `master` for each (0.x until the
public release, 1.0.0 — the first public one). `pnpm release <X.Y.Z>` adds a section from the `Merge task/…` commits since the
previous tag; how to release — README.md, "Выпуски". A `## Unreleased` section written before
the release becomes that version's section, with the task lines under `### Tasks`.

## Unreleased

### New

- **Company NOTAM summary** (T95): about 200 NM before the top of descent `COMPANY NOTAM` lists
  the NOTAM of the destination and the alternate that matter for the arrival — aerodrome and
  runway closures, ILS and approach changes, approach and runway lights, aprons and stands — in
  force within an hour of the ETA, up to 5 per airport, each with its number, end of validity,
  text and, when it is active only at certain hours, its schedule (`SKED`). Taken from the
  SimBrief OFP, as of its release (not live); no message when nothing matters.
- **`REQ NOTAM [ICAO]`** (T95): the same summary for an airport of the flight plan (empty — the
  destination); `NO NOTAM DATA` for other airports. Listed in `HELP` and in the app's help.
- **Safety department FDM letter** (T94): 3 minutes after on-block, when flight data monitoring
  saw events — sink rate over 1000 fpm below 1000 ft above the aerodrome, gear or flaps not in
  landing configuration at 1000 ft, over 250 kt below 10 000 ft, go-around below 1000 ft (for
  information) — `SAFETY DEPT FDM` lists them with value, height and UTC time. Facts only, no
  score; reply `ACK` or `REPORT` (air safety report). No events — no letter.
- **Ground services by GSX Pro** (T98, MSFS): the bridge reads the state of GSX. With GSX in use
  the final loadsheet waits for the end of GSX boarding (at most 10 minutes past its time, then
  as scheduled), the fuel slip for the end of GSX refuelling, and the gate sends
  `BOARDING COMPLETED` with the passengers of the OFP and the LMC. Without GSX or in X-Plane —
  by the schedule, as before.
- **Type of charter** (T107): on a charter flight, a second list next to "Kind of flight" —
  tour (the default), sports team or VIP. A tour charter gets no sports team or VIP messages;
  the tour group change and the transfer coaches come only on a tour charter. Chosen by hand,
  the story of the type comes every time. Fixed at pushback.

### Changed

- All pre-departure messages (loadsheets, take-off data, fuel slip) come before pushback, also
  on a flight started late or with a slot; what is still waiting is sent at pushback (T61,
  late start version 4). Before, a slot could push some of them past pushback or drop them.
- Recording format: `flightKind.charter` in the header and the `tick` lines; older recordings
  replay as before (T107).
- The flight report and the logbook show the FDM events, one line each (T94).
- Recording format: `fdm` in the header; older recordings replay as before (T94).

### Known limits

- US domestic NOTAM have no Q-code in the SimBrief OFP and are left out of the summary, runway
  closures included.
- NOTAM text is cut to two display lines: a long "trigger" NOTAM may lose its point.
- FDM uses only the telemetry the bridge sends: no bank, pitch or approach speed checks.
- GSX with aircraft that board through their own EFB (Fenix and others) is not checked yet: if
  the aircraft does not set the GSX boarding to "completed", the final loadsheet comes up to
  10 minutes late (T98).

## 1.1.1 — 2026-11-06

- help explains how to turn off one kind of message (CTOT) (`task/T106-scenario-search`)
- weight units of the messages (as in the OFP / KG / LB) (`task/T105-mass-units`)

## 1.1.0 — 2026-11-05

### New

- **Kinds of flight** (T89): scheduled, charter, cargo, ferry, business or medevac — recognized
  from the OFP (FPL items 8b and 18, PAX and freight, aircraft type) and confirmed after loading;
  can be changed until off-block. Passenger scenarios run only on passenger flights; the kind is
  in the flight report and the recording.
- **Cargo flights** (T90): loadsheets without PAX, NOTOC with `CAO YES` for lithium batteries,
  special loads (AVI, PER, PIL, HUM, VAL), late truck, damaged ULD, weight correction, hub sort
  shift, temperature container failure. Aircraft families A300, B767, MD-11.
- **Charter and ferry flights** (T91): tour group changes, tour operator, sports team, VIP
  charter, transfer at the destination; crew-only loadsheet, ferry permit, release to service.
- **Business aviation** (T92): 16 families of business jets and turboprops; `FLIGHT SUPPORT`
  messages (handling and FBO, fuel release, catering, eAPIS into the US, car and crew hotel);
  flights without an airline, with the registration as callsign.
- **Departure board on the GSX VDGS** (T102): at the 35 A-CDM airports the board shows flight,
  destination, runway, SID, the airline's TOBT and a countdown, and `FLIGHT SUSPENDED / NEW
  TOBT REQUIRED` 15 min past the TOBT until a `DELAY`. Elsewhere — an optional board with the
  ETD (T103, off by default). SafeDock FLEX displays are supported.
- **MAYDAY / PAN on the ground** (T88): before take-off or after landing the rescue services
  of the airport where the aircraft stands come to it (MAYDAY — surround it, PAN — stand by
  ahead of the nose); OPS does not ask DIVERT / CONTINUE.
- **Smoke package for MSFS 2024** (T104): the smoke column of the fire scenarios now ships with
  the app. Advanced settings → "Smoke package for MSFS 2024" installs it into the Community
  folder of the Store and Steam versions, updates and removes it; nothing is copied without the
  button. Restart MSFS after installing. Own effect and texture, no SDK sample content.

### Fixed

- Bridge: `smoke_start`, `rescue_start` and `ping` answered "sim not connected" while MSFS was
  connected — SimConnect messages were lost in `acars_simconnect.dll` (`fix/simconnect-dispatch-queue`).
- VDGS: the app no longer writes over GSX's scrolling line (narrow 5, wide and x 6 lines); the
  narrow arrival board drops the `FROM` line (T22).
- The language list no longer marks machine translations.

### Changed

- LMC and passenger lines follow the kind of flight: no passenger LMC on cargo, none at all on
  ferry flights; `BAGGAGE BELT`, `TRANSFER PAX` and the like only with passengers.
- Recording format: `flightKind` and `rescueVersion: 2` in the header; older recordings replay
  as before.

### Known limits

- An airport handler script that sets the VDGS itself wins over the app (e.g. Aerosoft EDDF).
- The Hoppie sender stays `OPS{flight}`; `LOAD CONTROL`, `CHARTER HANDLING`, `FLIGHT SUPPORT`
  are in the message text.

## 1.0.0 — 2026-11-01

- About page and data sources (`task/T74-about`)
- bridge supervision (`task/T75-bridge-supervisor`)
- public build without CAL/eANP squawk tables and natTrak; NAT tracks from the SimBrief OFP (`task/T72-public-build`)
- SimConnect linked statically into acars_simconnect.dll; no Microsoft DLLs in the installer (`task/T73-simconnect-static`)
- tests: CI timeout, faster runs, 3 test shards in CI (`task/T76-test-timeouts`)
- releases: pnpm release, CHANGELOG.md, app version in the recording header (`task/T77-releases`)
- T72-T77 and tag on origin (`task/T78-backup`)
- bridge on .NET 10 LTS (`task/T79-dotnet10`)
- bridge stops with the app (`task/T80-bridge-parent`)
- fast-uri 3.1.9, weekly dependency audit (`task/T81-deps`)
- no .pdb, production CSP, trimmed bridge (`task/T82-installer-cleanup`)
- VATSIM and EONET terms, release decision, letters (`task/T83-data-terms`)
- release readiness findings in T84 (`task/audit-2026-11-01-release`)
- Electron 44.10.1, installer SHA-256, release notes, no MSFS 2020 (`task/T84-release-1.0`)

## 0.1.0 — 2026-10-31

- Starting point: everything merged into `master` up to this tag (tasks up to T71, docs/07).
