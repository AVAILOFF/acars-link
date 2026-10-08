/**
 * @acars/core — pure TypeScript core: flight-phase FSM, scheduler, scenario runtime, formatter.
 *
 * No Electron, DOM, Node API or network here (CLAUDE.md, invariant 3).
 * Time and randomness are injected via Clock and Rng (invariant 4).
 */
export const CORE_PACKAGE = '@acars/core';

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
export * from './scenario/names.js';
export * from './scenario/ops-data.js';
export * from './scenario/pilot.js';
export * from './scenario/template.js';
export * from './scenario/types.js';
export * from './synthetic/anomalies.js';
export * from './synthetic/flight.js';
export * from './telemetry/types.js';
export * from './time/clock.js';
