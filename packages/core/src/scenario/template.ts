import { metarQnh } from '../ext/data.js';
import type { Rng } from '../random/rng.js';
import { holdPosition, seatLetters } from './aircraft.js';
import type { Lookup, Value } from './expr.js';
import { NAME_KINDS, type NameKind, personName } from './names.js';

/**
 * Message templates (docs/05 "Шаблоны"): `{var}`, `{var|fmt}`, `{var|fmt:arg|fmt2}`,
 * generators `{rand:10-35}`, `{rand:-5-5}`, `{pick:[A,B,C]}`, `{seat}`, `{hold}` (by the aircraft, T40), `{name:crew}`,
 * `{name:ops}` (`K. TANAKA`; surnames by the origin's ICAO region, see `names.ts`).
 *
 * Formatters: `kg1` (12345 → 12.3), `hhmm` and `ddmmm` (epoch ms, UTC), `pad:N`
 * (right-pad to N), `lpad:N` (left-pad), `int` (round), `sign` (+3, -120, 0), `upper`,
 * `or:TEXT` (TEXT when the value is missing), `qnh` (the `Q1013` / `A2992` group of a METAR,
 * T13).
 * A missing value renders as {@link MISSING}. Numbers are data: templates never invent
 * them (invariant 8) — `rand`/`pick` use the scenario's seeded Rng.
 */

export const MISSING = '----';

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
}

type Source =
  | { readonly k: 'var'; readonly path: string }
  | { readonly k: 'rand'; readonly min: number; readonly max: number }
  | { readonly k: 'pick'; readonly items: readonly string[] }
  | { readonly k: 'seat' }
  | { readonly k: 'hold' }
  | { readonly k: 'name'; readonly kind: NameKind };

interface Fmt {
  readonly name: string;
  readonly arg: string | undefined;
}

type Part = string | { readonly src: Source; readonly fmts: readonly Fmt[] };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const pad2 = (n: number) => String(n).padStart(2, '0');

function asNumber(v: Value | string, fmt: string): number | null {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new TemplateError(`|${fmt} needs a number, got ${String(v)}`);
  return n;
}

function intArg(f: Fmt): number {
  const n = Number(f.arg);
  if (!Number.isInteger(n) || n < 1 || n > 80) {
    throw new TemplateError(`|${f.name} needs a width 1..80, got ${String(f.arg)}`);
  }
  return n;
}

const FORMATTERS: Readonly<Record<string, (v: Value | string, f: Fmt) => Value | string>> = {
  kg1: (v, f) => {
    const n = asNumber(v, f.name);
    return n === null ? null : (n / 1000).toFixed(1);
  },
  int: (v, f) => {
    const n = asNumber(v, f.name);
    return n === null ? null : String(Math.round(n));
  },
  hhmm: (v, f) => {
    const n = asNumber(v, f.name);
    if (n === null) return null;
    const d = new Date(n);
    return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
  },
  ddmmm: (v, f) => {
    const n = asNumber(v, f.name);
    if (n === null) return null;
    const d = new Date(n);
    return pad2(d.getUTCDate()) + (MONTHS[d.getUTCMonth()] as string);
  },
  sign: (v, f) => {
    const n = asNumber(v, f.name);
    if (n === null) return null;
    const r = Math.round(n);
    return r > 0 ? `+${r}` : String(r);
  },
  qnh: (v) => (v === null ? null : metarQnh(text(v))),
  upper: (v) => (v === null ? null : text(v).toUpperCase()),
  // A missing value as this text instead of ----: `{cmd.reason|or:NOT GIVEN}`.
  or: (v, f) => (v === null ? (f.arg as string) : v),
  pad: (v, f) => text(v).padEnd(intArg(f)),
  lpad: (v, f) => text(v).padStart(intArg(f)),
};

const ARG_FORMATTERS = new Set(['pad', 'lpad', 'or']);

function text(v: Value | string): string {
  if (v === null) return MISSING;
  if (Array.isArray(v)) return v.map(text).join(' ');
  return String(v);
}

