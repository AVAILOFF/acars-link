// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  checkExtDataUpdate,
  type DisplayProfile,
  ExtDataError,
  type ExtDataUpdate,
  FLIGHT_REPORT_VERSION,
  type FlightKind,
  type FlightReport,
  isFlightKind,
  isTelemetrySnapshot,
  type Ofp,
  type PilotMessage,
  type TelemetrySnapshot,
  type Value,
  type XatcOptions,
} from '@acars/core';

/**
 * Flight recording, JSONL (T11). One JSON object per line:
 *
 * ```
 * {"type":"header","format":"acars-sim-recording","v":1,…,"ofp":{…}}   first line
 * {"type":"start","now":…}                                             user started the flight
 * {"type":"tick","now":…,"telemetry":{…}|null[,"inbound":[…]][,"data":{…}]}
 *                                                                      one core tick (+ pilot telexes, T12;
 *                                                                      + external data fetched, T13;
 *                                                                      + "force": [id] started by hand;
 *                                                                      + "flightKind": {override} the user's
 *                                                                      choice of the kind of flight, T89)
 * {"type":"end","now":…,"to":"DONE"}                                   user closed the flight
 * {"type":"out","t":…,"scenarioId":…,"from":…,"to":…,"text":…[,"packet":…]}
 *                                                                      telex the core produced live
 *                                                                      (ATC CPDLC, T23: + the /data2/ packet)
 * {"type":"cmd","t":…,"scenarioId":…,"command":…,"data":{…}}         sim command produced live (T22:
 *                                                                      "vdgs" + VdgsMessage, T102:
 *                                                                      {"action":"stop"} = taken down;
 *                                                                      bridge commands + their args)
 * {"type":"stop","now":…}                                              flight stopped
 * {"type":"sent","t":…,"n":…,"result":"sent"|"failed"}                 the transport delivered (or gave
 *                                                                      up on) the n-th `out` line (T64)
 * {"type":"resume","now":…}                                            the app restored the flight after
 *                                                                      a restart (T64); the ticks go on
 * {"type":"summary","now":…,"report":{…}}                              the flight report the app showed
 *                                                                      when the flight was closed (T69,
 *                                                                      `FlightReport`), after its `end`
 * ```
 *
 * The lines are the inputs of the core (`AcarsCore`) in call order, so a replay with the same
 * scenarios and seed gives the same messages (CLAUDE.md, invariant 4). `out` lines are the live
 * output, kept for comparison; `sent` lines tell which of them left the app, so a restored flight
 * sends the rest again (T64); a `summary` line is output too (the replay computes the report anew). Telemetry is the bridge snapshot as received (`t` = bridge
 * clock), `now` is the app clock of the tick. The header carries the normalized OFP (no
 * personal data: no pilot name or ids) and the core options of the flight.
 *
 * A file of bare `TelemetrySnapshot` lines (the bridge `--source fake --replay` format) is
 * read too; it needs an OFP from elsewhere.
 */

export const RECORDING_FORMAT = 'acars-sim-recording';
export const RECORDING_VERSION = 1;

