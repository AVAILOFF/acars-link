# @acars/replay

Flight recordings and their replay through the core (T11, docs/04 «Тестирование»).

## Recording format (JSONL, v1)

```
{"type":"header","format":"acars-sim-recording","v":1,"recordedAt":…,"source":"desktop","ofp":{…},
 "seed":null,"station":"OPS{flight}","profile":{…},"scenarios":[…],"sessionFired":[…]}
{"type":"start","now":…}
{"type":"tick","now":…,"telemetry":{TelemetrySnapshot v1}|null}
{"type":"end","now":…,"to":"TURNAROUND"|"DONE"}
{"type":"out","t":…,"scenarioId":…,"from":…,"to":…,"text":…}
{"type":"stop","now":…}
```

The lines after the header are the calls the app made to `AcarsCore`, in order (`now` = app
clock, `telemetry.t` = bridge clock). `out` lines are what the core sent live. The OFP is the
normalized one (no pilot name or ids). A file of bare `TelemetrySnapshot` lines (the bridge
`--source fake --replay` format) is read as well, with `--ofp`.

The desktop app writes one file per flight to `<userData>/recordings/` (Windows:
`%APPDATA%\ACARS Sim\recordings`, the button in Settings opens it) and keeps the last 20.

## CLI

```
pnpm replay run <file.jsonl>                       # timeline: phases, OOOI, telexes
pnpm replay run <file.jsonl> --check               # replay == live? exit 1 if not
pnpm replay run <file.jsonl> --scenarios my/crew_info.yaml   # debug an edited scenario
pnpm replay run <file.jsonl> --only crew_info,slot_ctot --brief
pnpm replay synth --ofp <simbrief.json> --out syn.jsonl [--go-around 300] [--boarding 5]
pnpm replay snapshots <file.jsonl> --out snaps.jsonl   # for acars-msfs-bridge --replay
pnpm replay --help
```

Scenario files passed with `--scenarios` replace base scenarios with the same id and are always
enabled. Without `--only`/`--all` the replay runs the scenarios that were enabled in the flight.
