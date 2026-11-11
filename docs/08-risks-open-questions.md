# 08 — Risks and open questions

## Stage 0 decisions (recorded 2026-10-07)

1. **Shell:** Electron.
2. **Bridge:** C# / .NET 10 LTS (T79, 2026-10-31: .NET 8 support ends 2026-11-10, .NET 10 on 2028-11-14); SimConnect through our own DLL `acars_simconnect.dll` (C++, the SimConnect client is statically linked from the official MSFS SDK; T73, decision 2026-10-31; before that — the SDK's managed wrapper).
3. **Simulators:** MSFS 2020/2024. X-Plane 12 — later (T18); we do not tie the core and the bridge protocol to MSFS. **Decision 2026-11-01 (T84):** MSFS 2020 is not supported — only MSFS 2024 and X-Plane 12 (the SimConnect client from the 2024 SDK was not tested in MSFS 2020, T73 item 4).
4. **Backend and LLM:** not needed at the start. Free APIs without keys only. Backend is optional, T16.
5. **Transport:** Hoppie at the start, SayIntentions later (T17).
6. **Name:** none yet, codename `acars-sim`. **Station callsign:** a configurable template (`OPS{flight}`, `{airline}OPS`, custom). The default is `OPS{flight}`. Reason: per `tech.html`, Hoppie allows one callsign to hold only one logon code (the lock is released after 100 s), and `{airline}OPS` conflicts more often between different users. Whether the lock extends to the telex `from` field (and to XATC stations `X…` of different users) is `[AT RELEASE]`.
7. **UI language:** English + Russian (i18n from day one). ACARS messages are always English, upper case. **Request 2026-11-01:** also German, French, Spanish, Japanese — cards T85–T87 (docs/07). Since T85 the languages are the `LANGUAGES` list (`apps/desktop/src/shared/api.ts`: self-name, `ready`, `machine`); no translation — English text; Russian is mandatory; the default language is by OS locale among the ready ones, otherwise English. T86, T87: DE, FR, ES (`es-ES`), JA — DeepL machine translation with a mark in the language list until a native speaker checks it; Japanese font — system only (Yu Gothic UI / Meiryo).
8. **Aircraft for the human check:** Fenix A320, PMDG 777, iniBuilds A350, iniBuilds A380, iniBuilds A340. iFly 737 MAX 8 is excluded (user, 2026-10-23): it currently has no CPDLC support.
9. **Distribution:** at the start — **personal use**, to evaluate realism. An installer, code signing and auto-update (T19) are not needed yet. If we decide to release to the community — **before the release** a letter to the Hoppie owner (hoppie@hoppie.nl): acceptability of use, the callsign scheme, the lock on `from`, HTTPS/POST, telex length. Then the repository license, signing (T19), a check of the terms of all APIs for public use, including the squawk tables (EUROCONTROL CAL, ICAO APAC eANP — T24) and VATSpy data (CC BY-SA 4.0, T23).

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Breaking Hoppie etiquette or rules (spam, fake stations) → ban | medium | high | rate limit, study the rules, contact the network owner before the public release |
| Differences in telex display between add-ons | high | medium | DisplayProfile + human check against a checklist |
| Changes in SimConnect / MSFS 2024 | medium | medium | isolation in the bridge, protocol version |
| FSM errors on non-standard flights | high at the start | high | replay recordings, discontinuity, manual phase override in the UI |
| Monotonous content | medium | high | data-driven scenarios, probabilities, cooldowns, flags between flights |
| Legal: copying code or assets of other ACARS apps | low if the rules are followed | high | invariant 1, write from scratch |
| API key leak | — | high | keys only on the backend or in the user's keychain |
| Free API limits (TheSpaceDevs, Overpass) | medium | low | cache, degradation |

## Known unknowns

- The exact grammar of Hoppie poll replies and the length limits.
- The behavior of SIMULATION RATE and pause in MSFS 2024.
- Line width for each add-on.

## Deferred until the public release `[AT RELEASE]`

User decision 2026-10-09: questions that do not require a human check in the simulator and do not hinder personal use are closed until the public release. For now the accepted decision or assumption applies (`07`, "Realism rule", item 5). Go through the whole list before the release.

