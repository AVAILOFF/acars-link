# Changelog

ACARS Link releases: SemVer, an annotated tag `vX.Y.Z` on `master` for each (0.x until the
public release, 1.0.0 — the first public one). `pnpm release <X.Y.Z>` adds a section from the `Merge task/…` commits since the
previous tag; how to release — README.md, "Выпуски".

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
