// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { AIR_SHOWS } from '../ext/airshows.js';
import { AVIATION_HISTORY } from '../ext/aviation-history.js';
import type { ExtState } from '../ext/data.js';
import {
  eclipsesBetween,
  type LocalEclipse,
  localEclipse,
  sunElevationDeg,
} from '../ext/special.js';
import { distanceNm, type LatLon } from '../geo/geo.js';
import { hashSeed } from '../random/rng.js';
import type { ContextInput } from './context.js';
import type { Value } from './expr.js';

/**
 * `ext.*` of the special events (T29, docs/07 "T29", docs/05). Each group is null when its event
 * does not apply now; the conditions are the approved ones (docs/07 T29, assumptions 1–9 and the
 * implementation assumptions 1–10). Times are passage times along the planned route: by ground
 * speed when the aircraft moves (≥ 60 kt), else by the OFP en-route time from take-off.
 */
export const SPECIAL_VARIABLES = [
  // space weather (NOAA SWPC): true when R3+, S2+ (route above 60° latitude) or G3+ (now or
  // forecast today/tomorrow); `lines` — one line per scale that is reached
  'ext.swx_alert',
  'ext.swx_lines',
  // aurora (OVATION): the most probable cell ≥ 30 % on the route ahead, reached within 60 min,
  // in darkness (sun below the horizon at the passage)
  'ext.aurora_prob',
  'ext.aurora_pos',
  'ext.aurora_ahead_nm',
  'ext.aurora_min',
  // solar eclipse (NASA Besselian elements): the route point ahead with the greatest magnitude
  // ≥ 0.5 at its passage time, sun above the horizon
  'ext.eclipse_kind',
  'ext.eclipse_mag',
  'ext.eclipse_time',
  'ext.eclipse_pos',
  'ext.eclipse_ahead_nm',
  'ext.eclipse_sun_alt',
  // volcanic ash (SIGMET VA valid now): the cloud closest to the route ahead, ≤ 300 NM
  'ext.ash_volcano',
  'ext.ash_fir',
  'ext.ash_levels',
  'ext.ash_ahead_nm',
  'ext.ash_off_nm',
  'ext.ash_valid_to',
  // earthquake (USGS): the strongest M ≥ 5.0 within 100 km of the destination, last 24 h
  'ext.quake_mag',
  'ext.quake_place',
  'ext.quake_time',
  'ext.quake_dist_km',
  'ext.quake_depth_km',
  // nationwide public holiday of the destination country on the local arrival date (Nager.Date)
  'ext.holiday_name',
  'ext.holiday_local',
  'ext.holiday_country',
  // F1 Grand Prix finished between take-off and now (Jolpica)
  'ext.f1_race',
  'ext.f1_podium',
  'ext.f1_finish',
  // NHL games that went final during this flight (seen open, then final after take-off)
  'ext.nhl_lines',
  'ext.nhl_count',
  // air show within 50 km of the destination on the local arrival date
  'ext.airshow_name',
  'ext.airshow_site',
  'ext.airshow_dates',
  'ext.airshow_source',
  // on this day in aviation history (today's UTC date)
  'ext.history_year',
  'ext.history_text',
  'ext.history_source',
] as const;

export type SpecialVariable = (typeof SPECIAL_VARIABLES)[number];

/** docs/07 T29: thresholds. */
export const SWX_HIGH_LAT_DEG = 60;
export const AURORA_MIN_PROB = 30;
export const AURORA_HORIZON_MIN = 60;
export const ECLIPSE_MIN_MAG = 0.5;
export const QUAKE_MIN_MAG = 5;
export const QUAKE_MAX_KM = 100;
export const AIRSHOW_MAX_KM = 50;
export const NHL_MAX_GAMES = 8;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KM_PER_NM = 1.852;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WORD = ['NONE', 'MINOR', 'MODERATE', 'STRONG', 'SEVERE', 'EXTREME'];

/**
 * Impacts on aviation per level, shortened from the NOAA Space Weather Scales (version of
 * 2023-12-11, https://www.swpc.noaa.gov/noaa-scales-explanation, checked 2026-10-09).
 */
