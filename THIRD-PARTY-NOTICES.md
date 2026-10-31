# Third-party notices

ACARS Link itself is proprietary (see `LICENSE`). The components and data below are not
covered by that licence and keep their own terms. "Status" is the state of our own
verification (docs/06-integrations.md has the details and dates), not legal advice.

## Two builds (T72)

`pnpm desktop:dist` builds the **public** installer; `pnpm desktop:dist:personal` the **personal**
one (private use, `ACARS-Link-Setup-personal-<version>.exe`). Data without a licence for
redistribution is in the personal build only; the public build has empty stand-ins
(`apps/desktop/variants/public`), `tools/release/verify-public.mjs` checks `out/` and `app.asar`.

| Data | Public | Personal |
|---|---|---|
| EUROCONTROL CAL squawk table | no | yes |
| ICAO APAC eANP squawk table | no | yes |
| natTrak (NAT tracks, downloaded) | no | yes |
| FAA NBCAP squawk table | yes | yes |

Without the tables the public build gives departures in Europe and Asia/Pacific a random squawk
(`0001`–`7777`, no special codes, none ending in `00`), the rule that already applies to the rest
of the world.

## Bundled in the installer

| Component / data | Licence | Status |
|---|---|---|
| Electron, Chromium | MIT and the licences in `LICENSE.electron.txt` / `LICENSES.chromium.html`, which electron-builder puts next to the app | automatic |
| React, Zustand, Vite runtime parts bundled into the renderer | MIT | texts of the bundled packages (also ajv, yaml and their dependencies) are collected by `pnpm licenses` into `THIRD-PARTY-LICENSES.txt` |
| .NET 8 runtime and ASP.NET Core (self-contained bridge) | MIT, Microsoft | `LICENSE.TXT` and `THIRD-PARTY-NOTICES.TXT` of the runtime packs go into `THIRD-PARTY-LICENSES.txt` (`pnpm licenses`) |
| SimConnect client, linked statically into `acars_simconnect.dll` from the official MSFS SDK 1.8.1 (`SimConnect SDK\lib\static\SimConnect.lib`; the SDK supplies the library and its property sheet for this use). `SimConnect.dll` and `Microsoft.FlightSimulator.SimConnect.dll` are **not** shipped (T73) | Microsoft MSFS SDK EULA | **not verified, checked 2026-10-31:** no written permission from Microsoft/Asobo to redistribute the client code (devsupport.flightsimulator.com, topics 18233, 18295: no answer). Needs a written answer before a public release |
| OpenFlights `airlines.dat`, `airports.dat`, `routes.dat`, `planes.dat` as `packages/core/src/ext/openflights.ts` | ODbL 1.0, Database Contents License; route data public domain; airline data from Wikipedia may be GFDL. Source: OpenFlights.org. Non-commercial use only without a separate OpenFlights licence | attribution required; the derived table stays under ODbL |
| EUROCONTROL SSR Code Allocation List v4.13 (squawk tables) — **personal build only** | EUROCONTROL / ICAO EUR Doc 023 | reuse terms **not verified** (checked 2026-10-31: `eurocontrol.int` states none, only "© EUROCONTROL"); not in the public build until EUROCONTROL allows it in writing |
| ICAO APAC eANP Vol II Part IV, Table ATM II-APAC-2 (squawk tables) — **personal build only** | (c) ICAO, "All rights reserved", reproduction only with written permission (`icao.int/pages/copyright.aspx`, checked 2026-10-31) | not in the public build until ICAO allows it in writing |
| FAA JO 7110.66H NBCAP tables | public domain | ok |
| SERA Appendix 3 / ICAO Annex 2 Appendix 3 (flight level table) | Reg. (EU) 923/2012, EUR-Lex reuse allowed | ok |
| NASA Five Millennium Canon of Solar Eclipses (eclipse table) | NASA: reproduction permitted with source credit | credit: F. Espenak and J. Meeus, NASA |
| Air show and aviation history tables | each entry has its source and verification date in the source file | see files |

## Downloaded by the app at run time (not shipped)

| Service / data | Terms | Status |
|---|---|---|
| Hoppie's ACARS (hoppie.nl) | no written terms for third-party clients found on the site; owner contact hoppie@hoppie.nl | **open, ask the owner before public release** |
| VATSpy Data Project (FIR boundaries, VATSIM centres) | CC BY-SA 4.0, attribution to the VATSpy Data Project | attribution required |
| VATSIM data | VATSIM terms | see the VATSIM data rules |
| natTrak (NAT tracks) — **personal build only** | natTrak (vatsimnetwork/nattrak) has no API terms in its README, and no licence file was found (checked 2026-10-22, again 2026-10-31) | **not verified**, ask the VATSIM tech team; not in the public build (tracks come from the SimBrief OFP) |
| OurAirports | public domain | ok |
| OpenStreetMap via Overpass API | ODbL, (c) OpenStreetMap contributors | attribution required |
| aviationweather.gov (METAR, TAF, SIGMET) | US government data | rate limit 100 requests/min respected |
| NASA EONET | NASA open data | verify |
| NOAA SWPC | US government data, public domain (`spaceweather.gov` footer → `weather.gov/disclaimer`, checked 2026-10-31); do not present it as our own, do not present modified data as official, do not imply NOAA endorsement | ok |
| USGS earthquake feed | USGS-authored data is U.S. public domain; credit requested: "U.S. Geological Survey" (usgs.gov copyright page, checked 2026-10-22) | ok, credit given here |
| TheSpaceDevs Launch Library 2 | "free to use the data in any way" (`github.com/TheSpaceDevs/Tutorials`, `faqs/faq_TSD.md`, checked 2026-10-31); attribution optional, they ask to cache and not to call from clients; 15 requests/hour without a key | ok, source named here |
| Nager.Date public holidays | private and non-commercial use; commercial use needs sponsorship | non-commercial only |
| Jolpica F1 (Ergast successor) | data CC BY-NC-SA 4.0 | non-commercial only |
| AeroDataBox via RapidAPI | user's own RapidAPI key and plan | terms of the user's plan apply |
| SimBrief | user's own account | terms of SimBrief apply |

"Verified" lines come from the checks recorded in `docs/06-integrations.md`. Lines marked
"not verified" must be resolved before the installer is given to other people.

## Where the app names its sources (T74)

- Help → "About ACARS Link": versions (app, bridge, Electron, build) and the list of all components
  and data of the installed build with licence and credit (`apps/desktop/src/shared/sources.ts`;
  the personal-only rows above are left out of the public build's list). A test keeps the list in
  step with the two tables above. Buttons there open the licence agreement (`EULA.txt`), this file
  and `THIRD-PARTY-LICENSES.txt` from the installation folder.
- Settings, next to the data they use, worded as the source asks: "© OpenStreetMap contributors"
  (live data), "VATSpy Data Project, CC BY-SA 4.0" (XATC station), "OpenFlights.org, ODbL" (the
  next leg).
