# 02 — Product vision (draft)

> Status: the stage 0 decisions were made on 2026-10-07 (see `08`). Distribution: personal use first; a community release only after evaluation and agreement with Hoppie.

## What it is

A desktop app for sim pilots. During a flight it behaves like an airline's Operations Control: it sends documents and events to the cockpit via ACARS (Hoppie / SayIntentions), reacts to the pilot's replies, and creates chains of non-standard situations.

## What we do better

1. **A reliable flight phase FSM** instead of timers and thresholds. Messages arrive on time even with a delayed departure, time acceleration, an engine restart, or a go-around.
2. **A scenario engine described by data (YAML).** A new scenario is added without code. There are chains, branching on the pilot's reply, probabilities and cooldowns.
3. **Two-way communication.** The pilot sends a telex (`REQ GATE`, `REQ WX EDDF`, `DIVERT`, `DELAY 15`), the system replies.
4. **Reproducibility.** A seed per flight. The core is tested on recorded telemetry.
5. **Security.** No keys in the client. The bridge listens on localhost only. Everything over TLS.
6. **Variety.** The MVP goal is 15 messages. The v1 goal is 50+ types, including non-standard scenarios (see below).

## Users

- MSFS 2024 sim pilots on airliners (MSFS 2020 is not supported — decision 2026-11-01, T84) (Fenix A320, FBW A32NX, PMDG 737/777, iniBuilds A350/A300, Headwind, etc.) with Hoppie telex support.
- Priority for the human check: Fenix A320, PMDG 777, iniBuilds A350/A380/A340.
- X-Plane 12 — second priority (T18).
- UI in English and Russian.
- Streamers (streamer mode).

## Scenario bank (content goals)

**Base (MVP):** prelim/final loadsheet with LMC, fuel slip, TO data, slot/CTOT, OBT/OOOI log, gate assignment, ATIS/METAR of the destination before TOD, arrival info (gate, connections, stand), LA data, next leg / aircraft change, crew info, welcome/turnaround.

**Non-standard (v1):** a medical case with a decision request; an unruly passenger; a defect with a MEL entry and consequences for the next flight; de-icing and holdover; curfew at the destination; tankering because of fuel price; a short passenger connection (a request to speed up); VIP/NOTOC (dangerous goods); runway closure or a runway change at the destination; weather deterioration at the alternate; crew duty time at its limit; a drone in the airport area; a delay due to ATC flow control; lost baggage; a gate reassignment on arrival.

**External events:** natural events (EONET), rocket launches, online VATSIM controllers (IVAO — `[AT RELEASE]`, no adapter), sports and other events (T29). Connecting flights (CONNEX, T30) were cancelled on 2026-10-09 and reopened on 2026-10-15: AeroDataBox with the user's key (RapidAPI free tier); without a key, as before.

**XATC (decision 2026-10-09, `07` stage 5; called ROPS until T58):** an ATC station simulation for a solo pilot — CPDLC logon, FIR tracking, PDC with a squawk by regional rules, level, speed and Direct To requests, step climb, descent clearance, oceanic clearance. It does not conflict with live VATSIM/IVAO controllers.

**Advanced features:** VDGS via GSX, a simulated data link (VHF/SATCOM, AES/GES), effects in the simulator, an editor for custom messages — see `07` stage 5.

For the whole of stage 5 the realism rule from `07` applies: maximum data verification, assumptions only with the user's approval.

## Out of scope (for now)

- A real CPDLC server or ATC station for other users of the network. XATC is a simulation for its own pilot only.
- A mobile app.
- Accounts and cloud sync.
- Monetization.
