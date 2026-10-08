/**
 * @acars/core — pure TypeScript core: flight-phase FSM, scheduler, scenario runtime, formatter.
 *
 * No Electron, DOM, Node API or network here (CLAUDE.md, invariant 3).
 * Time and randomness are injected via Clock and Rng (invariant 4).
 */
export const CORE_PACKAGE = '@acars/core';

export * from './geo/geo.js';
export * from './ofp/index.js';
export * from './random/rng.js';
export * from './synthetic/flight.js';
export * from './telemetry/types.js';
export * from './time/clock.js';
