import { ATC_MAX_AGE_MS, type CenterStation, type ExtState, type FirArea } from '../ext/data.js';
import type { LatLon } from '../geo/geo.js';
import type { Ofp } from '../ofp/types.js';
import type { FlightPhase } from '../phase/fsm.js';
import type { OutboundMessage } from '../scenario/engine.js';
import type { PilotMessage } from '../scenario/pilot.js';
import type { TelemetrySnapshot } from '../telemetry/types.js';
import { type CpdlcHeader, type CpdlcResponse, formatCpdlc, parseCpdlc } from './cpdlc.js';
import { atcUnitName, FirMap, ropsStation } from './fir.js';

/**
 * ROPS ATC station (T23, docs/07): a simulated CPDLC ground station for the own pilot only,
 * one per FIR, on Hoppie. The aircraft logs on (`REQUEST LOGON`), the station answers
 * `LOGON ACCEPTED` and `CURRENT ATC UNIT`; at a FIR boundary it hands the aircraft over
 * (`HANDOVER @<next>`), and the aircraft logs on to the next station by itself — the Hoppie
 * form of the CDA/NDA transfer of real CPDLC. Packets and phrases: `cpdlc.ts`.
 *
 * Approved decisions (docs/07 T23, 2026-10-09): callsign `X` + FIR (`fir.ts`); VATSpy FIRs;
 * where a live VATSIM centre covers the FIR (and `standAside` is on), the station steps
 * aside — a notice and LOGOFF to a connected aircraft, `UNABLE` to a logon — until the next
 * FIR or until the controller leaves.
 *
 * Deterministic: input = position, phase, the aircraft's messages to our stations and the
 * external data; no randomness. Other CPDLC requests are T25: until then they get
 * `MESSAGE NOT SUPPORTED BY THIS ATS UNIT` (a phrase of real Hoppie stations).
 */

export const ROPS_ID = '#rops';

/** How long the old station still listens after a HANDOVER (for the aircraft's LOGOFF). */
export const HANDOVER_LISTEN_MS = 10 * 60_000;

export interface RopsOptions {
  readonly enabled: boolean;
  /** Step aside where a live VATSIM centre covers the FIR (default true). */
  readonly standAside?: boolean;
}

export type AtcEvent =
  /** The station the aircraft should log on to changed (a new FIR). */
  | {
      readonly type: 'ATC_STATION';
      readonly t: number;
      readonly fir: string;
      readonly station: string;
      readonly unit: string;
    }
  | {
      readonly type: 'ATC_LOGON';
      readonly t: number;
      readonly station: string;
      readonly accepted: boolean;
      /** Why a logon was refused. */
      readonly reason: 'live_atc' | 'wrong_station' | null;
    }
  | {
      readonly type: 'ATC_HANDOVER';
      readonly t: number;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly type: 'ATC_LOGOFF';
      readonly t: number;
      readonly station: string;
      readonly by: 'pilot' | 'atc';
    }
  /** A live VATSIM centre covers the FIR: the station stepped aside. */
  | {
      readonly type: 'ATC_LIVE';
      readonly t: number;
      readonly fir: string;
      readonly callsign: string;
      readonly frequency: string;
    }
  /** A CPDLC message the station does not handle (answered "not supported"). */
  | {
      readonly type: 'ATC_UNSUPPORTED';
      readonly t: number;
      readonly station: string;
      readonly text: string;
    };

export interface RopsState {
  readonly v: 1;
  /** FIR the aircraft is in. */
  readonly fir: string | null;
  /** Station the aircraft is logged on to. */
  readonly connected: string | null;
  /** HANDOVER sent: the old station listens until `until` for the aircraft's LOGOFF. */
  readonly handover: { readonly from: string; readonly to: string; readonly until: number } | null;
  /** Last uplink `min` per station. */
  readonly min: Readonly<Record<string, number>>;
  /** FIR where the station stepped aside for a live controller. */
  readonly aside: string | null;
  /** The flight is on block: no more listening. */
  readonly ended: boolean;
}

export interface RopsTickInput {
  readonly now: number;
  readonly phase: FlightPhase;
  readonly telemetry: TelemetrySnapshot | null;
  /** The aircraft's messages to ROPS stations (`to` set), oldest first. */
  readonly inbound: readonly PilotMessage[];
  readonly ext: ExtState;
}

export interface RopsTickOutput {
  readonly outbound: readonly OutboundMessage[];
  readonly events: readonly AtcEvent[];
}

const ENDED: ReadonlySet<FlightPhase> = new Set(['ON_BLOCK', 'TURNAROUND', 'DONE']);
/** Station callsigns ROPS may own: `X` + 3 letters (FIRs, T23; airports, T24). */
export const ROPS_CALLSIGN = /^X[A-Z]{3}$/;

