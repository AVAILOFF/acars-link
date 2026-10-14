import { FLIGHT_PHASES, type FlightPhase } from '../phase/fsm.js';
import {
  checkVdgsLines,
  VDGS_DISPLAY_NAMES,
  VDGS_DISPLAYS,
  VDGS_DURATION,
  type VdgsDisplay,
} from '../sim/vdgs.js';
import { isContextVariable, isFlagVariable } from './context.js';
import { type CompiledExpr, compileExpr, ExprError } from './expr.js';
import { type CompiledTemplate, compileTemplate, TemplateError } from './template.js';
import {
  DISTANCE_TARGETS,
  PILOT_COMMANDS,
  type ScenarioDef,
  SET_TARGETS,
  type Step,
  TIME_REFS,
  TRIGGER_EVENTS,
  UNTIL_OUTCOMES,
} from './types.js';

/**
 * Semantic checks on top of the JSON Schema (`@acars/scenarios`): expressions and
 * templates parse, every variable exists, enums and ranges hold. The engine only runs
 * compiled scenarios.
 */

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
  constructor(
    readonly scenarioId: string,
    readonly path: string,
    message: string,
  ) {
    super(`scenario "${scenarioId}" ${path}: ${message}`);
  }
}

/**
 * Steps are a flat program: `branch` jumps to the first step of an arm (or to `end` when the
 * answer has no arm), each arm ends with a `jump` to `end`. Run state is one step index.
 */
export type CompiledStep =
  | {
      readonly kind: 'send';
      readonly header: CompiledTemplate | null;
      readonly body: CompiledTemplate;
      readonly footer: CompiledTemplate | null;
    }
  | { readonly kind: 'wait_minutes'; readonly minutes: number }
  | { readonly kind: 'wait_phase'; readonly phase: FlightPhase }
  | {
      readonly kind: 'wait_reply';
      readonly options: readonly string[];
      readonly timeoutMin: number;
      readonly default: string;
    }
  | {
      readonly kind: 'wait_until';
      readonly cond: CompiledExpr;
      readonly timeoutMin: number;
    }
  | {
      readonly kind: 'branch';
      readonly arms: Readonly<Record<string, number>>;
      readonly end: number;
    }
  | { readonly kind: 'jump'; readonly to: number }
  | { readonly kind: 'resend'; readonly of: readonly string[] }
  | { readonly kind: 'set'; readonly assigns: readonly CompiledAssign[] }
  | {
      readonly kind: 'vdgs';
      readonly durationSec: number;
      readonly displays: Readonly<Partial<Record<VdgsDisplay, readonly CompiledVdgsLine[]>>>;
    };

export interface CompiledVdgsLine {
  readonly t: CompiledTemplate;
  readonly red: boolean;
}

/** One `set` assignment: a literal, a variable's raw value, or a rendered template. */
export interface CompiledAssign {
  readonly target: string;
  readonly value:
    | { readonly k: 'lit'; readonly v: string | number | boolean | null }
    | { readonly k: 'var'; readonly path: string }
    | { readonly k: 'tpl'; readonly t: CompiledTemplate };
}

export interface CompiledScenario {
  readonly def: ScenarioDef;
  readonly id: string;
  readonly conditions: readonly CompiledExpr[];
  readonly steps: readonly CompiledStep[];
  readonly probability: number;
  readonly priority: number;
  /** Members of the group that may start in one flight; null = no limit (T39). */
  readonly groupMax: number | null;
}

/** Group descriptions (`@acars/scenarios`): name → limit. */
export type ScenarioGroups = Readonly<Record<string, { readonly max_per_flight: number }>>;

/**
 * Gives a scenario its group's limit (T39). `compileScenario` leaves it null (no limit): the
 * table of groups lives in `@acars/scenarios`, which calls this for every scenario it loads.
 */
