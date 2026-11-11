# ACARS Link

An airline ACARS simulator for flight simulators (MSFS 2024, X-Plane 12; MSFS 2020 is not supported — decision of 2026-11-01, T84). It reads the simulator's telemetry and the SimBrief OFP, detects the flight phase and, following scenarios, sends "airline" messages to the cockpit over the Hoppie ACARS network: loadsheets, slots, gate, weather, irregular situations. The pilot replies and requests data with telex commands. It also simulates an XATC ATC station (CPDLC logon, DCL/PDC, level requests, oceanic clearance).

## Status

| Area | State |
|---|---|
| Core: phase FSM, scenario engine, formatter | done (T01–T07, T39–T40) |
| Scenarios | 91: base 17, pilot commands 21, external data 17, irregular 34, simulator effects 2 |
| Bridge | C# / .NET 10 LTS (T79): SimConnect (MSFS) and X-Plane 12 Web API, automatic simulator detection (T08, T18, T59) |
| Transport | Hoppie; SayIntentions — not done (T17) |
| App | Electron, UI in EN, RU, DE, FR, ES, JA (DE/FR/ES/JA — machine translation, T86, T87), unsigned Windows installer (T10, T19, T56, T57, T-UI) |
| Distribution | free, non-commercial use; the public installer may be shared with others (decision T83, `08`); proprietary licence |

Open task cards — `docs/07-roadmap-tasks.md` (T15, T16, T17, T20, T35–T37, T84).

## Layout

```
apps/desktop             Electron app (main / preload / renderer)
packages/core            core: pure TS, no Node/DOM/network; time and randomness are injected
packages/scenarios       YAML scenarios (base, commands, external, irregular, sim) and their schema
packages/data-sources    external data: METAR/TAF, VATSIM, EONET, OurAirports, AeroDataBox and more
packages/transport       Hoppie and mock transports behind the Transport interface
tools/replay             flight recording format (JSONL) and a CLI to replay it through the core
bridge/msfs              simulator bridge (C#), listens on 127.0.0.1 only
docs/                    documents — the source of truth
reference/               sample scenarios, telemetry, anonymized OFPs
```

## Get the code

Repository: <https://github.com/AVAILOFF/acars-link>

```
git clone https://github.com/AVAILOFF/acars-link.git
cd acars-link
```

On Windows, enable long paths once if the clone reports "Filename too long": `git config --global core.longpaths true`.

The source is published for reading and reference. It is proprietary — see [LICENSE](LICENSE): no licence to copy, modify or redistribute is granted. Third-party components keep their own licences ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

## Quick start

Requires Node ≥ 24 and pnpm 12; the bridge needs the .NET 10 SDK. SimConnect support in the bridge also needs the MSFS 2024 SDK (`MSFS2024_SDK` environment variable or `bridge/msfs/Local.props`, see [bridge/msfs/README.md](bridge/msfs/README.md)); without it the bridge builds without SimConnect. Nothing else is required for a fresh clone — `.env.local` is only used by the optional `pnpm i18n translate` tool (DeepL key).

```
pnpm install
pnpm check          # typecheck + lint + spdx + test
pnpm bridge:test    # bridge tests (.NET)
pnpm desktop:dev    # app with HMR; in dev the bridge is started manually — bridge/msfs/README.md
pnpm desktop:dist   # installer: apps/desktop/release/ACARS-Link-Setup-<version>.exe
```

Full command list and working rules — [CLAUDE.md](CLAUDE.md).

## Repository and CI

The remote is the GitHub repository [`AVAILOFF/acars-link`](https://github.com/AVAILOFF/acars-link) (T63).

CI is GitHub Actions, [.github/workflows/check.yml](.github/workflows/check.yml): on every push to any branch and on pull requests, `windows-latest`, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm bridge:test`. There is no MSFS SDK in CI, so the bridge is built without SimConnect. Results are in the repository's Actions tab or `gh run list`; to run manually — `gh workflow run check --ref <branch>`.

Dependency vulnerabilities (T81) — [.github/workflows/audit.yml](.github/workflows/audit.yml): on Mondays and manually (`gh workflow run audit`), not on push, so a new vulnerability database entry does not fail the code check. Runs `pnpm audit --prod --audit-level=moderate` (bundle tree) and `dotnet list bridge/msfs package --vulnerable --include-transitive`.

## Releases

Versions follow SemVer (T77). A release is an annotated tag `vX.Y.Z` on a `master` commit; the starting point is `v0.1.0`. The version is stored in two places — `apps/desktop/package.json` and `<Version>` in `bridge/msfs/src/AcarsBridge/AcarsBridge.csproj`; the `tools/release/test` test checks they match. In the app it is shown in "About" and written to the header of every flight recording (`appVersion`).

```
pnpm release 1.0.0   # on master, clean working tree
```

[tools/release/release.mjs](tools/release/release.mjs) checks the `master` branch, a clean working tree, that the tag does not exist yet and that the version is greater than the current one; writes the version to both files and a [CHANGELOG.md](CHANGELOG.md) section from the `Merge task/… into …: <title>` commits since the previous tag (a `## Unreleased` section written in advance becomes the version's section, task lines go under `### Tasks`); runs `pnpm check` and `pnpm bridge:test` — on failure the files are restored and nothing is committed; then commits "Release vX.Y.Z", tags it and runs `pnpm desktop:dist` (public installer `apps/desktop/release/ACARS-Link-Setup-<version>.exe`) with `ACARS-Link-Setup-<version>.exe.sha256` next to it — SHA-256 in `sha256sum` format (T84). `--no-dist` skips the installer, `--any-branch` lets you try it on another branch (a copy). It is built locally, not in CI: CI has no MSFS SDK, and without it the bridge is built without SimConnect. CI on a tag push only runs the checks (`check.yml` triggers on any push).

Nothing is pushed automatically: `git push origin master vX.Y.Z` is done manually, at the owner's decision. Installers for other people go to a separate public repository with installers and release notes only (for example `AVAILOFF/acars-link-releases`, decision of 2026-10-31; created and published only on a separate request). The app has no updates: no notifications, no auto-update (decision of 2026-10-31).

Release notes for users (what's new, requirements, SHA-256 check with `Get-FileHash`, SmartScreen for an unsigned installer — "More info → Run anyway") follow the template [tools/release/RELEASE-NOTES.template.md](tools/release/RELEASE-NOTES.template.md); they are filled in by hand and published next to the installer.

## Documents

1. [CLAUDE.md](CLAUDE.md) — invariants and workflow (required reading).
2. [docs/02-product-vision.md](docs/02-product-vision.md) — what we build and what we don't.
3. [docs/03-architecture.md](docs/03-architecture.md) — components, stack, telemetry schema.
4. [docs/04-flight-phase-fsm.md](docs/04-flight-phase-fsm.md) — flight phase state machine.
5. [docs/05-scenario-engine.md](docs/05-scenario-engine.md) — scenario format.
6. [docs/06-integrations.md](docs/06-integrations.md) — Hoppie, SimBrief, SimConnect, X-Plane, external APIs.
7. [docs/07-roadmap-tasks.md](docs/07-roadmap-tasks.md) — task cards.
8. [docs/08-risks-open-questions.md](docs/08-risks-open-questions.md) — decisions, risks, items deferred until release.
