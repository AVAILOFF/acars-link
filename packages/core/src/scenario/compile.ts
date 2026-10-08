import { FLIGHT_PHASES, type FlightPhase } from '../phase/fsm.js';
import { isContextVariable } from './context.js';
import { type CompiledExpr, compileExpr, ExprError } from './expr.js';
import { type CompiledTemplate, compileTemplate, TemplateError } from './template.js';
import {
  DISTANCE_TARGETS,
  type ScenarioDef,
  type Step,
  TIME_REFS,
  TRIGGER_EVENTS,
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

export type CompiledStep =
  | {
      readonly kind: 'send';
      readonly header: CompiledTemplate | null;
      readonly body: CompiledTemplate;
      readonly footer: CompiledTemplate | null;
    }
  | { readonly kind: 'wait_minutes'; readonly minutes: number }
  | { readonly kind: 'wait_phase'; readonly phase: FlightPhase };

export interface CompiledScenario {
  readonly def: ScenarioDef;
  readonly id: string;
  readonly conditions: readonly CompiledExpr[];
  readonly steps: readonly CompiledStep[];
  readonly probability: number;
  readonly priority: number;
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

  if (def.steps.length === 0) fail('steps', 'must not be empty');
  const steps = def.steps.map((s: Step, i): CompiledStep => {
    const path = `steps[${i}]`;
    if ('send' in s) {
      const body = template(`${path}.send.body`, s.send.body);
      if (body === null) return fail(`${path}.send.body`, 'missing');
      return {
        kind: 'send',
        header: template(`${path}.send.header`, s.send.header),
        body,
        footer: template(`${path}.send.footer`, s.send.footer),
      };
    }
    if ('wait' in s) {
      const w = s.wait;
      if ('minutes' in w) {
        if (!(w.minutes > 0)) fail(`${path}.wait.minutes`, 'must be > 0');
        return { kind: 'wait_minutes', minutes: w.minutes };
      }
      if ('phase' in w) {
        if (!isPhase(w.phase)) fail(`${path}.wait.phase`, `unknown phase ${String(w.phase)}`);
        return { kind: 'wait_phase', phase: w.phase };
      }
      return fail(`${path}.wait`, 'v0 supports wait.minutes and wait.phase only');
    }
    return fail(path, `unsupported step ${Object.keys(s).join(',')} (v0: send, wait)`);
  });

  return { def, id, conditions, steps, probability, priority: def.priority ?? 0 };
}