export const EMPTY_ROPS: RopsState = {
  v: 1,
  fir: null,
  connected: null,
  handover: null,
  min: {},
  aside: null,
  ended: false,
};

export class RopsStation {
  private st: {
    fir: string | null;
    connected: string | null;
    handover: { from: string; to: string; until: number } | null;
    min: Record<string, number>;
    aside: string | null;
    ended: boolean;
  };
  private map: FirMap | null = null;
  private mapOf: readonly FirArea[] | null = null;
  private readonly standAside: boolean;

  constructor(
    private readonly ofp: Ofp,
    options: RopsOptions,
    state: RopsState = EMPTY_ROPS,
  ) {
    this.standAside = options.standAside ?? true;
    const copy = JSON.parse(JSON.stringify(state)) as RopsState;
    if (copy.v !== 1) throw new Error(`unsupported RopsState version ${String(copy.v)}`);
    this.st = {
      fir: copy.fir,
      connected: copy.connected,
      handover: copy.handover === null ? null : { ...copy.handover },
      min: { ...copy.min },
      aside: copy.aside,
      ended: copy.ended,
    };
  }

  getState(): RopsState {
    return JSON.parse(JSON.stringify({ v: 1, ...this.st })) as RopsState;
  }

  /** Station the aircraft should log on to now (the FIR's), or null. */
  get station(): string | null {
    return this.st.fir === null || this.st.ended ? null : ropsStation(this.st.fir);
  }

  get connected(): string | null {
    return this.st.connected;
  }

  get fir(): string | null {
    return this.st.fir;
  }

  /** Callsigns to poll now: the FIR's station, the connected one, a handover's old one. */
  get listen(): readonly string[] {
    if (this.st.ended) return [];
    const out = new Set<string>();
    if (this.station !== null) out.add(this.station);
    if (this.st.connected !== null) out.add(this.st.connected);
    if (this.st.handover !== null) out.add(this.st.handover.from);
    return [...out].sort();
  }

