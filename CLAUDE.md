# CLAUDE.md

ACARS simulator for flight simulators: reads simulator telemetry and the SimBrief plan, detects the flight phase and, following scenarios, sends realistic "airline" messages to the cockpit (loadsheets, reports, gate, delays, irregular situations) over the Hoppie ACARS / SayIntentions network. The pilot can reply and request data.

## Documents (source of truth)

- `docs/02-product-vision.md` — what we build and what we do not.
- `docs/03-architecture.md` — architecture, stack, telemetry schema.
- `docs/04-flight-phase-fsm.md` — flight phase state machine.
- `docs/05-scenario-engine.md` — scenario format.
- `docs/06-integrations.md` — external protocols and APIs.
- `docs/07-roadmap-tasks.md` — **task cards. Work strictly to the card the user named.**
- If the code disagrees with a document — stop and ask. Do not edit the document silently.

## Invariants — must not be broken

1. **No third-party code is copied.** Code of other ACARS apps is not reused, even when its `package.json` says MIT; only publicly documented ideas, SimVar lists, timings and message formats.
2. **No secrets in the client.** LLM/RapidAPI/other keys — only on the backend or in user settings (entered by the user, stored in the OS keychain). No keys in the repository, logs, code. `.env*` — in `.gitignore`.
3. **The core (`packages/core`) is pure TypeScript.** It does not import Electron/Tauri, DOM, Node API, network. Input — telemetry snapshots and time, output — "send message" commands. This makes it deterministically testable.
4. **Time and randomness are injected.** No direct `Date.now()` and `Math.random()` in the core — only through the passed `Clock` and seeded `Rng`. The same (OFP, telemetry recording, seed) → the same messages.
5. **Logic does not run on UI timers.** No `setTimeout` in React components for business logic. Everything goes through the FSM + scheduler in the core.
6. **Respect the Hoppie network.** Request rate limiting (poll no more often than recommended, see `06-integrations.md`), send queue with rate limit, no retries in a loop without backoff.
7. **Transport only through the adapter** (`Transport` interface). Hoppie, SayIntentions and mock are interchangeable.
8. **The LLM does not generate numbers.** Weights, fuel, times, runway, gate — only from data/deterministic logic. The LLM is allowed only to "liven up" free text on top of a template, with validation (line length, only A–Z0–9 and allowed characters) and fallback to the template.
9. **Messages go through formatting for the display profile** (line width, upper case, forbidden characters). No message is sent bypassing the formatter.
10. No HTTP without TLS to our own servers. The local bridge to the simulator listens **only on 127.0.0.1**.

## How to work

