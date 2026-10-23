# Third-party notices

ACARS Link itself is proprietary (see `LICENSE`). The components and data below are not
covered by that licence and keep their own terms. "Status" is the state of our own
verification (docs/06-integrations.md has the details and dates), not legal advice.

## Bundled in the installer

| Component / data | Licence | Status |
|---|---|---|
| Electron, Chromium | MIT and the licences in `LICENSE.electron.txt` / `LICENSES.chromium.html`, which electron-builder puts next to the app | automatic |
| React, Zustand, Vite runtime parts bundled into the renderer | MIT | texts of the bundled packages (also ajv, yaml and their dependencies) are collected by `pnpm licenses` into `THIRD-PARTY-LICENSES.txt` |
| .NET 8 runtime and ASP.NET Core (self-contained bridge) | MIT, Microsoft | `LICENSE.TXT` and `THIRD-PARTY-NOTICES.TXT` of the runtime packs go into `THIRD-PARTY-LICENSES.txt` (`pnpm licenses`) |
| `SimConnect.dll` (MSFS SDK, copied into the bridge) | Microsoft MSFS SDK EULA | **not verified, checked 2026-10-22:** the SDK EULA allows "distributable code" but no document names `SimConnect.dll` as such; the questions on devsupport.flightsimulator.com (topics 18233, 18295, latest post 2026-10-13) have no answer from Microsoft/Asobo. Needs a written answer before a public release |
| OpenFlights `airlines.dat`, `airports.dat`, `routes.dat`, `planes.dat` as `packages/core/src/ext/openflights.ts` | ODbL 1.0, Database Contents License; route data public domain; airline data from Wikipedia may be GFDL. Source: OpenFlights.org. Non-commercial use only without a separate OpenFlights licence | attribution required; the derived table stays under ODbL |
| EUROCONTROL SSR Code Allocation List v4.13 (squawk tables) | EUROCONTROL / ICAO EUR Doc 023 | reuse terms **not verified** (checked 2026-10-22: the publication page and search results state none; ask EUROCONTROL / the ICAO EUR/NAT Office) |
| ICAO APAC eANP Vol II Part IV, Table ATM II-APAC-2 (squawk tables) | (c) ICAO | reuse terms **not verified** |
| FAA JO 7110.66H NBCAP tables | public domain | ok |
| SERA Appendix 3 / ICAO Annex 2 Appendix 3 (flight level table) | Reg. (EU) 923/2012, EUR-Lex reuse allowed | ok |
| NASA Five Millennium Canon of Solar Eclipses (eclipse table) | NASA: reproduction permitted with source credit | credit: F. Espenak and J. Meeus, NASA |
| Air show and aviation history tables | each entry has its source and verification date in the source file | see files |

## Downloaded by the app at run time (not shipped)

| Service / data | Terms | Status |
|---|---|---|
| Hoppie's ACARS (hoppie.nl) | no written terms for third-party clients found on the site; owner contact hoppie@hoppie.nl | **open, ask the owner before public release** |
| VATSpy Data Project (FIR boundaries, VATSIM centres) | CC BY-SA 4.0, attribution to the VATSpy Data Project | attribution required |
| VATSIM data, natTrak | VATSIM terms; natTrak (vatsimnetwork/nattrak) has no API terms in its README, and no licence file was found (checked 2026-10-22) | **not verified**, ask the VATSIM tech team |
| OurAirports | public domain | ok |
| OpenStreetMap via Overpass API | ODbL, (c) OpenStreetMap contributors | attribution required |
| aviationweather.gov (METAR, TAF, SIGMET) | US government data | rate limit 100 requests/min respected |
| NASA EONET | NASA open data | verify |
| NOAA SWPC | US government data; the data-access page (checked 2026-10-22) has no terms, only links to the NOAA disclaimer | **not verified** |
| USGS earthquake feed | USGS-authored data is U.S. public domain; credit requested: "U.S. Geological Survey" (usgs.gov copyright page, checked 2026-10-22) | ok, credit given here |
| TheSpaceDevs Launch Library 2 | no licence, attribution or commercial-use terms on thespacedevs.com/llapi (checked 2026-10-22); 15 requests/hour without a key | **not verified**, ask TheSpaceDevs |
| Nager.Date public holidays | private and non-commercial use; commercial use needs sponsorship | non-commercial only |
| Jolpica F1 (Ergast successor) | data CC BY-NC-SA 4.0 | non-commercial only |
| AeroDataBox via RapidAPI | user's own RapidAPI key and plan | terms of the user's plan apply |
| SimBrief | user's own account | terms of SimBrief apply |

"Verified" lines come from the checks recorded in `docs/06-integrations.md`. Lines marked
"not verified" must be resolved before the installer is given to other people.
