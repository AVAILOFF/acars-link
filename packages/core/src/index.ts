/**
 * @acars/core — pure TypeScript core: flight-phase FSM, scheduler, scenario runtime, formatter.
 *
 * No Electron, DOM, Node API or network here (CLAUDE.md, invariant 3).
 * Time and randomness are injected via Clock and Rng (invariant 4).
 */
export const CORE_PACKAGE = '@acars/core';

export * from './atc/cpdlc.js';
export * from './atc/dcl.js';
export * from './atc/fir.js';
export * from './atc/levels.js';
export * from './atc/performance.js';
export * from './atc/requests.js';
export * from './atc/rops.js';
export * from './atc/route.js';
export * from './atc/squawk/squawk.js';
export * from './core.js';
export * from './ext/data.js';
export * from './format/formatter.js';
export * from './format/profile.js';
export * from './geo/geo.js';
export * from './ofp/index.js';
export * from './phase/fsm.js';
export * from './random/rng.js';
export * from './scenario/compile.js';
export * from './scenario/context.js';
export * from './scenario/engine.js';
export * from './scenario/expr.js';
export * from './scenario/irregular-data.js';
export * from './scenario/names.js';
export * from './scenario/ops-data.js';
export * from './scenario/pilot.js';
export * from './scenario/template.js';
export * from './scenario/types.js';
export * from './sim/commands.js';
export * from './sim/vdgs.js';
export * from './synthetic/anomalies.js';
export * from './synthetic/flight.js';
export * from './telemetry/types.js';
export * from './time/clock.js';
