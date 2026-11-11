# design/ — mockup package for restyling `apps/desktop`

Date: 2026-10-15. Source: the Claude Design canvas "ACARS for MSFS 2024" (the "Design system" page).

## What is here

| File | Purpose |
|---|---|
| `spec.md` | Visual specification: concept, typography, sizes, components and states, behaviour |
| `tokens.css` | UI tokens (dark shell + light sheets) |
| `fms.css` | Isolated tokens of the FMS screen + `@font-face` |
| `fonts/` | B612 Mono (Regular/Bold, woff2, latin) and `OFL.txt` — SIL OFL 1.1 licence, source: npm `@fontsource/b612-mono` |
| `artboards/*.dc.html` | Canvas artboard sources — the reference for markup and values. These are canvas templates (`<x-dc>`, `{{…}}`), they do not open in a browser by themselves; read them as text |
| `screens/` | (empty) — put the artboard PNGs exported from the canvas here |
| `T-UI-card.md` | Draft of a task card for `docs/07-roadmap-tasks.md` |

## Important: mockup ≠ app model

The mockup was drawn before the code was analysed and assumed the app is a pilot terminal. In fact it is an "airline/ATC" console: messages go to the aircraft's MCDU through Hoppie, the pilot answers from the cockpit. So **only the visual style is taken from the mockup**, and the set of screens comes from the existing code.

### Do not implement (no data in `AppState` / no API)

- WILCO / UNABLE / STANDBY buttons and LSK side keys — the pilot answers in the aircraft.
- The "METAR / TAF / ATIS / PDC request" window — there is no such API. An acceptable replacement: command hints for `sendPilotMessage` (`REQ WX`, `REQ ATIS`, `REQ GATE`, `REQ LOADSHEET`, `ETA`, `DELAY`, `DIVERT`, `RDY`, `HELP` — see `packages/scenarios/commands/`), only as text inserted into the field.
- CLR ALT, ETA (live), next waypoint, route progress bar — not in `TelemetryView`/`FlightSummary`.
- The CPDLC / Weather / NOTAM / Log sections of the mockup — the app has three tabs: `flight`, `scenarios`, `settings`.
- A separate FMS window (a second `BrowserWindow`) — that is a main-process change, outside the scope of the restyle.

If the data for a mockup element is missing — do not invent it, leave a note in the report and ask (CLAUDE.md).

## Mapping: mockup → code

| Mockup | Code | What to do |
|---|---|---|
| Top bar 52 (`ScreenMain`) | `App.tsx` `.topbar` | Brand + section title; the `flight/scenarios/settings` tabs are `--btn` plates, the active one `--active` (the tab style of `DsComponents`) |
| NOTAM banner | `ErrorBanner` | The "Error" variant of the banner (`--shell-2`, red word + a "Hide" button) |
| "Flight" block (`--shell-2` panel) | `FlightCard` + `Summary` | Header: callsign + type; an "ORIG — DEST" row (no position marker); a facts row (sched, station, profile); Load/Start/Stop/Turnaround/Done buttons in the shell button style |
| SIM/NET/CPDLC status row (no circles) | `StatusCard` → `StatusRow`, `PhaseStrip` | `--on-shell-2` label + value; the tone through the text colour (`--ok`/`--caution`/`--warning-dot`). Phases are a segmented strip, the current one `--active` |
| Message table on a light sheet | `FeedList` | `--sheet-*` sheet, row: time, `from → to` chip, scenario tag, delivery status as a pill (`sent` → ok, `queued/retry` → caution, `failed/dropped` → warning) |
| FMS block | `.telex` in `FeedList` | `fms.css` screen, `--fms-cols` = `lineWidth`. Incoming from the pilot are green too (the "PILOT" label outside the screen) |
| Scratchpad `[ … ]` | `PilotForm` | A field in the `.fms__scratch` style or a shell field + a button |
| — | `ForceForm` | Select (menu sheet) + a shell button |
| Scenarios (no artboard) | `ScenariosView` | Groups are light sheets; row 64: title 17/600 + description 15 `--on-sheet-2`; checkbox → switch; chance — a field on the right |
| Settings (no artboard) | `SettingsView` | Grouped sheets as in iOS settings; checkboxes → switches; hints 13 `--on-sheet-2` |
| Modal sheet | `window.confirm` (Stop) | Optionally a modal sheet; confirm may stay |

## Tokens: old → new (`styles.css`)

| Was | Becomes |
|---|---|
| `--bg` | `--shell-0` |
| `--panel` | `--shell-1` (bars) / `--shell-2` (panels) |
| `--panel-2` | `--btn` |
| `--line` | `--shell-line` (on the shell) / `--sheet-line` (on a sheet) |
| `--text` / `--muted` | `--on-shell-1` / `--on-shell-2` (on a sheet — `--on-sheet-1/2`) |
| `--accent` / `--accent-ink` | `--active` / `#fff` |
| `--ok` `--warn` `--bad` | `--ok` `--caution` `--warning-dot` (on a sheet — `*-text`) |
| `--telex` | `--fms-text` (`fms.css`) |
| `--radius` 8 | `--r-sheet` 10 / `--r-ctl` 6 |
| `--mono`, `--sans` | `--fms-font` (screen only), `--font-ui` |

## Project constraints

- The CSP in `renderer/index.html` does not allow external fonts — B612 Mono only from `fonts/` (copy to `renderer/src/assets/fonts/`).
- The renderer does not import Node/Electron; no business logic on timers (CLAUDE.md, invariant 5).
- All texts go through `i18n.ts`, EN and RU; Russian strings are longer — do not fix the width of plates and buttons.
- Do not change: `store.ts`, `shared/api.ts`, `preload`, `main`, `packages/*`.