export function withGroups(s: CompiledScenario, groups: ScenarioGroups): CompiledScenario {
  const name = s.def.group;
  if (name === undefined) return s;
  const g = groups[name];
  if (g === undefined) throw new ScenarioError(s.id, 'group', `unknown group "${name}"`);
  if (!(Number.isInteger(g.max_per_flight) && g.max_per_flight >= 1)) {
    throw new ScenarioError(
      s.id,
      'group',
      `group "${name}": max_per_flight must be an integer ≥ 1`,
    );
  }
  return { ...s, groupMax: g.max_per_flight };
}

const ID = /^[a-z][a-z0-9_]*$/;

export function compileScenario(def: ScenarioDef): CompiledScenario {
  const id = typeof def.id === 'string' ? def.id : '?';
  const fail = (path: string, msg: string): never => {
    throw new ScenarioError(id, path, msg);
  };
  if (!ID.test(id)) fail('id', 'must be snake_case');
  if (def.version !== 1) fail('version', `unsupported version ${String(def.version)}`);

  const isPhase = (p: unknown): p is FlightPhase => FLIGHT_PHASES.includes(p as FlightPhase);
  const tr = def.trigger;
  switch (tr.on) {
    case 'phase_enter':
    case 'phase':
      if (!isPhase(tr.phase)) fail('trigger.phase', `unknown phase ${String(tr.phase)}`);
      break;
    case 'event':
      if (!TRIGGER_EVENTS.includes(tr.event)) fail('trigger.event', `unknown event ${tr.event}`);
      break;
    case 'command':
      if (!PILOT_COMMANDS.includes(tr.command)) {
        fail('trigger.command', `unknown command ${String(tr.command)}`);
      }
      break;
    case 'time':
      if (!TIME_REFS.includes(tr.at.rel)) fail('trigger.at.rel', `unknown time ${tr.at.rel}`);
      if (!Number.isFinite(tr.at.offset_min)) fail('trigger.at.offset_min', 'must be a number');
      break;
    case 'distance': {
      const d = tr.dist;
      if (!DISTANCE_TARGETS.includes(d.to)) fail('trigger.dist.to', `unknown target ${d.to}`);
      if (d.lte_nm === undefined && d.gte_nm === undefined) {
        fail('trigger.dist', 'needs lte_nm and/or gte_nm');
      }
      for (const v of [d.lte_nm, d.gte_nm]) {
        if (v !== undefined && !(v >= 0)) fail('trigger.dist', 'distances must be ≥ 0');
      }
      break;
    }
    default:
      fail('trigger.on', `unknown trigger ${String((tr as { on: unknown }).on)}`);
  }

  const probability = def.probability ?? 1;
  if (!(probability >= 0 && probability <= 1)) fail('probability', 'must be 0..1');
  const cd = def.cooldown ?? 'per_flight';
  if (typeof cd === 'object' && !(cd.minutes > 0)) fail('cooldown.minutes', 'must be > 0');
  for (const x of def.excludes ?? []) {
    if (x === id) fail('excludes', 'a scenario cannot exclude itself');
  }

  if (def.group !== undefined && !ID.test(def.group)) fail('group', 'must be snake_case');

  const vars = (path: string, used: readonly string[]) => {
    for (const v of used) if (!isContextVariable(v)) fail(path, `unknown variable ${v}`);
  };

  const conditions = (def.conditions ?? []).map((src, i) => {
    try {
      const e = compileExpr(src);
      vars(`conditions[${i}]`, e.vars);
      return e;
    } catch (e) {
      if (e instanceof ExprError) return fail(`conditions[${i}]`, e.message);
      throw e;
    }
  });

  const template = (path: string, src: string | undefined): CompiledTemplate | null => {
    if (src === undefined) return null;
    try {
      const t = compileTemplate(src);
      vars(path, t.vars);
      return t;
    } catch (e) {
      if (e instanceof TemplateError) return fail(path, e.message);
      throw e;
    }
  };

  const steps: CompiledStep[] = [];
  /**
   * Appends `list` to `steps`. `reply` = options of the answer a `branch` here would see:
   * null before any `wait: reply`, MIXED after a branch whose arms asked different questions.
   */
  const emit = (list: readonly Step[], at: string, reply: Reply): Reply => {
    if (list.length === 0) fail(at, 'must not be empty');
    for (const [i, s] of list.entries()) {
      const path = `${at}[${i}]`;
      if ('send' in s) {
        const body = template(`${path}.send.body`, s.send.body);
        if (body === null) {
          fail(`${path}.send.body`, 'missing');
          continue;
        }
        steps.push({
          kind: 'send',
          header: template(`${path}.send.header`, s.send.header),
          body,
          footer: template(`${path}.send.footer`, s.send.footer),
        });
        continue;
      }
      if ('wait' in s) {
        const w = s.wait;
        if ('minutes' in w) {
          if (!(w.minutes > 0)) fail(`${path}.wait.minutes`, 'must be > 0');
          steps.push({ kind: 'wait_minutes', minutes: w.minutes });
        } else if ('phase' in w) {
          if (!isPhase(w.phase)) fail(`${path}.wait.phase`, `unknown phase ${String(w.phase)}`);
          steps.push({ kind: 'wait_phase', phase: w.phase });
        } else if ('reply' in w) {
          const r = w.reply;
          if (r.options.length === 0) fail(`${path}.wait.reply.options`, 'must not be empty');
          for (const o of r.options) {
            if (!OPTION.test(o)) fail(`${path}.wait.reply.options`, `"${o}": one word A-Z0-9`);
          }
          if (new Set(r.options).size !== r.options.length) {
            fail(`${path}.wait.reply.options`, 'must be unique');
          }
          if (!(r.timeout_min > 0)) fail(`${path}.wait.reply.timeout_min`, 'must be > 0');
          if (!r.options.includes(r.default)) {
            fail(`${path}.wait.reply.default`, `"${r.default}" is not one of the options`);
          }
          steps.push({
            kind: 'wait_reply',
            options: [...r.options],
            timeoutMin: r.timeout_min,
            default: r.default,
          });
          reply = r.options;
        } else if ('until' in w) {
          if (!(w.timeout_min > 0)) fail(`${path}.wait.timeout_min`, 'must be > 0');
          let cond: CompiledExpr;
          try {
            cond = compileExpr(w.until);
          } catch (e) {
            if (e instanceof ExprError) return fail(`${path}.wait.until`, e.message);
            throw e;
          }
          vars(`${path}.wait.until`, cond.vars);
          steps.push({ kind: 'wait_until', cond, timeoutMin: w.timeout_min });
          reply = UNTIL_OPTIONS;
        } else {
          fail(`${path}.wait`, 'needs minutes, phase, reply or until');
        }
        continue;
      }
      if ('branch' in s) {
        if (reply === null) fail(`${path}.branch`, 'needs a wait: reply before it');
        if (reply === MIXED) {
          fail(`${path}.branch`, 'the answer depends on the arm taken before; ask again first');
        }
        const keys = Object.keys(s.branch);
        if (keys.length === 0) fail(`${path}.branch`, 'must not be empty');
        for (const k of keys) {
          if (!(reply as readonly string[]).includes(k)) {
            fail(`${path}.branch.${k}`, `"${k}" is not an option of the last wait: reply`);
          }
        }
        const at0 = steps.length;
        steps.push({ kind: 'jump', to: -1 }); // replaced by the branch below
        const arms: Record<string, number> = {};
        const jumps: number[] = [];
        let after: Reply = reply;
        for (const k of keys) {
          arms[k] = steps.length;
          const out = emit(s.branch[k] as readonly Step[], `${path}.branch.${k}`, reply);
          if (out !== reply) after = MIXED;
          jumps.push(steps.length);
          steps.push({ kind: 'jump', to: -1 });
        }
        const end = steps.length;
        for (const j of jumps) steps[j] = { kind: 'jump', to: end };
        steps[at0] = { kind: 'branch', arms, end };
        reply = after;
        continue;
      }
      if ('resend' in s) {
        if (s.resend.of.length === 0) fail(`${path}.resend.of`, 'must not be empty');
        for (const x of s.resend.of) {
          if (!ID.test(x)) fail(`${path}.resend.of`, `"${x}" is not a scenario id`);
        }
        steps.push({ kind: 'resend', of: [...s.resend.of] });
        continue;
      }
      if ('set' in s) {
        const entries = Object.entries(s.set);
        if (entries.length === 0) fail(`${path}.set`, 'must not be empty');
        const assigns: CompiledAssign[] = [];
        for (const [target, v] of entries) {
          const at = `${path}.set.${target}`;
          if (!isFlagVariable(target) && !(SET_TARGETS as readonly string[]).includes(target)) {
            fail(at, `can set flags.<name> (a-z0-9_) or ${SET_TARGETS.join(', ')}`);
          }
          if (typeof v !== 'string') {
            if (v !== null && typeof v !== 'number' && typeof v !== 'boolean') {
              fail(at, 'value must be a string, number, boolean or null');
            }
            if (typeof v === 'number' && !Number.isFinite(v)) fail(at, 'number must be finite');
            if (target !== 'flight.divert' || v === null) {
              assigns.push({ target, value: { k: 'lit', v } });
              continue;
            }
            fail(at, 'must be an ICAO code or a template');
          }
          const only = /^\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\s*\}$/.exec(v as string);
          if (only !== null) {
            vars(at, [only[1] as string]);
            assigns.push({ target, value: { k: 'var', path: only[1] as string } });
            continue;
          }
          assigns.push({
            target,
            value: { k: 'tpl', t: template(at, v as string) as CompiledTemplate },
          });
        }
        steps.push({ kind: 'set', assigns });
        continue;
      }
      if ('vdgs' in s) {
        const v = s.vdgs;
        const durationSec = v.duration_sec ?? VDGS_DURATION.default;
        if (!(durationSec >= VDGS_DURATION.min && durationSec <= VDGS_DURATION.max)) {
          fail(`${path}.vdgs.duration_sec`, `must be ${VDGS_DURATION.min}..${VDGS_DURATION.max}`);
        }
        if (v.narrow === undefined) fail(`${path}.vdgs.narrow`, 'missing');
        const displays: Partial<Record<VdgsDisplay, CompiledVdgsLine[]>> = {};
        for (const d of VDGS_DISPLAY_NAMES) {
          const list = v[d];
          if (list === undefined) continue;
          const at = `${path}.vdgs.${d}`;
          if (list.length === 0 || list.length > VDGS_DISPLAYS[d].lines) {
            fail(at, `needs 1..${VDGS_DISPLAYS[d].lines} lines`);
          }
          displays[d] = list.map((line, i) => {
            const red = typeof line !== 'string';
            const src = red ? line.red : line;
            // A literal line is checked now; a template only when it is rendered.
            if (!src.includes('{')) {
              const why = checkVdgsLines(d, [{ text: src.trim().toUpperCase(), red }]);
              if (why !== null) fail(`${at}[${i}]`, why);
            }
            return { t: template(`${at}[${i}]`, src) as CompiledTemplate, red };
          });
        }
        steps.push({ kind: 'vdgs', durationSec, displays });
        continue;
      }
      fail(path, `unsupported step ${Object.keys(s).join(',')}`);
    }
    return reply;
  };
  emit(def.steps, 'steps', null);

  return { def, id, conditions, steps, probability, priority: def.priority ?? 0, groupMax: null };
}

const OPTION = /^[A-Z][A-Z0-9]*$/;
const MIXED = Symbol('mixed');
const UNTIL_OPTIONS: readonly string[] = UNTIL_OUTCOMES;
type Reply = readonly string[] | null | typeof MIXED;
