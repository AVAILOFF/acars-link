# acars-msfs-bridge

MSFS 2020/2024 → SimConnect → WebSocket `ws://127.0.0.1:47830/`. C# / .NET 8 (docs/08, decision 2).
Streams `TelemetrySnapshot` v1 (docs/03, `packages/core/src/telemetry/types.ts`) at ~1 Hz.

## Build

```
dotnet build bridge/msfs                                   # without SimConnect (fake source only)
dotnet build bridge/msfs -p:MsfsSdk="C:\MSFS 2024 SDK"     # with SimConnect
dotnet test bridge/msfs                                    # or: pnpm bridge:test
```

The MSFS SDK is not in the repo. The project looks for
`<SDK>\SimConnect SDK\lib\managed\Microsoft.FlightSimulator.SimConnect.dll` in `-p:MsfsSdk=…`, then in
`bridge/msfs/Local.props` (gitignored, copy from `Local.props.example`), then in the `MSFS2024_SDK` and
`MSFS_SDK` environment variables. Native `SimConnect.dll` is copied next to the exe. x64 only.
The build prints which folder it used (`SimConnect support ON (…)`).

## Run

```
acars-msfs-bridge                          # SimConnect, port 47830
acars-msfs-bridge --source fake            # no sim: parked A320 at EDDF, 1 Hz
acars-msfs-bridge --source fake --replay flight.jsonl   # loop a JSONL of TelemetrySnapshot v1
acars-msfs-bridge --port 47831 --verbose
```

Start order does not matter. Until MSFS is up, the bridge retries with backoff
1, 2, 4, 8, 16, 30, 30 … s. The same happens after MSFS quits.

## Protocol v1 (bridge → app only)

One JSON object per text frame:

| `type` | When | Fields |
|---|---|---|
| `hello` | first frame | `protocol: 1`, `telemetryVersion: 1`, `bridge`, `version`, `source: "simconnect" \| "fake"` |
| `status` | right after `hello`, then on every change | `sim: "disconnected" \| "connecting" \| "connected"`, `running`, `paused`, `simRate`, `detail?`, `retryInMs?` |
| `telemetry` | ~1 Hz while `connected` and `running` | `data: TelemetrySnapshot` |

- `running` is the SimConnect `Sim` event. It is false in menus and while a flight loads, and no telemetry is sent then.
- `paused` is the `Pause_EX1` event. Any non-zero flag counts: full pause, active pause or sim pause.
  While paused the bridge keeps sending the last snapshot with `paused: true` every ~1.5 s, even if the sim stops sending data.
- `simRate` is `SIMULATION RATE`. Snapshots are capped at ~1 per second of wall time at any sim rate.
- `t` is the bridge wall clock, in epoch ms UTC.
- Messages from the client are ignored in v1. An incompatible change bumps `protocol`.

Access rules (CLAUDE.md, invariant 10): the bridge listens on `127.0.0.1` only. The `Host` header must be `127.0.0.1` or `localhost`.
`Origin` must be absent, `file://`, `null`, or an http(s) loopback origin. Anything else gets 403, so web pages
open in a browser cannot read the telemetry.

## SimVars

See `src/AcarsBridge/SimVars.cs`. The names and units were checked against docs.flightsimulator.com. Differences from docs/03:
- N2 comes from `TURB ENG N2:n` (percent), because `ENG N2 RPM` uses a 0–16384 scale.
- `GEAR HANDLE POSITION` and `EXIT OPEN` are "Percent Over 100". Gear down means ≥ 0.5; exits are requested in `percent`.
- `AircraftLoaded` is not subscribed. `TITLE` is read with every snapshot.

Checked by a human in MSFS 2024 (A350-1000, 2026-10-08): connect, `running`, `doorsOpen`
(0-based, order L1, R1, L2, R2), `xpdrState` (AUTO on the ground → 5 Ground), `beacon`,
`engRunning`/`engN2`, `fuelKg`, `parkingBrake`, pause and active pause.
Not yet checked: `simRate`, reconnect after MSFS quits, flaps/gear in flight, MSFS 2020.