function parseSource(expr: string): Source {
  if (expr === 'seat') return { k: 'seat' };
  if (expr === 'hold') return { k: 'hold' };
  const name = /^name:([a-z]+)$/.exec(expr);
  if (name !== null) {
    const kind = name[1] as NameKind;
    if (!NAME_KINDS.includes(kind)) {
      throw new TemplateError(`{${expr}}: name kinds are ${NAME_KINDS.join(', ')}`);
    }
    return { k: 'name', kind };
  }
  const rand = /^rand:(-?\d+)-(-?\d+)$/.exec(expr);
  if (rand !== null) {
    const min = Number(rand[1]);
    const max = Number(rand[2]);
    if (min > max) throw new TemplateError(`{${expr}}: min > max`);
    return { k: 'rand', min, max };
  }
  const pick = /^pick:\[(.*)\]$/.exec(expr);
  if (pick !== null) {
    const items = (pick[1] as string).split(',').map((s) => s.trim());
    if (items.some((s) => s === '')) throw new TemplateError(`{${expr}}: empty pick item`);
    return { k: 'pick', items };
  }
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$|^phase$/.test(expr)) return { k: 'var', path: expr };
  throw new TemplateError(`unknown placeholder {${expr}}`);
}

function parseFmt(s: string): Fmt {
  const [name = '', arg] = s.split(':', 2);
  if (!(name in FORMATTERS)) throw new TemplateError(`unknown formatter |${name}`);
  if (ARG_FORMATTERS.has(name) !== (arg !== undefined)) {
    throw new TemplateError(
      `formatter |${name} ${arg === undefined ? 'needs' : 'takes no'} argument`,
    );
  }
  const f = { name, arg };
  if (name === 'or' && arg?.trim() === '') throw new TemplateError('|or needs a text');
  if (name === 'pad' || name === 'lpad') intArg(f);
  return f;
}

export interface CompiledTemplate {
  readonly source: string;
  /** Variable paths the template reads. */
  readonly vars: readonly string[];
  render(look: Lookup, rng: Rng): string;
}

export function compileTemplate(source: string): CompiledTemplate {
  const parts: Part[] = [];
  const vars = new Set<string>();
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    const close = source.indexOf('}', i);
    if (close >= 0 && (open < 0 || close < open)) {
      throw new TemplateError(`unmatched "}" at ${close} in template`);
    }
    if (open < 0) {
      parts.push(source.slice(i));
      break;
    }
    if (open > i) parts.push(source.slice(i, open));
    // `pick:[A,B]` may not contain braces, so the first `}` closes the placeholder.
    const end = source.indexOf('}', open);
    if (end < 0) throw new TemplateError(`unclosed "{" at ${open} in template`);
    const inner = source.slice(open + 1, end).trim();
    const [head = '', ...rest] = splitPipes(inner);
    const src = parseSource(head.trim());
    if (src.k === 'var') vars.add(src.path);
    if (src.k === 'name') vars.add('ofp.orig');
    parts.push({ src, fmts: rest.map((s) => parseFmt(s.trim())) });
    i = end + 1;
  }
  return {
    source,
    vars: [...vars],
    render: (look, rng) =>
      parts
        .map((p) => {
          if (typeof p === 'string') return p;
          let v: Value | string = resolve(p.src, look, rng);
          for (const f of p.fmts) v = (FORMATTERS[f.name] as (typeof FORMATTERS)[string])(v, f);
          return text(v);
        })
        .join(''),
  };
}

/** Splits on `|` outside `[...]` (pick items may not contain `|` anyway). */
function splitPipes(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === '|' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function resolve(src: Source, look: Lookup, rng: Rng): Value {
  switch (src.k) {
    case 'var': {
      const v = look(src.path);
      if (v === undefined) throw new TemplateError(`unknown variable {${src.path}}`);
      return v;
    }
    case 'rand':
      return rng.int(src.min, src.max);
    case 'pick':
      return rng.pick(src.items);
    case 'seat': {
      const family = look('aircraft.family');
      const body = look('aircraft.body');
      const letters = seatLetters(
        typeof family === 'string' ? family : null,
        typeof body === 'string' ? body : null,
      );
      return `${rng.int(1, 45)}${rng.pick([...letters])}`;
    }
    case 'hold': {
      const family = look('aircraft.family');
      const body = look('aircraft.body');
      return holdPosition(
        typeof family === 'string' ? family : null,
        typeof body === 'string' ? body : null,
        rng,
      );
    }
    case 'name': {
      const orig = look('ofp.orig');
      return personName(src.kind, typeof orig === 'string' ? orig : '', rng);
    }
  }
}
