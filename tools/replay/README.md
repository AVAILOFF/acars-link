# @acars/replay

Flight recordings and their replay through the core (T11, docs/04 «Тестирование»).

## Recording format (JSONL, v1)

```
{"type":"header","format":"acars-sim-recording","v":1,"recordedAt":…,"source":"desktop","ofp":{…},
 "seed":null,"station":"OPS{flight}","profile":{…},"scenarios":[…],"sessionFired":[…]}
{"type":"start","now":…}
{"type":"tick","now":…,"telemetry":{TelemetrySnapshot v1}|null[,"inbound":[{from,type,text}]]}
{"type":"end","now":…,"to":"TURNAROUND"|"DONE"}
{"type":"out","t":…,"scenarioId":…,"from":…,"to":…,"text":…}
{"type":"stop","now":…}
{"type":"sent","t":…,"n":…,"result":"sent"|"failed"}
{"type":"resume","now":…}
```

The lines after the header are the calls the app made to `AcarsCore`, in order (`now` = app
clock, `telemetry.t` = bridge clock). `out` lines are what the core sent live; `sent` (T64) says the transport delivered the `n`-th `out`
line (from 0) or gave it up, `resume` marks where the app restored the flight after a restart (the
ticks go on after the gap; the replay runs the file as one flight), and the header field `simTime`
says the times are the sim's UTC. The OFP is the
normalized one (no pilot name or ids). A file of bare `TelemetrySnapshot` lines (the bridge
`--source fake --replay` format) is read as well, with `--ofp`.

The desktop app writes one file per flight to `<userData>/recordings/` (Windows:
`%APPDATA%\ACARS Link\recordings`, the button in Settings opens it) and keeps the last 20.

## CLI

```
pnpm replay run <file.jsonl>                       # timeline: phases, OOOI, telexes
pnpm replay run <file.jsonl> --check               # replay == live? exit 1 if not
pnpm replay run <file.jsonl> --scenarios my/crew_info.yaml   # debug an edited scenario
pnpm replay run <file.jsonl> --only crew_info,slot_ctot --brief
pnpm replay run <file.jsonl> --pilot "40=REQ GATE" --pilot "95=DIVERT RJOO"   # pilot telexes (T12)
pnpm replay synth --ofp <simbrief.json> --out syn.jsonl [--go-around 300] [--boarding 5]
pnpm replay snapshots <file.jsonl> --out snaps.jsonl   # for acars-msfs-bridge --replay
pnpm replay --help
```

`inbound` (T12) are the pilot telexes passed with that tick (from the network or typed in the
app). Base scenarios are `packages/scenarios/base` plus the pilot command handlers in
`packages/scenarios/commands`.

Scenario files passed with `--scenarios` replace base scenarios with the same id and are always
enabled. Without `--only`/`--all` the replay runs the scenarios that were enabled in the flight.
