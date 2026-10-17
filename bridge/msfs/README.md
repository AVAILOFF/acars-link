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

## Protocol v1 and v2

One JSON object per text frame. The client picks the version in the URL: `ws://127.0.0.1:47830/?protocol=2`.
Without the query (or with `protocol=1`) the bridge speaks v1, exactly as before, so v1 clients keep working.
A higher number than the bridge knows gets the highest version it supports. The app (T21) asks for v2 and also
accepts a v1 bridge: telemetry then works and commands end with `unavailable`.

### Bridge → app (v1 and v2)

| `type` | When | Fields |
|---|---|---|
| `hello` | first frame | `protocol: 1 \| 2`, `telemetryVersion: 1`, `bridge`, `version`, `source: "simconnect" \| "fake"`; v2 adds `commands: string[]` |
| `status` | right after `hello`, then on every change | `sim: "disconnected" \| "connecting" \| "connected"`, `running`, `paused`, `simRate`, `detail?`, `retryInMs?` |
| `telemetry` | ~1 Hz while `connected` and `running` | `data: TelemetrySnapshot` |

- `running` is the SimConnect `Sim` event. It is false in menus and while a flight loads, and no telemetry is sent then.
- `paused` is the `Pause_EX1` event. Any non-zero flag counts: full pause, active pause or sim pause.
  While paused the bridge keeps sending the last snapshot with `paused: true` every ~1.5 s, even if the sim stops sending data.
- `simRate` is `SIMULATION RATE`. Snapshots are capped at ~1 per second of wall time at any sim rate.
- `t` is the bridge wall clock, in epoch ms UTC.
- Messages from the client are ignored in v1. An incompatible change bumps `protocol`.

### Commands (v2): app → bridge → sim

```
→ {"type":"command","id":"c1","command":"ping","args":{}}
← {"type":"ack","id":"c1","ok":true}
← {"type":"ack","id":"c1","ok":false,"error":"unavailable","detail":"sim not connected"}
```

- `id`: 1–64 of `A–Z a–z 0–9 . _ -`, chosen by the client. The `ack` goes only to the client that sent the command.
  If the frame has no readable `id`, the `ack` has `"id": null`.
- `command`: must be in the whitelist (`CommandCatalog` in `src/AcarsBridge/Commands.cs`) and supported by
  the source. `hello` lists the commands this bridge offers. `args` is optional. It is a flat object of
  up to 16 entries. Each value is a string (up to 512 characters), a number or a boolean. Each command
  also checks its own arguments.
- Commands run one at a time per client, in order. Each command has a 10 s timeout and is never retried.
  The app's own timeout is 15 s.
- Rate limit per client: a burst of 10, then 2 per second. Commands over the limit get `rate_limited`.
- A text frame may be up to 4096 bytes. Longer frames and binary frames get `bad_frame` and are not parsed.
- `error` codes: `bad_frame` (not JSON, wrong shape, bad `id`/`args`), `unknown_command` (not whitelisted or
  not supported by this source), `bad_args`, `unavailable` (cannot run now), `rate_limited`, `failed`
  (the source failed, or `detail: "timeout"`).
- An `ack` uses the same per-client queue as telemetry, so a client that stalls long enough can lose it.
  The app treats a missing `ack` as `timeout`.

| Command | Args | `simconnect` | `fake` |
|---|---|---|---|
| `ping` | none | ok while a SimConnect session is open, else `unavailable` | ok |
| `smoke_start` | `lat` (-90..90), `lon` (-180..180) | T34: remembers the point (`unavailable` without a session); the smoke object is created when the aircraft is within 40 NM (the first object of a sim session or flight is created once more after 15 s: in MSFS 2024 its effect never starts), removed beyond 60 NM, after 90 min or on `smoke_stop` (`SmokeController`); a new point moves the object | ok |
| `smoke_stop` | none | removes the object and forgets the point | ok |
| `rescue_start` | `level` (`full` \| `standby` \| `medical`), `thrLat`, `thrLon` (landing threshold), `hdg` (runway true course, 0..360), `lengthM`, `side` (`left` \| `right` of the landing direction: the upwind side, picked by the app), `fire`, `medic` (SimObject titles joined by `\|`, at most 8 each, `fire` empty with `medical`) | T54: replaces the request (`unavailable` without a session). Fire trucks are created within 15 NM of the threshold, 150 m off the axis on the `side`, facing the runway, from 400 m past the threshold to 200 m before the far end, evenly (one truck: at 400 m). Every vehicle stands with `SIM DISABLED` = 1; the bridge moves the fire trucks itself about 10 times a second with `SIMCONNECT_DATA_INITPOSITION` (no AI waypoints): with `full` they follow the aircraft after touchdown (1 s on the ground; trucks ahead wait until it has passed them), then go to a 50 m circle round it at 40 kt (round the aircraft on an 80 m arc when the straight line would pass closer than 40 m) and stay; removed 10 min after the stop, beyond 30 NM (created again when near), back to waiting after 5 s in the air; `standby` trucks wait and go 10 min after the stop. Fire truck headings are sent turned by 180° (the models are drawn nose to tail with their sim heading). The ambulance appears 30 m left of the aircraft once it stands with the parking brake set within 15 NM, for 10 min; parked again with the brake more than 100 m from it, the aircraft gets it created anew beside it. Same runway, side and titles again keep the vehicles that stand (PAN → MAYDAY). Logic: `RescueController`; diagnostics in the console | ok |
| `rescue_stop` | none | removes all rescue vehicles and forgets the request | ok |

The fake source accepts every whitelisted command, confirms it, and logs it to the console.
The smoke object comes from the package in `package/` (draft, unverified, see its README). VDGS text (T22) does not use the bridge: GSX reads it from a file that the app writes (docs/06, "GSX VDGS").

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
`engRunning`/`engN2`, `fuelKg`, `parkingBrake`, pause and active pause, `flapsIdx`, `gearDown`,
`onGround` on takeoff, reconnect after MSFS quits (2024 breaks the pipe, `0xC000014B`, instead of
sending Quit; the backoff loop handles both). Not yet checked: `simRate`, MSFS 2020.

Seen while a flight loads in MSFS 2024: pause flips many times per second (the pump keeps the stream
≤ 1 Hz), and aircraft state jumps (engines, transponder, flaps) before the flight settles.
During engine start `GENERAL ENG COMBUSTION` flickers for ~30 s (N2 ≈ 25 %); the bridge passes it
through raw, and the FSM's `holdSec` absorbs it.
