# Fixtures

Trimmed real responses of the data sources (docs/06 "Внешние данные").

- `vatspy-boundaries.json`, `vatspy.dat` — excerpts of the VATSpy Data Project
  (https://github.com/vatsimnetwork/vatspy-data-project), release v2610.1, taken 2026-10-09:
  the `Boundaries.geojson` features `EDGG`, `EDGG-N`, `EDMM`, `EGTL`, `EGTT`, `EDXX` unchanged,
  and the matching `[Countries]`, `[Airports]`, `[FIRs]` and `[UIRs]` lines of `VATSpy.dat`. Licence: CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/), © VATSIM / VATSpy Data Project
  contributors; these two files are shared under the same licence.

- `launches.json` — TheSpaceDevs Launch Library 2.3.0 `GET /2.3.0/launches/?mode=normal&ordering=net&limit=100&net__gte=2026-10-06T00:00:00Z&net__lte=2026-10-10T12:00:00Z`, taken 2026-10-09: all 3 launches (Nuri — Success, Long March 12 and Falcon 9 — Go), trimmed to the fields the adapter reads plus a few identifying ones (images, descriptions, agency details dropped). Licence of the data is not stated by The Space Devs (`[ПРОВЕРИТЬ]`, docs/06).

- `nattrak-tracks.json` — the whole answer of natTrak `GET https://nattrak.vatsim.net/api/tracks`, taken 2026-10-09 (5 westbound tracks A–E, valid 11:30–19:00Z), unchanged. natTrak takes the tracks from the NAT track NOTAMs; its terms of use are not published (`[ПРОВЕРИТЬ]`, docs/06).

- `ourairports-frequencies.csv` — the header and the EDDF, EFHK and KMSP rows of OurAirports
  `airport-frequencies.csv` (https://davidmegginson.github.io/ourairports-data/), taken
  2026-10-09. Public domain ("All data is released to the Public Domain").

- T29, all taken 2026-10-09:
  - `noaa-scales.json` — NOAA SWPC `noaa-scales.json`, the whole answer, unchanged.
  - `ovation-aurora.json` — NOAA SWPC `ovation_aurora_latest.json`, header unchanged, `coordinates` cut to latitudes 60–70°, longitudes 0–30°.
  - `isigmet-va.json` — aviationweather.gov `isigmet?format=json`, 4 of the VA SIGMETs (WAAF 06, 09; MHTG A3, A3F), unchanged.
  - `usgs-4.5-day.geojson` — USGS `4.5_day.geojson`, the whole answer, unchanged (USGS terms `[ПРОВЕРИТЬ]`).
  - `nager-2026-de.json` — Nager.Date `PublicHolidays/2026/DE`, unchanged.
  - `jolpica-f1-last.json` — Jolpica `f1/current/last/results.json`, unchanged (CC BY-NC-SA 4.0, © Jolpica contributors).
  - `nhl-score.json` — `api-web.nhle.com/v1/score/2026-10-08`, 3 of the 10 games, `gameWeek` and `oddsPartners` dropped.
  - `ourairports-airports.csv` — the header and the EDDF, EGLL, KJFK, RJBB and `00A` rows of OurAirports `airports.csv` (public domain).
- T38, taken 2026-10-14: `ourairports-drone-airports.csv` — the header and the UUEE, EDDM, EKCH, OMDB, KJFK and RJBB rows of OurAirports `airports.csv` (public domain).

- T34, taken 2026-10-15: `ourairports-runways.csv` — the header and the EDDF, KSFO and RJBB rows of OurAirports `runways.csv` (public domain).