const R_IMPACT: Readonly<Record<number, string>> = {
  3: 'HF BLACKOUT ON SUNLIT SIDE ABOUT 1 HR',
  4: 'HF BLACKOUT ON MOST OF SUNLIT SIDE 1-2 HR',
  5: 'HF BLACKOUT ON ENTIRE SUNLIT SIDE FOR HOURS',
};
const S_IMPACT: Readonly<Record<number, string>> = {
  2: 'ELEVATED RADIATION RISK AT HIGH LATITUDES, HF AFFECTED IN POLAR REGIONS',
  3: 'RADIATION RISK AT HIGH LATITUDES, HF DEGRADED IN POLAR REGIONS',
  4: 'RADIATION RISK AT HIGH LATITUDES, HF BLACKOUT IN POLAR REGIONS',
  5: 'RADIATION RISK AT HIGH LATITUDES, COMPLETE HF BLACKOUT IN POLAR REGIONS',
};
const G_IMPACT: Readonly<Record<number, string>> = {
  3: 'HF INTERMITTENT, SATELLITE NAVIGATION PROBLEMS POSSIBLE',
  4: 'HF SPORADIC, SATELLITE NAVIGATION DEGRADED FOR HOURS',
  5: 'HF MAY BE IMPOSSIBLE, SATELLITE NAVIGATION DEGRADED FOR DAYS',
};

