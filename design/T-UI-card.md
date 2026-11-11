# Card draft — move to docs/07-roadmap-tasks.md

## T-UI — New visual style of the app

**Goal:** restyle `apps/desktop` (renderer) according to the mockup in `design/` without changing the logic or the main ↔ renderer contract.

**In scope:**
- The `design/tokens.css` tokens in `styles.css` (replace the variables per the table in `design/README.md`).
- The FMS screen for telex: `design/fms.css`, B612 Mono font locally, width = `FlightSummary.lineWidth`.
- `App.tsx` (top bar, tabs, error banner), `FlightView.tsx`, `FeedList.tsx`, `ScenariosView.tsx`, `SettingsView.tsx` — markup and classes per the `design/spec.md` specification.
- Switches instead of checkboxes (with `role="switch"` / a native checkbox with styling).
- New labels — `i18n.ts` keys (EN + RU).

**Out of scope:** `store.ts`, `shared/api.ts`, `preload`, `main`, `packages/*`; a second FMS window; CPDLC reply buttons; METAR/PDC requests from the app; data that is not in `AppState`.

**Done when:** `pnpm check` is green; all states of buttons/fields/rows from `spec.md` §4 are visible; a 1180×820 window has no horizontal scroll; focus is visible on all interactive elements.

**Human check:**
1. `pnpm desktop:dev`, the "Flight" tab without an OFP → empty state, the "Load" button is blue.
2. Load an OFP → flight header: callsign, ORIG — DEST, type, schedule, profile.
3. Start a flight with MSFS → bridge/simulator/network statuses are coloured by tone, the phase is highlighted in blue.
4. An incoming telex → a feed row with the delivery status; text is green on black, width per profile (A320: 24, B777: 27).
5. Switch the language EN/RU → nothing is cut off.
6. Tab through all screens → a visible focus ring.
