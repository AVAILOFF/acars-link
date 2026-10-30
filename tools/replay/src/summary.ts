// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { FlightReport, OooiKind, PlanFigure } from '@acars/core';

/** The flight report (T69) as text: actual, plan and difference per line; no data = `-`. */

const OOOI: readonly OooiKind[] = ['OUT', 'OFF', 'ON', 'IN'];

const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;

function duration(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  return `${ms < 0 ? '-' : ''}${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

const signed = (n: number, unit: string) => `${n > 0 ? '+' : ''}${n} ${unit}`;
const minutes = (ms: number) => signed(Math.round(ms / 60_000), 'min');

function row(
  label: string,
  f: PlanFigure,
  show: (n: number) => string,
  diff: (n: number) => string,
) {
  const cell = (n: number | null) => (n === null ? '-' : show(n));
  return `  ${label.padEnd(14)}${cell(f.actual).padStart(9)}${cell(f.plan).padStart(9)}  ${
    f.diff === null ? '' : diff(f.diff)
  }`.trimEnd();
}

export function formatSummary(r: FlightReport, ended = true): string {
  const kg = (n: number) => String(n);
  const head = `${r.callsign} ${r.origin}-${r.destination} ${r.aircraftIcao}${
    r.aircraftReg === null ? '' : ` ${r.aircraftReg}`
  }`;
  const landed =
    r.landed === null
      ? '-'
      : r.landed.icao === null
        ? `unknown airport at ${r.landed.lat.toFixed(4)} ${r.landed.lon.toFixed(4)} (diverted)`
        : r.landed.diverted
          ? `${r.landed.icao} (diverted, planned ${r.destination})`
          : r.landed.icao;
  const delay =
    r.delay.parts.length === 0
      ? `${r.delay.min} min`
      : `${r.delay.min} min (${r.delay.parts.map((p) => `${p.code}: ${p.min}`).join(', ')})`;
  return [
    `FLIGHT REPORT ${head}${ended ? '' : '  (the flight was not closed: report of the last line)'}`,
    `  ${'times'.padEnd(14)}${'actual'.padStart(9)}${'plan'.padStart(9)}`,
    ...OOOI.map((k) => row(k, r.times[k], hhmm, minutes)),
    row('block', r.blockMs, duration, minutes),
    row('flight', r.airMs, duration, minutes),
    `  ${'fuel, kg'.padEnd(14)}${'actual'.padStart(9)}${'plan'.padStart(9)}`,
    ...OOOI.map((k) => row(k, r.fuelKg[k], kg, (n) => signed(n, 'kg'))),
    row('taxi out burn', r.burnKg.taxiOut, kg, (n) => signed(n, 'kg')),
    row('trip burn', r.burnKg.trip, kg, (n) => signed(n, 'kg')),
    row('taxi in burn', r.burnKg.taxiIn, kg, (n) => signed(n, 'kg')),
    row('block burn', r.burnKg.block, kg, (n) => signed(n, 'kg')),
    `  touchdown     ${r.touchdownFpm === null ? 'no data' : `${r.touchdownFpm} ft/min`}`,
    `  landed        ${landed}`,
    ...(r.divert === null ? [] : [`  divert set    ${r.divert}`]),
    `  go-arounds    ${r.goArounds}`,
    `  delay         ${delay}`,
    `  messages      airline ${r.messages.airline}, pilot ${r.messages.pilot} (replies ${r.messages.replies})`,
    `  irregular     ${r.irregular.length === 0 ? '-' : r.irregular.join(', ')}`,
    '',
  ].join('\n');
}
