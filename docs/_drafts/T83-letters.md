# T83 — draft letters (2026-11-01)

Sent by the user, from their own address. Replies go into `THIRD-PARTY-NOTICES.md` and docs/08 with a date;
a "no" reply becomes a separate card (what to remove from the public build). User decision 2026-11-01:
the installer may be given to other people without waiting for replies (docs/08).

## 1. To the owner of Hoppie's ACARS — hoppie@hoppie.nl

**Subject:** ACARS Link — a free airline-ops client for Hoppie: callsign questions

Hello Jeroen,

I am writing a free, non-commercial desktop app, ACARS Link, for MSFS 2024 and X-Plane 12.
It reads the SimBrief plan and the sim's telemetry and sends the pilot realistic "airline" messages
(load sheet, gate, delays, irregular operations) and a few clearance messages over your network.
Every user enters their own Hoppie logon code; the app never ships or shares one. It follows
tech.html: POST to connect.html, one poll every 45–75 s at random (down to 20 s for a short time
after sending), 15 s timeout, backoff after errors, no polling loops.

Before I give it to other people I would like to make sure it does not disturb the network:

1. **Sender callsign.** The airline messages go out from a station named after the flight —
   `OPS<flight>`, e.g. `OPSDLH400` (configurable to `<airline>OPS` or any name). Does the
   100-second callsign lock apply to the `from` of a telex, i.e. could two users with different
   logon codes block each other this way? Is `OPS<flight>` acceptable, or would you prefer another
   scheme?
2. **Simulated ATC stations.** Optionally the app answers CPDLC as a simulated station `X<FIR>`
   (e.g. `XEDGG`) — the `X` keeps it apart from the live VATSIM stations (`EDGG`, `LONC`, …).
   Several users may use the same `X<FIR>` name at the same time, each with their own logon code.
   Is that acceptable, and does the lock matter here? Should these stations use a different prefix?
3. **Anything else** you would like a third-party client to do or not do (identification, User-Agent,
   message length, frequency).

If you would rather not have such a client on the network, please tell me and I will not release
it with Hoppie support.

Thank you for running the network all these years.

Best regards,
<name>
<link to the project page, if there is one>

## 2. Microsoft / Asobo — MSFS SDK, SimConnect

Where to: a reply in topics 18233 and 18295 on devsupport.flightsimulator.com (unanswered as of 2026-10-31) or
a new topic in the SDK / Legal section; if there is no reply on the forum — via support.microsoft.com
(Microsoft Flight Simulator → Developer).

**Subject:** Redistributing a program that links the SimConnect static library (SimConnect.lib)

Hello,

I develop ACARS Link, a free, non-commercial add-on application for Microsoft Flight Simulator
2024 (Windows, x64). It reads aircraft data through SimConnect.

To avoid redistributing `SimConnect.dll` or `Microsoft.FlightSimulator.SimConnect.dll`, the app
uses a small DLL of its own, `acars_simconnect.dll`, which links the static client library shipped
with the official SDK: `MSFS 2024 SDK\SimConnect SDK\lib\static\SimConnect.lib` (SDK 1.8.1), as the
SDK's property sheet for static linking provides. The installer contains only this DLL of ours;
neither Microsoft SimConnect DLL is included.

Questions:

1. May a program that statically links `SimConnect.lib` from the SDK be redistributed free of
   charge to other users of the simulator?
2. Are there conditions for that — a notice or credit in the app or the installer, a licence text
   to include, a version requirement?
3. If static linking is not the intended way: which form of the SimConnect client may a
   third-party application redistribute?

Earlier topics 18233 and 18295 asked about the same thing and are still without an answer.

Thank you,
<name>

## 3. Optional — for the public build (T72: tables and natTrak only with written permission)

- **EUROCONTROL** (SSR Code Allocation List v4.13): a request to allow including in a free
  non-commercial app the SSR code table per ICAO EUR Doc 023 / CAL, with the source credited.
- **ICAO** (APAC eANP Vol II Part IV, Table ATM II-APAC-2): a request for permission to reproduce
  (`icao.int/pages/copyright.aspx` — only with written permission).
- **VATSIM Tech Team** (natTrak, `nattrak.vatsim.net/api/tracks`): may a free app read the NAT tracks
  from the API once an hour, and are there conditions (User-Agent, frequency). VATSIM data in general
  was checked on 2026-11-01 (Commercial Use Policy v2.0, §3.5) — it needs no separate letter.