export interface RecordingHeader {
  readonly type: 'header';
  readonly format: typeof RECORDING_FORMAT;
  readonly v: typeof RECORDING_VERSION;
  /** Epoch ms UTC when the recording started. */
  readonly recordedAt: number;
  /** Who wrote it: `desktop`, `synthetic`, `snapshots`. */
  readonly source: string;
  /** Version of the app that wrote it (T77, `desktop`; `+dev` outside the installer); absent = older. */
  readonly appVersion?: string;
  readonly ofp: Ofp;
  /** Core seed; null = the default `${callsign}/${requestId}`. */
  readonly seed: string | number | null;
  /** Station callsign template (`OPS{flight}`). */
  readonly station: string;
  readonly profile: DisplayProfile;
  /** Ids of the scenarios enabled for the flight. */
  readonly scenarios: readonly string[];
  /** `per_session` scenario ids already run in the app session before this flight. */
  readonly sessionFired: readonly string[];
  /** Core `dataWaitMs` (T13): how long `REQ WX` waited for fetched weather; absent = 0. */
  readonly dataWaitMs?: number;
  /** Core `minGapMs`: minimum time between telexes; absent = 0. */
  readonly minGapMs?: number;
  /** Core `namesVersion` (T43); absent = 1, the names of recordings made before it. */
  readonly namesVersion?: 1 | 2;
  /** Core `nextLegVersion` (T53, T55); absent = 1, the next leg of recordings made before it. */
  readonly nextLegVersion?: 1 | 2 | 3;
  /** Core `lateStartVersion`; absent = 1, the late start of recordings made before it. */
  readonly lateStartVersion?: 1 | 2 | 3;
  /** Core `rescueVersion` (T88); absent = 1, the rescue airport of recordings made before it. */
  readonly rescueVersion?: 1 | 2;
  /** Core `massUnit` (T105); absent = `kg`, the messages of recordings made before it. */
  readonly massUnit?: 'ofp' | 'kg' | 'lb';
  /** Core `hub` (T53): the user's hub; absent = OpenFlights. */
  readonly hub?: string;
  /** Probabilities set by the user instead of the files' (scenario id → 0..1); absent = none. */
  readonly probabilities?: Readonly<Record<string, number>>;
  /** Airline memory the flight started with (T14 `flags.*`); absent = none. */
  readonly flags?: Readonly<Record<string, Value>>;
  /** XATC station (T23); absent = off. */
  readonly xatc?: XatcOptions;
  /** Data link simulation (T31); absent = off. */
  readonly datalink?: {
    readonly satcom: boolean;
    readonly icaoHex?: string;
    readonly headerInText?: boolean;
  };
  /** "Time from the sim" (U-16): the times are the sim's UTC (T64); absent = unknown (before T64). */
  readonly simTime?: boolean;
  /**
   * Core `flightKind` (T89): the kind filter is on; `override` = the user's choice at the start
   * (null = automatic), `kind` = the kind in force then (for reading; the core works it out
   * again). Absent = no filter, as in recordings made before T89.
   */
  readonly flightKind?: { readonly override: FlightKind | null; readonly kind?: FlightKind };
}

export type RecordingEvent =
  | { readonly type: 'start'; readonly now: number }
  | {
      readonly type: 'tick';
      readonly now: number;
      readonly telemetry: TelemetrySnapshot | null;
      /** Messages from the aircraft passed with this tick (T12); absent = none. */
      readonly inbound?: readonly PilotMessage[];
      /** External data passed with this tick (T13); absent = none. */
      readonly data?: ExtDataUpdate;
      /** Scenarios the user started by hand with this tick; absent = none. */
      readonly force?: readonly string[];
      /** The user's choice of the kind of flight with this tick (T89); absent = none. */
      readonly flightKind?: { readonly override: FlightKind | null };
    }
  | { readonly type: 'end'; readonly now: number; readonly to: 'TURNAROUND' | 'DONE' }
  | {
      readonly type: 'out';
      readonly t: number;
      readonly scenarioId: string;
      readonly from: string;
      readonly to: string;
      readonly text: string;
      /** The Hoppie `/data2/` packet of an ATC CPDLC uplink (T23). */
      readonly packet?: string;
    }
  | {
      readonly type: 'cmd';
      readonly t: number;
      readonly scenarioId: string;
      readonly command: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'stop'; readonly now: number }
  | {
      readonly type: 'sent';
      readonly t: number;
      /** Index of the `out` line among the `out` lines of the file, from 0. */
      readonly n: number;
      readonly result: 'sent' | 'failed';
    }
  | { readonly type: 'resume'; readonly now: number }
  | { readonly type: 'summary'; readonly now: number; readonly report: FlightReport };

export type RecordedOutbound = Extract<RecordingEvent, { type: 'out' }>;

export interface Recording {
  readonly header: RecordingHeader;
  readonly events: readonly RecordingEvent[];
}

export type ParsedJsonl =
  | { readonly kind: 'recording'; readonly recording: Recording; readonly warnings: string[] }
  | {
      readonly kind: 'snapshots';
      readonly snapshots: readonly TelemetrySnapshot[];
      readonly warnings: string[];
    };

