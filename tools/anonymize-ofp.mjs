// Turns a real SimBrief OFP (json=v2) into a small anonymized test fixture.
//
//   node tools/anonymize-ofp.mjs <raw.json> <out.json> [--to-lbs] [--no-flight-number] [--extra-alternate] [--with-perf]
//
// Keeps only the sections the parser reads, drops personal data (pilot id, crew, user ids,
// links, files, NOTAMs, free text). Raw OFPs live in reference/ofp/raw/ (gitignored).
// Flags produce synthetic variants for tests: weights converted to lbs, empty flight
// number / airline, a second alternate. `--with-perf` keeps the TLR (`tlr`, no personal data)
// and the crew head count: names are replaced with role placeholders.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath, ...flags] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/anonymize-ofp.mjs <raw.json> <out.json> [flags]');
  process.exit(1);
}
const has = (f) => flags.includes(f);

const raw = JSON.parse(readFileSync(inPath, 'utf8'));

const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

const AIRPORT_KEYS = [
  'icao_code',
  'iata_code',
  'name',
  'elevation',
  'pos_lat',
  'pos_long',
  'timezone',
  'plan_rwy',
  'trans_alt',
  'trans_level',
  'metar',
];
const airport = (a) => ({
  ...pick(a, AIRPORT_KEYS),
  atis: (a.atis ?? []).map((x) => pick(x, ['network', 'issued', 'letter', 'type'])),
});

const FIX_KEYS = [
  'ident',
  'name',
  'type',
  'pos_lat',
  'pos_long',
  'stage',
  'via_airway',
  'is_sid_star',
  'distance',
  'altitude_feet',
  'track_mag',
  'mora',
  'fir',
  'fir_valid_levels',
  'time_total',
  'fuel_plan_onboard',
];

const out = {
  fetch: { status: raw.fetch.status },
  params: {
    request_id: '0',
    time_generated: raw.params.time_generated,
    ofp_layout: raw.params.ofp_layout,
    airac: raw.params.airac,
    units: raw.params.units,
  },
  general: pick(raw.general, [
    'icao_airline',
    'flight_number',
    'costindex',
    'initial_altitude',
    'stepclimb_string',
    'route',
    'sid_ident',
    'star_ident',
    'passengers',
    'route_distance',
    'gc_distance',
  ]),
  origin: airport(raw.origin),
  destination: airport(raw.destination),
  alternate: (raw.alternate ?? []).map(airport),
  navlog: raw.navlog.map((f) => pick(f, FIX_KEYS)),
  atc: pick(raw.atc, ['callsign', 'flight_rules', 'flight_type', 'initial_alt']),
  aircraft: pick(raw.aircraft, [
    'icao_code',
    'iata_code',
    'name',
    'engines',
    'reg',
    'equip',
    'equip_category',
    'max_passengers',
  ]),
  fuel: pick(raw.fuel, [
    'taxi',
    'enroute_burn',
    'contingency',
    'alternate_burn',
    'reserve',
    'extra',
    'min_takeoff',
    'plan_takeoff',
    'plan_ramp',
    'plan_landing',
  ]),
  times: pick(raw.times, [
    'est_time_enroute',
    'sched_out',
    'sched_off',
    'sched_on',
    'sched_in',
    'sched_block',
    'est_out',
    'est_off',
    'est_on',
    'est_in',
    'est_block',
    'taxi_out',
    'taxi_in',
  ]),
  weights: pick(raw.weights, [
    'oew',
    'pax_count',
    'bag_count',
    'pax_weight',
    'bag_weight',
    'cargo',
    'payload',
    'est_zfw',
    'max_zfw',
    'est_tow',
    'max_tow',
    'est_ldw',
    'max_ldw',
    'est_ramp',
  ]),
};

if (has('--with-perf')) {
  if (raw.tlr) out.tlr = raw.tlr;
  if (raw.crew) {
    const names = (v, role) => (Array.isArray(v) ? v.map(() => role) : v ? role : '');
    out.crew = {
      cpt: names(raw.crew.cpt, 'CPT'),
      fo: names(raw.crew.fo, 'FO'),
      pu: names(raw.crew.pu, 'PU'),
      fa: names(raw.crew.fa, 'FA'),
    };
  }
}

if (has('--to-lbs')) {
  const KG_TO_LB = 1 / 0.45359237;
  const conv = (v) => String(Math.round(Number(v) * KG_TO_LB));
  for (const k of Object.keys(out.fuel)) out.fuel[k] = conv(out.fuel[k]);
  for (const k of Object.keys(out.weights)) {
    if (k !== 'pax_count' && k !== 'bag_count') out.weights[k] = conv(out.weights[k]);
  }
  for (const f of out.navlog) f.fuel_plan_onboard = conv(f.fuel_plan_onboard);
  out.params.units = 'lbs';
}
if (has('--no-flight-number')) {
  out.general.icao_airline = '';
  out.general.flight_number = '';
}
if (has('--extra-alternate') && out.alternate[0]) {
  out.alternate.push({
    ...out.alternate[0],
    icao_code: 'ZZZZ',
    iata_code: '',
    name: 'SYNTHETIC SECOND ALTERNATE',
    plan_rwy: '',
    atis: [],
  });
}

writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${outPath} (${out.navlog.length} fixes, units ${out.params.units})`);