  tick(input: RopsTickInput): RopsTickOutput {
    const outbound: OutboundMessage[] = [];
    const events: AtcEvent[] = [];
    const now = input.now;
    const send = (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => {
      const min = (this.st.min[from] ?? 0) + 1;
      this.st.min[from] = min;
      const cpdlc: CpdlcHeader = { min, mrn, ra };
      outbound.push({
        scenarioId: ROPS_ID,
        from,
        to: this.ofp.callsign,
        kind: 'cpdlc',
        cpdlc,
        message: formatCpdlc(text),
        t: now,
        toPilot: true,
      });
    };

    // The flight is over: messages to the stations are not answered.
    if (this.st.ended) return { outbound, events };

    const map = this.firMap(input.ext);
    if (this.st.handover !== null && now >= this.st.handover.until) this.st.handover = null;

    // 1. The aircraft's messages, in order.
    for (const m of input.inbound) this.receive(m, input, map, send, events);

    // 2. Position → FIR; a boundary crossed hands over or steps aside.
    if (map !== null) {
      const pos: LatLon = input.telemetry ?? this.ofp.origin;
      const area = map.locate(pos);
      if (area !== null && area.id !== this.st.fir) {
        this.st.fir = area.id;
        const station = ropsStation(area.id);
        events.push({
          type: 'ATC_STATION',
          t: now,
          fir: area.id,
          station,
          unit: atcUnitName(area),
        });
        const old = this.st.connected;
        if (old !== null && old !== station) {
          const live = this.live(input.ext, area.id, now);
          if (live !== null) {
            this.stepAside(old, area.id, live, send, events, now);
          } else {
            send(old, 'NE', null, `HANDOVER @${station}`);
            this.st.handover = { from: old, to: station, until: now + HANDOVER_LISTEN_MS };
            this.st.connected = null;
            events.push({ type: 'ATC_HANDOVER', t: now, from: old, to: station });
          }
        }
      }
    }

    // 3. A live controller came online in the FIR of a connected aircraft.
    const fir = this.st.fir;
    if (fir !== null) {
      const live = this.live(input.ext, fir, now);
      if (live === null) {
        if (this.st.aside === fir) this.st.aside = null;
      } else if (this.st.aside !== fir) {
        const connected = this.st.connected;
        if (connected !== null) this.stepAside(connected, fir, live, send, events, now);
        else {
          this.st.aside = fir;
          events.push({
            type: 'ATC_LIVE',
            t: now,
            fir,
            callsign: live.callsign,
            frequency: live.frequency,
          });
        }
      }
    }

    // 4. On block: the service ends.
    if (ENDED.has(input.phase)) {
      const connected = this.st.connected;
      if (connected !== null) {
        send(connected, 'NE', null, 'LOGOFF');
        events.push({ type: 'ATC_LOGOFF', t: now, station: connected, by: 'atc' });
      }
      this.st.connected = null;
      this.st.handover = null;
      this.st.ended = true;
    }
    return { outbound, events };
  }

  private receive(
    m: PilotMessage,
    input: RopsTickInput,
    map: FirMap | null,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => void,
    events: AtcEvent[],
  ): void {
    const to = m.to ?? '';
    if (m.from.toUpperCase() !== this.ofp.callsign.toUpperCase()) return;
    if (m.type.toLowerCase() !== 'cpdlc') return;
    const p = parseCpdlc(m.text);
    // Only stations we run now answer (the transport polls no others).
    if (p === null || !this.listen.includes(to)) return;
    const now = input.now;

    if (p.text === 'REQUEST LOGON') {
      const station = this.station;
      if (station === null || to !== station) {
        send(to, 'NE', p.min, station === null ? 'UNABLE' : `UNABLE@_@LOGON TO @${station}@`);
        events.push({
          type: 'ATC_LOGON',
          t: now,
          station: to,
          accepted: false,
          reason: 'wrong_station',
        });
        return;
      }
      const fir = this.st.fir as string;
      const live = this.live(input.ext, fir, now);
      if (live !== null) {
        send(to, 'NE', p.min, `UNABLE@_@${liveText(live)}`);
        events.push({
          type: 'ATC_LOGON',
          t: now,
          station: to,
          accepted: false,
          reason: 'live_atc',
        });
        return;
      }
      const area = map?.get(fir) ?? null;
      send(to, 'NE', p.min, 'LOGON ACCEPTED');
      send(to, 'NE', null, `CURRENT ATC UNIT@_@${to}@_@${area === null ? to : atcUnitName(area)}`);
      this.st.connected = to;
      if (this.st.handover?.to === to) this.st.handover = null;
      events.push({ type: 'ATC_LOGON', t: now, station: to, accepted: true, reason: null });
      return;
    }
    if (p.text === 'LOGOFF') {
      if (this.st.connected === to) this.st.connected = null;
      if (this.st.handover?.from === to) this.st.handover = null;
      events.push({ type: 'ATC_LOGOFF', t: now, station: to, by: 'pilot' });
      return;
    }
    // Answers to our messages need nothing (no open dialogues in T23).
    if (p.mrn !== null && /^(WILCO|UNABLE|ROGER|STANDBY|AFFIRM|NEGATIVE)\b/.test(p.text)) return;
    send(to, 'NE', p.min, 'MESSAGE NOT SUPPORTED BY THIS ATS UNIT');
    events.push({ type: 'ATC_UNSUPPORTED', t: now, station: to, text: p.text });
  }

  /** Notice + LOGOFF from `station`; the FIR's live controller serves the aircraft. */
  private stepAside(
    station: string,
    fir: string,
    live: CenterStation,
    send: (from: string, ra: CpdlcResponse, mrn: number | null, text: string) => void,
    events: AtcEvent[],
    now: number,
  ): void {
    send(station, 'NE', null, liveText(live));
    send(station, 'NE', null, 'LOGOFF');
    this.st.connected = null;
    this.st.aside = fir;
    events.push({
      type: 'ATC_LIVE',
      t: now,
      fir,
      callsign: live.callsign,
      frequency: live.frequency,
    });
    events.push({ type: 'ATC_LOGOFF', t: now, station, by: 'atc' });
  }

  /** A live centre covering `fir` in fresh VATSIM data, if stepping aside is on. */
  private live(ext: ExtState, fir: string, now: number): CenterStation | null {
    if (!this.standAside) return null;
    const t = ext.centersT ?? null;
    if (ext.centers == null || t === null || now - t > ATC_MAX_AGE_MS) return null;
    const list = ext.centers.filter((c) => c.firs.includes(fir));
    // The station named after the FIR first, then by callsign (stable).
    list.sort(
      (a, b) =>
        Number(b.callsign.startsWith(`${fir}_`)) - Number(a.callsign.startsWith(`${fir}_`)) ||
        (a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0),
    );
    return list[0] ?? null;
  }

  private firMap(ext: ExtState): FirMap | null {
    const firs = ext.firs ?? null;
    if (firs === null || firs.length === 0) return null;
    if (firs !== this.mapOf) {
      this.map = new FirMap(firs);
      this.mapOf = firs;
    }
    return this.map;
  }
}

function liveText(c: CenterStation): string {
  return `VATSIM ATC ONLINE@_@CONTACT ${c.callsign} @${c.frequency}@`;
}