export class RecordingError extends Error {
  override readonly name = 'RecordingError';
}

/** One line of the file, with the trailing newline. */
export function encodeLine(line: RecordingHeader | RecordingEvent): string {
  return `${JSON.stringify(line)}\n`;
}

export function recordingHeader(
  fields: Omit<RecordingHeader, 'type' | 'format' | 'v'>,
): RecordingHeader {
  return { type: 'header', format: RECORDING_FORMAT, v: RECORDING_VERSION, ...fields };
}

/** Whole recording as JSONL text. */
export function encodeRecording(r: Recording): string {
  return [r.header, ...r.events].map(encodeLine).join('');
}

/**
 * Parses a recording or a bare snapshot file. A broken last line is dropped with a warning
 * (the app may have been killed mid-write); a broken line elsewhere is an error.
 */
export function parseJsonl(text: string): ParsedJsonl {
  const lines = text
    .split('\n')
    .map((l, i) => ({ no: i + 1, text: l.trim() }))
    .filter((l) => l.text !== '');
  if (lines.length === 0) throw new RecordingError('empty file');
  const warnings: string[] = [];
  const values: { no: number; value: unknown }[] = [];
  lines.forEach((l, i) => {
    try {
      values.push({ no: l.no, value: JSON.parse(l.text) });
    } catch {
      if (i === lines.length - 1 && i > 0) warnings.push(`line ${l.no}: incomplete, ignored`);
      else throw new RecordingError(`line ${l.no}: not JSON`);
    }
  });
  const first = values[0];
  if (first === undefined) throw new RecordingError('empty file');
  const head = first.value as { type?: unknown } | null;
  if (typeof head === 'object' && head !== null && head.type === 'header') {
    const header = checkHeader(head);
    const events = values.slice(1).map(({ no, value }) => checkEvent(value, no));
    return { kind: 'recording', recording: { header, events }, warnings };
  }
  const snapshots = values.map(({ no, value }) => {
    if (!isTelemetrySnapshot(value)) {
      throw new RecordingError(`line ${no}: not a recording header or TelemetrySnapshot v1`);
    }
    return value;
  });
  return { kind: 'snapshots', snapshots, warnings };
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

function checkHeader(x: Record<string, unknown>): RecordingHeader {
  const bad = (why: string) => new RecordingError(`line 1 (header): ${why}`);
  if (x['format'] !== RECORDING_FORMAT) throw bad(`format must be ${RECORDING_FORMAT}`);
  if (x['v'] !== RECORDING_VERSION) throw bad(`unsupported version ${String(x['v'])}`);
  if (!isNum(x['recordedAt'])) throw bad('recordedAt');
  if (!isStr(x['source'])) throw bad('source');
  if (x['appVersion'] !== undefined && !isStr(x['appVersion'])) throw bad('appVersion');
  if (!(x['seed'] === null || isStr(x['seed']) || isNum(x['seed']))) throw bad('seed');
  if (!isStr(x['station'])) throw bad('station');
  if (!isStrArr(x['scenarios'])) throw bad('scenarios');
  if (!isStrArr(x['sessionFired'])) throw bad('sessionFired');
  if (!isOfpLike(x['ofp'])) throw bad('ofp');
  if (!isProfile(x['profile'])) throw bad('profile');
  if (x['flags'] !== undefined && !isObj(x['flags'])) throw bad('flags');
  if (x['minGapMs'] !== undefined && !(isNum(x['minGapMs']) && x['minGapMs'] >= 0))
    throw bad('minGapMs');
  if (x['namesVersion'] !== undefined && x['namesVersion'] !== 1 && x['namesVersion'] !== 2)
    throw bad('namesVersion');
  if (x['nextLegVersion'] !== undefined && ![1, 2, 3].includes(x['nextLegVersion'] as number))
    throw bad('nextLegVersion');
  if (x['lateStartVersion'] !== undefined && ![1, 2, 3].includes(x['lateStartVersion'] as number))
    throw bad('lateStartVersion');
  if (x['massUnit'] !== undefined && !['ofp', 'kg', 'lb'].includes(x['massUnit'] as string))
    throw bad('massUnit');
  if (x['rescueVersion'] !== undefined && x['rescueVersion'] !== 1 && x['rescueVersion'] !== 2)
    throw bad('rescueVersion');
  if (x['hub'] !== undefined && !(isStr(x['hub']) && /^[A-Z]{4}$/.test(x['hub']))) throw bad('hub');
  const p = x['probabilities'];
  if (p !== undefined && !(isObj(p) && Object.values(p).every((v) => isNum(v) && v >= 0 && v <= 1)))
    throw bad('probabilities');
  if (x['dataWaitMs'] !== undefined && !(isNum(x['dataWaitMs']) && x['dataWaitMs'] >= 0))
    throw bad('dataWaitMs');
  if (x['simTime'] !== undefined && typeof x['simTime'] !== 'boolean') throw bad('simTime');
  const fk = x['flightKind'];
  if (
    fk !== undefined &&
    !(isKindChoice(fk) && (fk['kind'] === undefined || isFlightKind(fk['kind'])))
  )
    throw bad('flightKind');
  // Recordings made before T58 call the XATC station `rops`.
  const r = x['xatc'] ?? x['rops'];
  if (
    r !== undefined &&
    !(
      isObj(r) &&
      typeof r['enabled'] === 'boolean' &&
      (r['standAside'] === undefined || typeof r['standAside'] === 'boolean') &&
      (r['randomDirects'] === undefined || typeof r['randomDirects'] === 'boolean') &&
      (r['squawkTables'] === undefined ||
        r['squawkTables'] === 'full' ||
        r['squawkTables'] === 'public')
    )
  )
    throw bad('xatc');
  const dl = x['datalink'];
  if (
    dl !== undefined &&
    !(
      isObj(dl) &&
      typeof dl['satcom'] === 'boolean' &&
      (dl['icaoHex'] === undefined || /^[0-9A-Fa-f]{6}$/.test(String(dl['icaoHex']))) &&
      (dl['headerInText'] === undefined || typeof dl['headerInText'] === 'boolean')
    )
  )
    throw bad('datalink');
  if ('rops' in x) {
    const { rops: _, ...rest } = x;
    return (r === undefined ? rest : { ...rest, xatc: r }) as unknown as RecordingHeader;
  }
  return x as unknown as RecordingHeader;
}

/** `{ override: FlightKind | null }` (T89). */
function isKindChoice(x: unknown): x is Record<string, unknown> {
  return isObj(x) && (x['override'] === null || isFlightKind(x['override']));
}

/** Spot check: the OFP was normalized by the app that wrote the file. */
function isOfpLike(x: unknown): x is Ofp {
  if (!isObj(x) || !isStr(x['callsign'])) return false;
  const { source, times, origin, destination } = x;
  return (
    isObj(source) &&
    isStr(source['requestId']) &&
    isObj(times) &&
    isNum(times['schedOutMs']) &&
    isObj(origin) &&
    isStr(origin['icao']) &&
    isObj(destination) &&
    isStr(destination['icao']) &&
    Array.isArray(x['navlog'])
  );
}

function isProfile(x: unknown): x is DisplayProfile {
  return (
    isObj(x) &&
    isStr(x['id']) &&
    isStrArr(x['matchIcao']) &&
    Number.isInteger(x['lineWidth']) &&
    (x['lineWidth'] as number) > 0 &&
    typeof x['uppercase'] === 'boolean' &&
    isStr(x['allowedChars']) &&
    (x['maxLines'] === undefined || Number.isInteger(x['maxLines'])) &&
    (x['matchTitleRegex'] === undefined || isStr(x['matchTitleRegex'])) &&
    (x['pageBreak'] === undefined || isStr(x['pageBreak']))
  );
}

function checkEvent(x: unknown, no: number): RecordingEvent {
  const bad = (why: string) => new RecordingError(`line ${no}: ${why}`);
  if (!isObj(x)) throw bad('expected an object');
  switch (x['type']) {
    case 'start':
    case 'stop':
    case 'resume':
      if (!isNum(x['now'])) throw bad('now');
      return x as unknown as RecordingEvent;
    case 'tick':
      if (!isNum(x['now'])) throw bad('now');
      if (!(x['telemetry'] === null || isTelemetrySnapshot(x['telemetry']))) {
        throw bad('telemetry is not a TelemetrySnapshot v1');
      }
      if (x['inbound'] !== undefined) {
        const ok =
          Array.isArray(x['inbound']) &&
          x['inbound'].every(
            (m: unknown) =>
              isObj(m) &&
              isStr(m['from']) &&
              isStr(m['type']) &&
              isStr(m['text']) &&
              (m['to'] === undefined || isStr(m['to'])),
          );
        if (!ok) throw bad('inbound must be [{from, type, text, to?}]');
      }
      if (x['force'] !== undefined && !isStrArr(x['force'])) throw bad('force must be [id]');
      if (x['flightKind'] !== undefined && !isKindChoice(x['flightKind']))
        throw bad('flightKind must be {override: kind | null}');
      if (x['data'] !== undefined) {
        try {
          checkExtDataUpdate(x['data']);
        } catch (err) {
          if (err instanceof ExtDataError) throw bad(err.message);
          throw err;
        }
      }
      return x as unknown as RecordingEvent;
    case 'end':
      if (!isNum(x['now'])) throw bad('now');
      if (x['to'] !== 'TURNAROUND' && x['to'] !== 'DONE') throw bad('to');
      return x as unknown as RecordingEvent;
    case 'out':
      if (!isNum(x['t'])) throw bad('t');
      for (const k of ['scenarioId', 'from', 'to', 'text']) if (!isStr(x[k])) throw bad(k);
      if (x['packet'] !== undefined && !isStr(x['packet'])) throw bad('packet');
      return x as unknown as RecordingEvent;
    case 'cmd':
      if (!isNum(x['t'])) throw bad('t');
      for (const k of ['scenarioId', 'command']) if (!isStr(x[k])) throw bad(k);
      if (!isObj(x['data'])) throw bad('data');
      return x as unknown as RecordingEvent;
    case 'summary': {
      if (!isNum(x['now'])) throw bad('now');
      const r = x['report'];
      if (!isObj(r) || r['v'] !== FLIGHT_REPORT_VERSION || !isStr(r['callsign'])) {
        throw bad(`report must be a FlightReport v${FLIGHT_REPORT_VERSION}`);
      }
      return x as unknown as RecordingEvent;
    }
    case 'sent':
      if (!isNum(x['t'])) throw bad('t');
      if (!(Number.isInteger(x['n']) && (x['n'] as number) >= 0)) throw bad('n');
      if (x['result'] !== 'sent' && x['result'] !== 'failed') throw bad('result');
      return x as unknown as RecordingEvent;
    default:
      throw bad(`unknown type ${JSON.stringify(x['type'])}`);
  }
}

/** Tick period of the app main loop. */
export const TICK_MS = 1_000;

/**
 * Turns bare snapshots (bridge dump, synthetic flight) into core inputs the way the app feeds
 * them: start, one tick per snapshot at its own time and empty ticks every second inside
 * gaps, so telemetry loss and time triggers behave as live.
 */
export function eventsFromSnapshots(snapshots: readonly TelemetrySnapshot[]): RecordingEvent[] {
  const first = snapshots[0];
  if (first === undefined) return [];
  const events: RecordingEvent[] = [{ type: 'start', now: first.t }];
  let last = first.t;
  for (const s of snapshots) {
    if (s.t < last) throw new RecordingError(`snapshot time goes backwards at ${s.t}`);
    for (let now = last + TICK_MS; now <= s.t - TICK_MS / 2; now += TICK_MS) {
      events.push({ type: 'tick', now, telemetry: null });
    }
    events.push({ type: 'tick', now: s.t, telemetry: s });
    last = s.t;
  }
  return events;
}

/** Bare snapshots of a recording, for `acars-msfs-bridge --source fake --replay`. */
export function snapshotsOf(r: Recording): TelemetrySnapshot[] {
  return r.events.flatMap((e) => (e.type === 'tick' && e.telemetry !== null ? [e.telemetry] : []));
}
