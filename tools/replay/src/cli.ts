// Flight recordings on the command line (T11): replay through the core, synthetic flights,
// snapshot dumps for the bridge. See USAGE.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  BUILTIN_PROFILES,
  DEFAULT_PROFILE,
  type DisplayProfile,
  type Ofp,
  parseSimbriefOfpText,
} from '@acars/core';
import { encodeRecording, parseJsonl, type Recording, snapshotsOf } from './format.js';
import { hasPurgedConnex } from './purge.js';
import { formatReport } from './report.js';
import { compareOutbound, replay } from './run.js';
import { defaultEnabled, pickScenarios, type ScenarioFile } from './scenarios.js';
import { recordingFromSnapshots, syntheticRecording } from './synthetic.js';

export const USAGE = `usage:
  pnpm replay run <file.jsonl> [options]     replay a recording through the core
      --ofp <simbrief.json>     OFP (SimBrief json=v2) for a bare snapshot file
      --scenarios <dir|file>    extra scenario YAML; replaces base scenarios with the same id
                                and is always enabled (repeatable)
      --no-base                 do not load packages/scenarios/base, /commands, /external, /irregular
      --pilot <min>=<text>      a pilot telex <min> minutes after the start (repeatable),
                                e.g. --pilot "40=REQ GATE" --pilot "95=DIVERT RJOO"
      --only <id,id,…>          run exactly these scenarios
      --all                     run every loaded scenario (default: those enabled in the flight)
      --seed <text>             core seed (default: the recorded one)
      --station <template>      station callsign template (default: the recorded one)
      --profile <id>            display profile: ${[DEFAULT_PROFILE, ...BUILTIN_PROFILES].map((p) => p.id).join(', ')}
      --brief                   no telex bodies
      --verbose                 also scenario start/done/skip, pauses, step climbs
      --json                    JSON lines instead of text
      --check                   compare with the live telexes in the recording; exit 1 if different
  pnpm replay synth --ofp <simbrief.json> [--out <file.jsonl>]
      --go-around <ft>          go around once at this height AGL
      --boarding <min>          minutes at the gate before pushback (default 35; less = late start)
      --seed <text>             core seed, also used for the instrument noise
  pnpm replay snapshots <file.jsonl> [--out <file.jsonl>]
      bare TelemetrySnapshot lines for: acars-msfs-bridge --source fake --replay <file>
`;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const nodeIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
};

/** The scenarios the app ships: the base set and the pilot command handlers (T12) and the live-data scenarios (T13). */
const BASE_DIRS = ['base', 'commands', 'external', 'irregular', 'sim'].map((d) =>
  fileURLToPath(new URL(`../../../packages/scenarios/${d}/`, import.meta.url)),
);
const readBase = () => BASE_DIRS.flatMap((d) => readScenarioPath(d));

class UsageError extends Error {}

/** Returns the exit code: 0 ok, 1 `--check` found differences, 2 error. */
export async function main(argv: readonly string[], io: Io = nodeIo): Promise<number> {
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'run':
        return runCommand(rest, io);
      case 'synth':
        return synthCommand(rest, io);
      case 'snapshots':
        return snapshotsCommand(rest, io);
      case undefined:
      case '-h':
      case '--help':
        io.out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof UsageError) io.err(USAGE);
    return 2;
  }
}

function parse<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

function runCommand(args: string[], io: Io): number {
  const { values: v, positionals } = parse({
    args,
    allowPositionals: true,
    options: {
      ofp: { type: 'string' },
      scenarios: { type: 'string', multiple: true },
      'no-base': { type: 'boolean' },
      only: { type: 'string' },
      all: { type: 'boolean' },
      seed: { type: 'string' },
      station: { type: 'string' },
      profile: { type: 'string' },
      brief: { type: 'boolean' },
      verbose: { type: 'boolean' },
      json: { type: 'boolean' },
      check: { type: 'boolean' },
      pilot: { type: 'string', multiple: true },
    },
  });
  const file = one(positionals, 'run <file.jsonl>');
  const base = v['no-base'] === true ? [] : readBase();
  const pilot = (v.pilot ?? []).map(pilotLine);
  const extra = (v.scenarios ?? []).flatMap((p) => readScenarioPath(p));
  const recording = readRecording(file, v.ofp, base, io);

  const picked = pickScenarios({
    base,
    extra,
    recorded: recording.header.scenarios,
    ...(v.only === undefined ? {} : { only: splitIds(v.only) }),
    ...(v.all === true ? { all: true } : {}),
  });
  if (picked.missing.length > 0) {
    io.err(`warning: scenarios of the flight not found: ${picked.missing.join(', ')}\n`);
  }
  const result = replay(recording, {
    scenarios: picked.scenarios,
    ...(v.seed === undefined ? {} : { seed: v.seed }),
    ...(v.station === undefined ? {} : { station: v.station }),
    ...(v.profile === undefined ? {} : { profile: profileById(v.profile) }),
    ...(pilot.length === 0 ? {} : { pilot }),
  });

  if (v.json === true) {
    for (const e of result.timeline) {
      io.out(
        `${JSON.stringify(
          e.kind === 'out'
            ? {
                kind: 'out',
                now: e.now,
                scenarioId: e.message.scenarioId,
                from: e.message.from,
                to: e.message.to,
                text: e.message.message.text,
              }
            : e,
        )}\n`,
      );
    }
  } else {
    const h = recording.header;
    io.out(
      `${h.ofp.callsign} ${h.ofp.origin.icao}-${h.ofp.destination.icao} ` +
        `(${h.source}, recorded ${new Date(h.recordedAt).toISOString()}), ` +
        `${picked.scenarios.length} scenarios, profile ${result.profile}\n\n`,
    );
    io.out(
      formatReport(result, {
        ...(v.brief === true ? { brief: true } : {}),
        ...(v.verbose === true ? { verbose: true } : {}),
      }),
    );
  }

  if (v.check !== true) return 0;
  if (result.recorded.length === 0) {
    io.err('check: the recording has no live telexes to compare with\n');
    return result.outbound.length === 0 ? 0 : 1;
  }
  const diff = compareOutbound(result.recorded, result.outbound);
  if (diff.length === 0) {
    io.err(`check: ${result.outbound.length} telexes match the live run\n`);
    return 0;
  }
  io.err(`check: ${diff.length} differences from the live run:\n${diff.join('\n')}\n`);
  return 1;
}