| Where | Question | Current state |
|---|---|---|
| `08` decisions 6, 9 | Whether the Hoppie callsign lock extends to the telex `from` field and to XATC stations `X…`; acceptability of `OPS<flight>` and stations `X…`; the letter to the Hoppie owner | Callsigns per decisions T09/T23/T24 |
| T23 | VATSpy license (CC BY-SA 4.0): attribution terms on distribution | The files are downloaded by the app, the repository has a trimmed fixture |
| T24 | Terms of use of EUROCONTROL CAL v4.13 and ICAO APAC eANP | **T72 (2026-10-31):** there is no permission (CAL — no terms; eANP — "All rights reserved"). The tables are in the personal build only, the public one gets random code; re-enable on written permission from EUROCONTROL / ICAO. The tables are in the repository as TS data |
| T73 | Written permission from Microsoft/Asobo to distribute the SimConnect client (inside `acars_simconnect.dll`; topics 18233, 18295 on devsupport.flightsimulator.com unanswered as of 2026-10-31) | The client is statically linked from the SDK, `SimConnect.dll` and the wrapper are not shipped |
| T24 | The Mode S rule (code 1000) in Europe | 1000 only in the ban list |
| T25 | AIP France ENR 1.3.5 and the lower limit of the UTA | Reverse parity above FL195 |
| T25 | AIP Italia ENR 1.7 | Italy — per ICAO |
| T25 | Metric levels of China and DPRK (AIP) | The ICAO feet table |
| T25/T26 | Format of `stepclimb_string` with several steps (a real OFP) | Parsing `FIX/0410` pairs |
| T26 | The Canadian standard-pressure region, other US territories | 18,000 ft for `K`/`PA`/`PH`/`C`, otherwise a level |
| T27 | A real transatlantic OFP: the `fir`, `tracks` fields, coordinate points; natTrak terms | A synthetic EGLL–KJFK OFP in the tests. **T72:** natTrak only in the personal build; in the public one the tracks come from the OFP `tracks` (format taken from a real KATL–EDDF OFP on 2026-10-31; a real westbound OFP with the western tracks A–F was not checked on Shanwick) |
| T28 | TheSpaceDevs data license | Closed 2026-10-31: "free to use the data in any way" (TheSpaceDevs FAQ); no key, 15 requests/h. NOAA SWPC — public domain, closed at the same time |
| T83 | Terms of NASA EONET and VATSIM data | Closed 2026-11-01 (T83): VATSIM — Commercial Use Policy v2.0, free non-commercial use without a Data Use License (§3.5), a paid or ad-supported version only with a license; EONET — CC0 (Earthdata), the "for general information" disclaimer, "NASA EONET" in "About". Details — docs/06 |
| T79 | End of .NET 8 support — 2026-11-10; the bridge is published with its own runtime, the installer has 8.0.28 while the current is 8.0.33 | Closed 2026-10-31 (T79): the bridge is on `net10.0`, `bridge/msfs/publish` has runtime 10.0.14 (SDK 10.0.403); .NET 10 support lasts until 2028-11-14 |
| `02`, `06` | IVAO adapter | None |

## Decision 2026-11-01 (T83): public installer before the answers

User decision 2026-11-01: the public installer (`pnpm desktop:dist`) **may be given to other people** without waiting for answers from the Hoppie owner and Microsoft/Asobo (the SimConnect client in `acars_simconnect.dll`). The rows in "Deferred until the public release" (Hoppie, T73) stay open until the answers arrive. Draft letters — `docs/_drafts/T83-letters.md`, sent by the user. A "no" answer is a separate card: what to remove from the public build. The personal build and the EUROCONTROL/ICAO tables and natTrak are not changed by this decision (T72: only with written permission).

## Decisions and cross-check 2026-10-22

- **License:** proprietary (All rights reserved + EULA); we do not do code signing (T19, `07`).
- **Human check on the main aircraft — passed** (reported by the user, 2026-10-22): Fenix A320, PMDG 737, PMDG 777, iniBuilds A380, iniBuilds A350. iniBuilds A340 — passed (reported by the user, 2026-10-23): at the stand and a full flight. iFly 737 MAX 8 is excluded from the list — no CPDLC support. The user did not list the individual open `[VERIFY]` items in `07` for these aircraft, and they are not closed automatically.
- **Hoppie, cross-check with tech.html and faq.html (2026-10-22).** The user brought a summary from an external source; it is **not an answer from the owner** and in part contradicts the site, so item 1 of "Deferred until release" is not closed. Per the site: the lock is the combination logon code + network + callsign, 100 s, after any request except peek and ping, error `callsign already in use`; the `from` field is **not mentioned**. POST is allowed and recommended (the URL is better kept to 256 characters). There is **no** maximum message length for Hoppie; "about 4 KB" refers to real ACARS, the site asks not to send kilobytes. There are no rules for station names (`OPS…`, `X…`): the callsign is not restricted, but the question of acceptability is unresolved. Polling — once every 45–75 s at random, up to once every 20 s for a short time after sending, timeout 15 s. The site has no terms for third-party clients and commerce; the page says "All rights reserved, including text and data mining". Contact: hoppie@hoppie.nl. Remaining: the letter to the owner (lock on `from` and stations `X…` of different users, acceptability of `OPS<flight>`).
