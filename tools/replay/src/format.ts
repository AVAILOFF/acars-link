import {
  type DisplayProfile,
  isTelemetrySnapshot,
  type Ofp,
  type TelemetrySnapshot,
} from '@acars/core';

/**
 * Flight recording, JSONL (T11). One JSON object per line:
 *
 * ```
 * {"type":"header","format":"acars-sim-recording","v":1,…,"ofp":{…}}   first line
 * {"type":"start","now":…}                                             user started the flight
 * {"type":"tick","now":…,"telemetry":{…}|null}                         one core tick
 * {"type":"end","now":…,"to":"DONE"}                                   user closed the flight
 * {"type":"out","t":…,"scenarioId":…,"from":…,"to":…,"text":…}        telex the core produced live
 * {"type":"stop","now":…}                                              flight stopped
 * ```
 *
 * The lines are the inputs of the core (`AcarsCore`) in call order, so a replay with the same
 * scenarios and seed gives the same messages (CLAUDE.md, invariant 4). `out` lines are the live
 * output, kept for comparison. Telemetry is the bridge snapshot as received (`t` = bridge
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
}

export type RecordingEvent =
  | { readonly type: 'start'; readonly now: number }
  | {
      readonly type: 'tick';
      readonly now: number;
      readonly telemetry: TelemetrySnapshot | null;
    }
  | { readonly type: 'end'; readonly now: number; readonly to: 'TURNAROUND' | 'DONE' }
  | {
      readonly type: 'out';
      readonly t: number;
      readonly scenarioId: string;
      readonly from: string;
      readonly to: string;
      readonly text: string;
    }
  | { readonly type: 'stop'; readonly now: number };

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
  if (!(x['seed'] === null || isStr(x['seed']) || isNum(x['seed']))) throw bad('seed');
  if (!isStr(x['station'])) throw bad('station');
  if (!isStrArr(x['scenarios'])) throw bad('scenarios');
  if (!isStrArr(x['sessionFired'])) throw bad('sessionFired');
  if (!isOfpLike(x['ofp'])) throw bad('ofp');
  if (!isProfile(x['profile'])) throw bad('profile');
  return x as unknown as RecordingHeader;
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
      if (!isNum(x['now'])) throw bad('now');
      return x as unknown as RecordingEvent;
    case 'tick':
      if (!isNum(x['now'])) throw bad('now');
      if (!(x['telemetry'] === null || isTelemetrySnapshot(x['telemetry']))) {
        throw bad('telemetry is not a TelemetrySnapshot v1');
      }
      return x as unknown as RecordingEvent;
    case 'end':
      if (!isNum(x['now'])) throw bad('now');
      if (x['to'] !== 'TURNAROUND' && x['to'] !== 'DONE') throw bad('to');
      return x as unknown as RecordingEvent;
    case 'out':
      if (!isNum(x['t'])) throw bad('t');
      for (const k of ['scenarioId', 'from', 'to', 'text']) if (!isStr(x[k])) throw bad(k);
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