const pad2 = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM-DD` of a time (UTC), cached per day: the context asks every tick. */
const DAYS = new Map<number, string>();
function isoDate(t: number): string {
  const day = Math.floor(t / DAY);
  let text = DAYS.get(day);
  if (text === undefined) {
    if (DAYS.size > 64) DAYS.clear();
    text = new Date(day * DAY).toISOString().slice(0, 10);
    DAYS.set(day, text);
  }
  return text;
}

/** `65N 025W`. */
export function latLonText(p: LatLon): string {
  const lat = Math.round(p.lat);
  const lon = Math.round(p.lon);
  return `${pad2(Math.abs(lat))}${lat >= 0 ? 'N' : 'S'} ${String(Math.abs(lon)).padStart(3, '0')}${lon >= 0 ? 'E' : 'W'}`;
}

/** `13-17JUL`, `30JUN-03JUL`. */
export function dayRangeText(from: string, to: string): string {
  const [, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [, tm, td] = to.split('-').map(Number) as [number, number, number];
  const mon = (m: number) => MONTHS[m - 1] as string;
  if (from === to) return `${pad2(fd)}${mon(fm)}`;
  return fm === tm
    ? `${pad2(fd)}-${pad2(td)}${mon(tm)}`
    : `${pad2(fd)}${mon(fm)}-${pad2(td)}${mon(tm)}`;
}

const NONE = Object.fromEntries(SPECIAL_VARIABLES.map((k) => [k, null])) as Record<
  SpecialVariable,
  Value
>;

/** Per route: some point above 60° latitude (computed once). */
const HIGH_LAT = new WeakMap<object, boolean>();

export function specialVariables(input: ContextInput): Record<SpecialVariable, Value> {
  const { ofp, now, ext, telemetry: tm, polyline } = input;
  const out: Record<SpecialVariable, Value> = { ...NONE };
  if (ext === undefined || polyline === undefined) return out;

  // Lazy: most ticks have none of the data that needs the position on the route.
  let flownNm: number | null = null;
  const flown = () => {
    if (flownNm === null) flownNm = tm === null ? 0 : polyline.locate(tm).alongNm;
    return flownNm;
  };
  const total = polyline.points.at(-1)?.along ?? 0;
  const gs = tm !== null && tm.gsKt >= 60 ? tm.gsKt : null;
  const off = input.oooi.OFF ?? ofp.times.estOffMs ?? ofp.times.estOutMs;
  const ete = ofp.times.estTimeEnrouteSec * 1000;
  /** Passage time of a route distance. */
  const pass = (along: number) =>
    gs !== null
      ? now + ((along - flown()) / gs) * HOUR
      : off + (total > 0 ? (ete * along) / total : 0);
  const eta = () => pass(total);

  // Space weather.
  const sw = ext.spaceWx ?? null;
  if (sw !== null) {
    let highLat = HIGH_LAT.get(polyline);
    if (highLat === undefined) {
      highLat = polyline.points.some((p) => Math.abs(p.lat) > SWX_HIGH_LAT_DEG);
      HIGH_LAT.set(polyline, highLat);
    }
    const fc = sw.gForecast.reduce((m, d) => Math.max(m, d.g), 0);
    const g = Math.max(sw.current.g, fc);
    const lines: string[] = [];
    if (sw.current.r >= 3) {
      lines.push(
        `R${sw.current.r} ${WORD[sw.current.r]} RADIO BLACKOUT`,
        R_IMPACT[sw.current.r] as string,
      );
    }
    if (sw.current.s >= 2 && highLat) {
      lines.push(
        `S${sw.current.s} ${WORD[sw.current.s]} RADIATION STORM`,
        S_IMPACT[sw.current.s] as string,
      );
    }
    if (g >= 3) {
      const when = sw.current.g >= 3 ? 'NOW' : 'FORECAST';
      lines.push(`G${g} ${WORD[g]} GEOMAGNETIC STORM ${when}`, G_IMPACT[g] as string);
    }
    out['ext.swx_alert'] = lines.length > 0;
    out['ext.swx_lines'] = lines.length > 0 ? lines.join('\n') : null;
  }

  // Aurora.
  const au = ext.aurora;
  if (au !== undefined) {
    let best: { prob: number; lat: number; lon: number; along: number; t: number } | null = null;
    for (const c of au.cells) {
      if (c.alongNm < flown() || c.prob < AURORA_MIN_PROB) continue;
      const t = pass(c.alongNm);
      if (t - now > AURORA_HORIZON_MIN * 60_000) continue;
      if (sunElevationDeg(c, t) >= 0) continue;
      if (best === null || c.prob > best.prob) best = { ...c, along: c.alongNm, t };
    }
    if (best !== null) {
      out['ext.aurora_prob'] = best.prob;
      out['ext.aurora_pos'] = latLonText(best);
      out['ext.aurora_ahead_nm'] = best.along - flown();
      out['ext.aurora_min'] = Math.max(0, Math.round((best.t - now) / 60_000));
    }
  }

  // Solar eclipse.
  // Cheap window first (the remaining time is below the whole en-route time + 2 h).
  const eclipses =
    eclipsesBetween(now, now + ete + 2 * HOUR).length > 0 ? eclipsesBetween(now, eta()) : [];
  if (eclipses.length > 0) {
    let best: (LocalEclipse & { p: LatLon; along: number; t: number }) | null = null;
    for (const p of polyline.points) {
      if (p.along < flown()) continue;
      const t = pass(p.along);
      for (const e of eclipses) {
        const le = localEclipse(e, p, t);
        if (le === null || le.sunAltDeg <= 0 || le.magnitude < ECLIPSE_MIN_MAG) continue;
        if (best === null || le.magnitude > best.magnitude) best = { ...le, p, along: p.along, t };
      }
    }
    if (best !== null) {
      out['ext.eclipse_kind'] = best.kind;
      out['ext.eclipse_mag'] = best.magnitude.toFixed(2);
      out['ext.eclipse_time'] = best.t;
      out['ext.eclipse_pos'] = latLonText(best.p);
      out['ext.eclipse_ahead_nm'] = Math.round(best.along - flown());
      out['ext.eclipse_sun_alt'] = Math.round(best.sunAltDeg);
    }
  }

  // Volcanic ash.
  let ash: { a: NonNullable<ExtState['ash']>[number]; along: number; offNm: number } | null = null;
  for (const a of ext.ash ?? []) {
    if (now < a.validFrom || now > a.validTo) continue;
    for (const [along, offNm] of a.near) {
      if (along < flown()) continue;
      if (ash === null || offNm < ash.offNm || (offNm === ash.offNm && along < ash.along)) {
        ash = { a, along, offNm };
      }
    }
  }
  if (ash !== null) {
    const fl = (ft: number | null) =>
      ft === null ? '----' : ft <= 0 ? 'SFC' : `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
    out['ext.ash_volcano'] = ash.a.volcano;
    out['ext.ash_fir'] = ash.a.fir;
    out['ext.ash_levels'] = `${fl(ash.a.baseFt)}/${fl(ash.a.topFt)}`;
    out['ext.ash_ahead_nm'] = ash.along - flown();
    out['ext.ash_off_nm'] = ash.offNm;
    out['ext.ash_valid_to'] = ash.a.validTo;
  }

  // Earthquake near the destination.
  const dest = ofp.destination;
  let quake: { q: NonNullable<ExtState['quakes']>[number]; km: number } | null = null;
  for (const q of ext.quakes ?? []) {
    if (q.mag < QUAKE_MIN_MAG || q.time > now || now - q.time > DAY) continue;
    const km = distanceNm(q, dest) * KM_PER_NM;
    if (km > QUAKE_MAX_KM) continue;
    if (quake === null || q.mag > quake.q.mag || (q.mag === quake.q.mag && q.time > quake.q.time)) {
      quake = { q, km };
    }
  }
  if (quake !== null) {
    out['ext.quake_mag'] = quake.q.mag.toFixed(1);
    out['ext.quake_place'] = quake.q.place;
    out['ext.quake_time'] = quake.q.time;
    out['ext.quake_dist_km'] = Math.round(quake.km);
    out['ext.quake_depth_km'] = Math.round(quake.q.depthKm);
  }

  // Local arrival date (needs the destination's UTC offset).
  const offsetH = dest.utcOffsetH;
  const arrLocal = () => (offsetH === null ? null : isoDate(eta() + offsetH * HOUR));

  // Public holiday.
  const hol = ext.holidays ?? null;
  const holDay = hol === null ? null : arrLocal();
  if (hol !== null && holDay !== null) {
    const h = hol.list.find((x) => x.date === holDay);
    if (h !== undefined) {
      out['ext.holiday_name'] = h.name;
      out['ext.holiday_local'] = h.localName;
      out['ext.holiday_country'] = hol.country;
    }
  }

  // F1.
  const f1 = ext.f1 ?? null;
  if (f1 !== null && input.oooi.OFF !== null && f1.finish >= input.oooi.OFF && f1.finish <= now) {
    out['ext.f1_race'] = f1.name;
    out['ext.f1_podium'] = f1.podium.map((p) => `${p.pos} ${p.code} ${p.team}`).join('\n');
    out['ext.f1_finish'] = f1.finish;
  }

  // NHL.
  const offT = input.oooi.OFF;
  if (ext.nhl !== undefined && offT !== null) {
    const games = Object.values(ext.nhl)
      .filter((s) => s.openT !== null && s.finalT !== null && s.finalT > offT && s.finalT <= now)
      .map((s) => s.game)
      .sort((a, b) => a.start - b.start || a.id - b.id)
      .slice(0, NHL_MAX_GAMES);
    if (games.length > 0) {
      out['ext.nhl_lines'] = games
        .map((g) => {
          const extra = g.lastPeriod === null || g.lastPeriod === 'REG' ? '' : ` ${g.lastPeriod}`;
          return `${g.away} ${g.awayScore ?? '-'} AT ${g.home} ${g.homeScore ?? '-'}${extra}`;
        })
        .join('\n');
      out['ext.nhl_count'] = games.length;
    }
  }

  // Air show at the destination.
  // Only near a show's dates (a day either side covers the time zones).
  const today = isoDate(now);
  const soon = isoDate(now + ete + DAY);
  const yesterday = isoDate(now - DAY);
  const showDay = AIR_SHOWS.some((s) => s.from <= soon && yesterday <= s.to) ? arrLocal() : null;
  if (showDay !== null) {
    const show = AIR_SHOWS.find(
      (s) =>
        s.from <= showDay && showDay <= s.to && distanceNm(s, dest) * KM_PER_NM <= AIRSHOW_MAX_KM,
    );
    if (show !== undefined) {
      out['ext.airshow_name'] = show.name;
      out['ext.airshow_site'] = show.site;
      out['ext.airshow_dates'] = dayRangeText(show.from, show.to);
      out['ext.airshow_source'] = show.source;
    }
  }

  // On this day.
  const day = today.slice(5);
  const facts = AVIATION_HISTORY.filter((f) => f.day === day);
  if (facts.length > 0) {
    const f = facts[hashSeed(`${String(input.seed ?? '')}/history/${today}`) % facts.length];
    if (f !== undefined) {
      out['ext.history_year'] = f.year;
      out['ext.history_text'] = f.text;
      out['ext.history_source'] = f.source;
    }
  }
  return out;
}