function synthCommand(args: string[], io: Io): number {
  const { values: v, positionals } = parse({
    args,
    allowPositionals: true,
    options: {
      ofp: { type: 'string' },
      out: { type: 'string' },
      'go-around': { type: 'string' },
      boarding: { type: 'string' },
      seed: { type: 'string' },
    },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected ${positionals.join(' ')}`);
  if (v.ofp === undefined) throw new UsageError('synth needs --ofp <simbrief.json>');
  const ofp = readOfp(v.ofp);
  const goAround = v['go-around'] === undefined ? undefined : num(v['go-around'], '--go-around');
  const boarding = v.boarding === undefined ? undefined : num(v.boarding, '--boarding');
  const recording = syntheticRecording(
    { ofp, scenarios: defaultEnabled(readBase()), seed: v.seed ?? null },
    {
      ...(goAround === undefined ? {} : { goAroundAglFt: goAround }),
      ...(boarding === undefined ? {} : { boardingSec: boarding * 60 }),
      ...(v.seed === undefined ? {} : { seed: v.seed }),
    },
  );
  write(encodeRecording(recording), v.out, io);
  return 0;
}

function snapshotsCommand(args: string[], io: Io): number {
  const { values: v, positionals } = parse({
    args,
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  const parsed = parseJsonl(readFileSync(one(positionals, 'snapshots <file.jsonl>'), 'utf8'));
  for (const w of parsed.warnings) io.err(`warning: ${w}\n`);
  const snapshots = parsed.kind === 'recording' ? snapshotsOf(parsed.recording) : parsed.snapshots;
  write(snapshots.map((s) => `${JSON.stringify(s)}\n`).join(''), v.out, io);
  return 0;
}

function readRecording(
  file: string,
  ofpFile: string | undefined,
  base: readonly ScenarioFile[],
  io: Io,
): Recording {
  const text = readFileSync(file, 'utf8');
  const parsed = parseJsonl(text);
  for (const w of parsed.warnings) io.err(`warning: ${w}\n`);
  if (hasPurgedConnex(text)) {
    io.err(
      'warning: AeroDataBox data of this recording were purged (older than 7 days, T30): ' +
        'onward-flight telexes replay without them and differ from the live run\n',
    );
  }
  if (parsed.kind === 'recording') {
    if (ofpFile === undefined) return parsed.recording;
    return { ...parsed.recording, header: { ...parsed.recording.header, ofp: readOfp(ofpFile) } };
  }
  if (ofpFile === undefined) throw new UsageError(`${file} has no header: pass --ofp`);
  return recordingFromSnapshots(parsed.snapshots, {
    ofp: readOfp(ofpFile),
    scenarios: defaultEnabled(base),
  });
}

function readOfp(file: string): Ofp {
  return parseSimbriefOfpText(readFileSync(file, 'utf8'));
}

/** A YAML file, or every `*.yaml` in a folder (sorted). */
function readScenarioPath(p: string): ScenarioFile[] {
  const read = (f: string) => ({ file: f, source: readFileSync(f, 'utf8') });
  if (!statSync(p).isDirectory()) return [read(p)];
  return readdirSync(p)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => read(join(p, f)));
}

/** `40=REQ GATE` → 40 min after the start, text `REQ GATE`. */
function pilotLine(s: string): { afterMin: number; text: string } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*=(.+)$/.exec(s);
  if (m === null) throw new UsageError(`--pilot "${s}": expected <min>=<text>`);
  return { afterMin: Number(m[1]), text: (m[2] as string).trim() };
}

function profileById(id: string): DisplayProfile {
  const all = [DEFAULT_PROFILE, ...BUILTIN_PROFILES];
  const p = all.find((x) => x.id === id);
  if (p === undefined) throw new UsageError(`unknown --profile ${id}`);
  return p;
}

const splitIds = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

function num(s: string, what: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${what} must be a number ≥ 0`);
  return n;
}

function one(positionals: string[], what: string): string {
  if (positionals.length !== 1) throw new UsageError(`expected ${what}`);
  return positionals[0] as string;
}

function write(text: string, out: string | undefined, io: Io): void {
  if (out === undefined) io.out(text);
  else writeFileSync(out, text, 'utf8');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