- One session = one `Txx` card. Anything found outside its scope — into the "Notes" section of the report.
- One branch per task: `task/Txx-short-name`. Commit at the end after green checks. Push/merge/release — only when the user asks.
- Before "done": `pnpm check` (= `pnpm typecheck && pnpm lint && pnpm spdx && pnpm test`). The same checks and `pnpm bridge:test` run in GitHub Actions on every push (`.github/workflows/check.yml`, T63; tests — in 3 parallel jobs `vitest --shard`, T76; the remote repository is `AVAILOFF/acars-link`). `testTimeout` — 20 s locally, 60 s under `CI` (`vitest.config.ts`). Dependency vulnerabilities (npm `--prod` and the bridge's NuGet) — `.github/workflows/audit.yml`, weekly and manually (T81); the whole npm tree with build tools — there too, warning only (T84).
- **Realism and data verification** (mandatory for stage 5 in `07`, desirable everywhere): data and formats — only from verified sources with a verification date and license; do not guess. Any assumption (simplification, heuristic, synthetic data) — first describe it to the user and get explicit approval, then implement; record what was approved in the card. Details — `07`, "Realism rule".

## Commands

Node ≥ 24, pnpm 12. Stack: TypeScript 7 (strict), Biome 2, Vitest 5.

```
pnpm install
pnpm check            # typecheck + lint + spdx + test — before "done" and before a commit
pnpm spdx             # every source file (ts/tsx/js/mjs/cjs/cs/py) has an SPDX header and copyright (T62); --write — add them to new files
pnpm typecheck        # tsc across all packages: src (without Node/DOM types) and tests separately
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm test             # vitest run (projects packages/*)
pnpm build            # tsc → packages/*/dist
pnpm -F @acars/core test   # tests of one package
pnpm desktop:dev      # Electron app (apps/desktop) with HMR renderer
pnpm desktop          # build apps/desktop/out and run
pnpm hoppie:telex --to <CALLSIGN> [--from OPS…] [--text …] [--listen 180]   # manual telex to Hoppie; logon code — only from env HOPPIE_LOGON
pnpm replay run <recording.jsonl> [--scenarios <yaml|folder>] [--only id,…] [--check] [--pilot "<min>=<text>"]   # run a recording through the core (tools/replay); --pilot — pilot messages
pnpm replay synth --ofp <simbrief.json> --out <file.jsonl>   # synthetic flight as a recording; pnpm replay --help
pnpm replay summary <recording.jsonl> [--json] [--check]   # T69 flight summary from a recording; --check — compare with the app's summary line
pnpm desktop:dist     # Windows installer, PUBLIC variant (T72): without the EUROCONTROL CAL / ICAO APAC eANP squawk tables and without natTrak; apps/desktop/release/ACARS-Link-Setup-<version>.exe (NSIS, unsigned; bridge — in resources/bridge); after the build tools/release/verify-public.mjs checks out/ and app.asar
pnpm release <X.Y.Z> [--no-dist] [--any-branch]   # release (T77): on master, clean working copy; version in apps/desktop/package.json and the bridge .csproj, CHANGELOG.md section from `Merge task/…` since the previous tag (a manual `## Unreleased` becomes this section), pnpm check + bridge:test (on error — files are restored), commit "Release vX.Y.Z", tag vX.Y.Z, desktop:dist and `ACARS-Link-Setup-<version>.exe.sha256` (T84); release notes — per `tools/release/RELEASE-NOTES.template.md`; push — only when the user asks; README.md, "Releases"
pnpm i18n translate --lang de,fr,es,ja [--only msg,help,scn] [--dry] [--force]   # machine translation of the UI (T86/T87, tools/i18n): DeepL (key — DEEPL_AUTH_KEY in env or in .env.local) with the glossary docs/glossary-i18n.md, fallback — Ollama (--engine ollama, OLLAMA_MODEL); translates only new text (memory tools/i18n/memory), keeps manual edits in messages-/help-<lang>.ts and locales/<lang>.yaml; pnpm i18n status — how much is translated
pnpm desktop:dist:personal   # the same, PERSONAL variant (everything included), ACARS-Link-Setup-personal-<version>.exe; the variant is chosen by ACARS_BUILD=public|personal for electron-vite (tools/release/build.mjs), stubs — apps/desktop/variants/public
pnpm run licenses     # (exactly `run`: `pnpm licenses` is a built-in pnpm command) license texts of the bundle's npm packages and .NET → apps/desktop/build/third-party-licenses.txt (part of desktop:dist)
pnpm icon             # app icon: design/logo/*.svg → apps/desktop/build/icon.{ico,png} (rendered through Electron)
node tools/smoke-texture/generate.mjs   # T104 smoke texture (seed 104) → bridge/msfs/package/PackageSources/MaterialLibs/acars-smoke-materiallib/Textures/acars_smoke.png; our own, not from the SDK sample (SDK EULA cl. 1 b)
pnpm bridge:publish   # bridge as a self-contained folder with an exe (no .NET needed, .NET 10 runtime inside, T79; trimmed — PublishTrimmed, JSON only through source-gen `BridgeJson`, T82; `.pdb` → bridge/msfs/symbols) → bridge/msfs/publish (the folder is cleaned before publishing); it contains `acars_simconnect.dll` and no `SimConnect.dll` / `Microsoft.FlightSimulator.SimConnect.dll` (T73; the csproj removes them from the folder, `tools/release/verify-bridge.mjs` checks)
pnpm bridge:build     # dotnet build bridge/msfs (C# bridge, .NET 10; SimConnect (T73): if the official MSFS SDK is found (-p:MsfsSdk="C:\MSFS 2024 SDK", `bridge/msfs/Local.props`, MSFS2024_SDK) and Visual Studio Build Tools 2022 with C++ x64, `acars_simconnect.dll` is built from bridge/msfs/native with the static SimConnect.lib; without the SDK the bridge is built without SimConnect — as in CI); by default the bridge finds MSFS or X-Plane 12 itself (--source auto, T59); manually — --source simconnect | xplane
pnpm bridge:test      # dotnet test bridge/msfs — on changes in bridge/ also before "done"
pnpm bridge:smoke     # smoke test of the PUBLISHED bridge (bridge/msfs/publish, trimmed — T82): fake, replay, busy port → 4, --parent-pid; part of desktop:dist
```

`apps/desktop` — Electron 44 + electron-vite 5 (Vite 7: electron-vite does not support Vite 8) + React 19 + Zustand. The main process bundles the workspace packages into one bundle; preload — one CJS file (sandbox). The renderer does not import Node/Electron/transport (Biome rule) and talks to main only through `window.acars`. Logic without Electron — `src/main/controller.ts`, tests in `apps/desktop/test`. The Electron binary is downloaded on first run.

`packages/data-sources` (`@acars/data-sources`) — external data adapters (T13): METAR/TAF, VATSIM, EONET, OSM stands, TheSpaceDevs rocket launches (T28), T29 special events (NOAA SWPC, SIGMET VA, USGS, Nager.Date, Jolpica F1, NHL — by the "Sport"/"Aviation"/"Other" groups in settings), T30 connecting flights (AeroDataBox via RapidAPI, the key is entered by the user — `SecretStore` `aerodataboxKey`; flight selection — `packages/core/src/ext/connex.ts`; data older than 7 days is purged from recordings — `tools/replay/src/purge.ts`), T55 next flight from AeroDataBox data (departures with `aircraft.model` and route statistics, disk cache up to 7 days; the "model → family" table — `packages/core/src/ext/aircraft-models.ts`, selection — `packages/core/src/scenario/ops-data.ts`, `nextLegVersion: 3`); no Node API, HTTP through injection. The core receives data only as the `CoreInput.data` input (written to the flight recording). Live-data scenarios — `packages/scenarios/external/`, irregular ones (T14, `set`, flags between flights — "airline memory" in `<userData>/airline-memory.json`) — `packages/scenarios/irregular/`, in-sim effects (T22, step `vdgs:` → GSX file `%APPDATA%\Virtuali\GSX\VGDS\acars-sim.json`) — `packages/scenarios/sim/`; T102 departure board (`vdgs_departure`: the airline's TOBT instead of GSX `flight_information`) — only at A-CDM airports from `packages/core/src/ext/acdm-airports.ts`; elsewhere — `vdgs_departure_etd` (T103, ETD, off by default, not a real board).

UI languages (T85): the `LANGUAGES` list in `apps/desktop/src/shared/api.ts` (self-name, `ready` — show in the list, `machine` — "machine translation" mark); strings — `apps/desktop/src/renderer/src/messages-<lang>.ts` (English — all keys, Russian is mandatory, the others may lag behind — then English is used), help — `help-<lang>.ts`, scenario texts — `packages/scenarios/locales/<lang>.yaml` (scenario YAML is English only; steps with a hint have an `id`), main strings (close dialog, XATC hints, source captions) — also in `messages-<lang>.ts` (`close.*`, `hint.atc.*`, `src.*`; in main — `translator` / `catalogText` from `i18n.ts`). Languages DE/FR/ES/JA — machine translation (T86, T87), glossary — `docs/glossary-i18n.md`; Japanese — Windows system fonts (`--font-ui`), line breaking `:lang(ja)` in `styles.css`, help search — NFKC (`help.ts`). ACARS messages are not translated.

XATC ATC station (T23) — `packages/core/src/atc/` (Hoppie CPDLC packets, FIR, station `X`+FIR), FIR boundaries and VATSIM centers — `packages/data-sources/src/vatspy.ts`, in the app — the "XATC station" setting. DCL/PDC (T24) — `packages/core/src/atc/dcl.ts` (station `X`+departure airport), squawk tables — `packages/core/src/atc/squawk/` (generated, do not edit by hand), frequencies — `packages/data-sources/src/ourairports.ts`. Pilot requests to the XATC station (T25: level, speed, Direct To) — `packages/core/src/atc/requests.ts`, level table and state rules — `levels.ts`, ceilings and VMO/MMO per TCDS — `performance.ts`; automatic Direct To, step climb and descent (T26) — `auto.ts`; NAT oceanic clearance (T27: RCL, CLX Shanwick, CLA) — `oceanic.ts`, NAT tracks — `packages/data-sources/src/nattrak.ts`.

Smoke package for MSFS 2024 (T104): the built package — `bridge/msfs/package/dist/avail-acars-smoke` (in the installer `resources/avail-acars-smoke`; the name was given by the SDK: company `avail` + `acars-smoke`), installation into Community only via a button in settings — `apps/desktop/src/main/smoke-package.ts` (Community — from `InstalledPackagesPath` in `UserCfg.opt` Store/Steam, the rules of the SDK PackageInstaller sample); texture — `tools/smoke-texture`, SDK samples are not redistributed (EULA cl. 1 b).

Rescue services (T54): step `rescue` → core command `rescue`, vehicle rules — `packages/core/src/sim/rescue.ts`, runways and `large_airport` — `packages/data-sources/src/ourairports.ts`, `rescue_start` / `rescue_stop` to the bridge from `controller.ts`, logic in the bridge — `bridge/msfs/src/AcarsBridge/RescueController.cs`.

Special events (T29): variables — `packages/core/src/scenario/special-vars.ts`, eclipses/air shows/aviation history — the tables `packages/core/src/ext/{eclipses,airshows,aviation-history}.ts` (`eclipses.ts` is generated by `node tools/eclipse-table/generate.mjs <besselian.csv>`, do not edit by hand; air shows and facts have a source and verification date). Night curfews at destination airports (T42, scenario `curfew_dest`) — the table `packages/core/src/ext/curfews.ts` (only real landing bans, each entry has a source and verification date; no entry — no message).

`tools/replay` (`@acars/replay`) — flight recording format (JSONL: a header with the OFP and core options, then the core inputs in order), running through the core, CLI. The app writes a recording of every flight to `<userData>/recordings` (the "Record flights" setting, the last 20 are kept; when off — a temporary recording in `<userData>/flight-temp`, deleted with the flight). Flight restore after closing or a crash (T64) — from this recording: `apps/desktop/src/main/recording.ts` (`fileResume`, 24 h), `FlightSession` with `resume` (`session.ts`), core options from the header — `recordedCoreOptions` (`tools/replay/src/run.ts`); the `sent` and `resume` lines — docs/03, `tools/replay/README.md`.

Logs (T67): `<userData>/logs/main.log` (main process) and `bridge.log` (bridge stdout/stderr), 5 files × 5 MB each, UTC time — `apps/desktop/src/main/log.ts`; every line goes through `Redactor` (logon code, RapidAPI key, SimBrief name, bridge token → `***`; it learns the secrets from `SecretStore`). "Export diagnostics" (Advanced settings → Diagnostics) — one .zip: logs, versions, settings without secrets, optionally (checkbox) the last flight recording (`diagnostics.ts`, own zip — `zip.ts`).

Ground handling via GSX (T98): the bridge reads `L:FSDT_GSX_*_STATE` into the optional telemetry field `ground` (`SimVars.cs`, `Protocol.cs`), core — `packages/core/src/scenario/ground.ts` (`ground.*`, events `GSX_BOARDING_DONE`/`GSX_REFUEL_DONE`), scenarios — `final_loadsheet`, `fuel_slip`, `boarding_completed`.

Flight data monitoring (T94): detectors — `packages/core/src/fdm/monitor.ts` (core option `fdm`, field `fdm` in the recording header; without it — off), letter — `packages/scenarios/base/fdm_letter.yaml`, events — `FlightReport.fdm`.

Flight summary (T69): calculation — `packages/core/src/summary/report.ts` (`AcarsCore.report()`, only data figures, no ratings; landing airport — the nearest within 5 NM), taken when the flight is closed at the gate (`FlightSession.endFlight`), written as a `summary` line after `end` into the recording and into the flight logbook `<userData>/logbook.json` (`main/logbook.ts`, no limit); in the UI — `ReportPanel.tsx` until the next OFP is loaded, "Save as JSON" — `AppController.exportReport`.

Flight kind (T89): `classifyFlight` — `packages/core/src/scenario/flight-kind.ts` (FPL fields 8b and 18, `freight_added` — `ofp/parse.ts`), scenario field `operations`, variable `flight.kind`, core option and input `flightKind` (before OUT; in the recording header and the `tick` line), the question after OFP load and the choice — `controller.ts` (`setFlightKind`, `AppState.flightKind`, setting `askFlightKind`), in the UI — `KindBlock` in `FlightView.tsx`. Packs by kind (T90–T92): `packages/scenarios/cargo/` (cargo), `charter/`, `ferry/`, `bizav/` (business aviation; type table — `BIZAV_FAMILIES` in `scenario/aircraft.ts`; wired in `scenario-sources.ts`, `tools/replay/src/cli.ts`, `tools/i18n/translate.mjs`), LMC by kind — `buildFlightData(…, kind)`, passenger lines — `~…{flight.if_pax}`. Charter type (T107): `tour | sports | vip` (default `tour`) — `CHARTER_TYPES` in `flight-kind.ts`, scenario fields `charter` and `charter_probability`, `flightKind.charter` in the core option/input and the recording (no field — a pre-T107 recording, no filter), a second list in `KindBlock`, `setFlightKind(kind, charter)`.

Workspace packages import each other from sources: export condition `source` (`customConditions` in `tsconfig.base.json`, `resolve.conditions` in `vitest.config.ts`), no build needed for tests. `pnpm -F <pkg> test` runs the root Vitest config with `--project`.

Purity of `packages/core` (invariants 3–4) is checked three times: tsconfig without Node/DOM types, Biome rules in `biome.json` (overrides), the test `packages/core/test/purity.test.ts`.
(Update this section if you change scripts.)
- SimConnect, Hoppie, SimBrief, MSFS SDK change. If unsure about a SimVar name, units, an API parameter — open the official documentation. Do not guess. Places marked `[VERIFY]` in the documents — check them before use.
- You cannot see the simulator and aircraft. Everything that needs MSFS/a specific add-on — write it up as a "Human check" step with an exact instruction (aircraft, phase, what must appear on screen).

## Report template

```
## Txx — <title>
Done: …
Files: …
Checks: typecheck ✓/✗, lint ✓/✗, test ✓/✗ (N tests)
Human check: 1) … 2) …
Notes (out of scope): …
Open questions: …
```
