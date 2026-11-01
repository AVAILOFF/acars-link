// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { HelpSection } from './help.js';
import { HOPPIE, SIMBRIEF } from './help-links.js';

/** The "Help" tab in English (T85: one file per language, the same sections and items as English). */

const COMMANDS_EN = [
  'HELP: the list of commands OPS understands.',
  'REQ WX [ICAO]: METAR (and TAF with live data) of an airport; empty means the destination.',
  'REQ ATIS [ICAO]: the ATIS on air on VATSIM; without one, the latest METAR.',
  'REQ GATE: the expected arrival gate or stand, baggage belt and STA.',
  'REQ GATE CHANGE [gate] [reason]: ask for another arrival gate.',
  'REQ LOADSHEET: the latest loadsheet of the flight once more.',
  'DELAY <min> <reason>: report a departure delay; OPS replies with the new EOBT.',
  'ETA: estimated arrival against the schedule, gate and transfer passengers.',
  'RDY: ready to depart before the slot (CTOT), passed on to flow control.',
  'DIVERT <ICAO>: diversion; OPS warns handling there and asks for the reason.',
  'MEDICAL <text>: a medical case on board; OPS connects MedLink.',
];

export const en: readonly HelpSection[] = [
  {
    id: 'start',
    title: 'Getting started',
    items: [
      {
        id: 'what',
        q: 'What does ACARS Link do?',
        a: [
          'It plays your airline’s operations centre. While you fly, it reads the simulator and your SimBrief flight plan, follows the phase of flight and sends ACARS messages to the cockpit over Hoppie ACARS: loadsheets, slot and gate information, delays, irregular situations, the next leg. You can reply and send requests from the aircraft FMS.',
          'ACARS messages are always in English, as in real operations. The app interface is available in several languages (Settings → Language).',
        ],
      },
      {
        id: 'ui',
        q: 'What is where in the app',
        a: [
          {
            list: [
              'Messages: the airline messages and your replies, the flight card (load the OFP, start and end the flight) and the FMS screen with the selected message as the cockpit shows it. Before the first flight the flight card lists what is still missing, with “Set up” next to each item.',
              'Scenarios: which messages and situations may happen on a flight, and their chances.',
              'Settings: accounts (SimBrief, Hoppie), language, how messages are sent; the rest is under “Advanced settings”.',
              'Help: this manual.',
            ],
          },
          'The top bar shows UTC, the flight and the state of the simulator (SIM), the network (NET) and the XATC station (CPDLC). The status bar at the bottom shows the bridge, the simulator and the network, and what needs your action.',
          '“Show the welcome again” and “Take the interface tour” at the top of this page repeat the introduction.',
        ],
      },
      {
        id: 'install',
        q: 'Windows warns about the installer',
        a: [
          'The installer is not code-signed, so SmartScreen shows “Windows protected your PC”. Click “More info”, then “Run anyway”.',
        ],
      },
      {
        id: 'first',
        q: 'First flight, step by step',
        a: [
          {
            ordered: true,
            list: [
              'Settings → Accounts: enter your SimBrief username and press “Check”.',
              'Enter your Hoppie logon code and press “Save”. No code yet? Register at Hoppie (link below); the code comes by email. Without a code, set “Send messages via” to “Offline (app only)”: messages then appear only in this window.',
              'Create a flight plan in SimBrief, then on the Messages tab press “Load OFP from SimBrief”.',
              'Start MSFS or X-Plane 12 and load the aircraft at the gate. The installed app starts the simulator bridge itself, and the bridge finds the running simulator (Settings → Connection → “Simulator”: “Automatic”); the status bar shows “Sim bridge” and “Simulator” as “connected” and which simulator it is.',
              'In the aircraft FMS/MCDU (INIT or ATC COMM page) enter the flight number shown on the flight card, and connect ACARS / Hoppie in the aircraft.',
              'Press “Start flight”. Messages come from the airline station, OPS + flight number by default.',
            ],
          },
          { link: 'SimBrief Dispatch', href: SIMBRIEF },
          { link: 'Hoppie ACARS registration', href: HOPPIE },
        ],
      },
      {
        id: 'inibuilds',
        q: 'iniBuilds A350 / A380 do not receive messages',
        a: [
          'These aircraft only start picking up telex after an F-PLN REQUEST (INIT REQUEST) in the FMS. Do it after loading the flight.',
        ],
      },
    ],
  },
  {
    id: 'flight',
    title: 'During the flight',
    items: [
      {
        id: 'reply',
        q: 'How do I answer a message?',
        a: [
          'Some messages ask for a decision and list the options. Send a free-text telex to the airline station with the option as the first word, from the aircraft FMS. With “Message hints” on (Settings), the Messages tab shows under the FMS screen what the message means, which answers are expected and which one is taken if you do not reply.',
          'Messages waiting for a reply are marked “Awaiting reply”; what needs your action stays in the status bar until it is settled.',
        ],
      },
      {
        id: 'commands',
        q: 'Which commands can I send to the airline?',
        a: [
          'Send them as a free-text telex to the airline station:',
          { list: COMMANDS_EN },
          'Without the aircraft FMS, use “Airline request…” on the Messages tab: the request goes to the simulated airline as if your aircraft had sent it, and the reply arrives as usual.',
        ],
      },
      {
        id: 'xatc',
        q: 'What is XATC?',
        a: [
          'A simulated CPDLC station for your own aircraft, one per FIR (Settings → XATC station (CPDLC)). Log on to X + the FIR code (EDGG → XDGG); at the FIR boundary it hands you over to the next station. On the ground, request the departure clearance (DCL / PDC) by telex to X + the departure airport (EDDF → XDDF). It needs live data. With “Yield to live VATSIM ATC” on, XATC gives way when a real controller is online in the FIR.',
        ],
      },
      {
        id: 'sim-time',
        q: 'Time acceleration, pause and starting late',
        a: [
          'Messages follow the phase of flight, not fixed timers, so pause and simulation rate do not break the order. If you start the flight later than the scheduled departure, the flight counts as delayed and the documents use the new departure time.',
          '“Sim time” (advanced settings) runs the flight by the simulator UTC clock instead of the PC clock. It is synchronised once at the start of the flight.',
        ],
      },
      {
        id: 'end',
        q: 'What happens after landing?',
        a: [
          'At the stand the Messages tab asks what next. “Fly next leg” waits for the remaining messages, then loads the next OFP (create it in SimBrief first). “No more flights” closes the flight once the remaining messages are sent; “Close now” closes it at once.',
          '“Stop flight” ends it at any moment; messages not yet sent are dropped.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Scenarios and settings',
    items: [
      {
        id: 'scenarios',
        q: 'Can I choose which messages arrive?',
        a: [
          'Yes, on the Scenarios tab: turn single scenarios or whole categories on and off and change the chance of random events. Changes apply from the next flight. Pilot commands have no switches: requests need them.',
        ],
      },
      {
        id: 'gap',
        q: 'Messages arrive in a batch',
        a: [
          'The aircraft fetches telex about once a minute, so messages sent more often arrive together. “Gap between messages” (Settings) spaces them out; answers to your requests always go first.',
        ],
      },
      {
        id: 'live',
        q: 'What are live data?',
        a: [
          'Real weather (METAR/TAF), VATSIM controllers, natural events, rocket launches and other events used in messages. Turn them off (“Live data”) if the date in the simulator is far from today. When a source fails, messages fall back to the flight plan.',
        ],
      },
      {
        id: 'secrets',
        q: 'Where are my logon code and keys stored?',
        a: [
          'Encrypted by the operating system (Windows DPAPI). They are never shown again after saving and are not written to recordings or logs. “Remove” next to a field removes them.',
        ],
      },
      {
        id: 'memory',
        q: 'What is “airline memory”?',
        a: [
          'What irregular events leave to the next flights: open MEL items, blacklisted passengers, crew rest after an extension. Clear it in the advanced settings.',
        ],
      },
      {
        id: 'records',
        q: 'Flight recordings',
        a: [
          'With “Record flights” on, the telemetry and messages of each flight are saved to a file; the last 20 flights are kept. “Open recordings folder” shows them, which helps when reporting a problem.',
        ],
      },
      {
        id: 'logs',
        q: 'Logs and diagnostics',
        a: [
          'The app keeps logs of its own work and of the simulator bridge in the “logs” folder next to the settings (%APPDATA%\\ACARS Link\\logs): starts, connections, Hoppie status and errors, five files of 5 MB each. Your logon code, keys and SimBrief name are replaced with ***.',
          'Advanced settings → Diagnostics → “Export…” saves the logs, versions and settings as one .zip to attach to a problem report. The latest flight recording is added only when you switch it on.',
        ],
      },
    ],
  },
  {
    id: 'trouble',
    title: 'Troubleshooting',
    items: [
      {
        id: 'no-msg',
        q: 'Messages do not reach the aircraft',
        a: [
          {
            list: [
              'The flight number in the FMS must match the flight card exactly.',
              'NET in the top bar should read “Hoppie: OK”, not “offline”.',
              'ACARS / Hoppie must be enabled in the aircraft (in some aircraft it is an EFB or MCDU option, with its own logon code field).',
              'iniBuilds A350 / A380: F-PLN REQUEST first.',
              'Wait a minute: the aircraft fetches telex on its own schedule.',
            ],
          },
        ],
      },
      {
        id: 'halted',
        q: '“Hoppie stopped sending”',
        a: [
          'Hoppie refused the logon code. Check it in Settings (it is the code from the Hoppie email, not your password), then stop and start the flight again: the running flight keeps the old code.',
        ],
      },
      {
        id: 'no-sim',
        q: 'The simulator shows “no bridge” or “disconnected”',
        a: [
          {
            list: [
              'Start MSFS and wait for the main menu; the bridge connects on its own.',
              'X-Plane 12: “Simulator” in Settings must be “Automatic” or “X-Plane 12”, X-Plane must be 12.1.1 or later, and Settings > Network in X-Plane must allow incoming traffic. The simulator shows “connected” once a flight is loaded.',
              'Make sure nothing else uses the port from “Sim bridge port” (advanced settings). The installed app restarts the bridge when it changes. “Port busy” in the top bar means another program (another bridge, started by hand) holds the port: close it or change the port.',
              'If the bridge stops by itself, the installed app starts it again after a few seconds (a line in the feed says so, the flight goes on). “Does not start” means it stopped 6 times in 5 minutes: restart the app or change the bridge port, and send the diagnostics (Settings → Diagnostics) with the problem.',
              'The bridge only listens on 127.0.0.1: the app and the simulator must run on the same PC.',
            ],
          },
        ],
      },
      {
        id: 'lost',
        q: '“Telemetry lost” or “Position jump” in the feed',
        a: [
          'While telemetry is lost (simulator closed, loading screen) scenarios pause and resume when it is back. A position jump means slew or teleport; it is reported but does not stop the flight.',
        ],
      },
      {
        id: 'close',
        q: 'Can I close the window during a flight?',
        a: [
          'Yes. The flight is recorded as it goes: after closing the app, or if the app or the PC crashed, the next start (within 24 hours) offers to continue it — the phase, the feed and the replies waited for come back, and messages that did not reach the network are sent again. While the app is closed no messages arrive in the aircraft; those due meanwhile come one after another after the restart. The app still asks before closing.',
        ],
      },
    ],
  },
];
