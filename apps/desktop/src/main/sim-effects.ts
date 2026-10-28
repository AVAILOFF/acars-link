// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import {
  destinationPoint,
  fireFlips,
  fireGroup,
  fireTruckCount,
  medicGroup,
  type RescueCommand,
  type SimCommand,
  type SmokeCommand,
  upwindSide,
  vehicleTitles,
} from '@acars/core';
import type { ExternalDataService } from '@acars/data-sources';
import { activeSim, type Settings, type Simulator } from '../shared/api.js';
import type { BridgeClient, CommandResult } from './bridge.js';
import type { Feed } from './feed.js';
import { VdgsWriter } from './vdgs.js';

/**
 * Commands of the core to the simulator (T21) after they leave the flight: VDGS text (T22) to
 * GSX's message folder, smoke (T34) and rescue services (T54) to the bridge with coordinates from
 * the data service, the rest to the bridge as they are. Owns what stands in the sim, so the end
 * of the flight and the app exit take it all down with {@link clear}.
 */

export interface SimEffectsOptions {
  readonly feed: Feed;
  readonly bridge: BridgeClient;
  readonly data: ExternalDataService;
  readonly settings: () => Promise<Settings>;
  /** The simulator the app works with now (T59). */
  readonly sim: () => Promise<Simulator | null>;
  /** A flight runs: a lookup that ends after the flight sends nothing. */
  readonly flying: () => boolean;
  /** ICAO type of the loaded OFP (fire truck count). */
  readonly aircraftIcao: () => string | undefined;
  readonly now: () => number;
  readonly onChange: () => void;
  /** GSX VDGS message folder (T22); null = no GSX. */
  readonly vdgsDir: string | null;
}

export class SimEffects {
  private readonly vdgs: VdgsWriter;
  /** A `smoke_start` was sent and not yet taken down (T34). */
  private smokeOn = false;
  /**
   * Rescue services asked for this flight (T54): the latest airport, the senior fire level (PAN →
   * MAYDAY: `standby` → `full`, never back) and whether an ambulance is wanted. Null = none.
   */
  private rescue: {
    airport: string;
    runway: string | null;
    windFromDeg: number | null;
    fire: 'full' | 'standby' | null;
    medic: boolean;
  } | null = null;
  /** A `rescue_start` was sent and not yet taken down. */
  private rescueOn = false;
  /** Bumped on every rescue request, so a late lookup of an older one is dropped. */
  private rescueSeq = 0;

  constructor(private readonly o: SimEffectsOptions) {
    this.vdgs = new VdgsWriter(o.vdgsDir);
  }

  /**
   * A command for the simulator: only failures reach the feed (a v1 bridge, a write error), so a
   * working channel stays quiet; without GSX the VDGS text is dropped silently. Returns the bridge
   * command id, null for VDGS text, smoke and rescue.
   */
  send(c: SimCommand): string | null {
    if (c.command === 'vdgs') {
      try {
        this.vdgs.show(c);
      } catch (e) {
        this.o.feed.system(this.o.now(), 'sim_command_failed', {
          command: 'vdgs',
          error: 'failed',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      return null;
    }
    if (c.command === 'smoke') {
      void this.sendSmoke(c);
      return null;
    }
    if (c.command === 'rescue') {
      void this.sendRescue(c);
      return null;
    }
    return this.o.bridge.sendCommand(c.command, c.args);
  }

  /** Takes down the VDGS text, smoke and rescue vehicles (end of the flight, app start and exit). */
  clear(): void {
    this.vdgs.clear();
    this.stopSmoke();
    this.stopRescue();
  }

  /** A bridge command failed: one line in the feed. */
  onCommandResult(r: CommandResult): void {
    if (r.ok) return;
    this.o.feed.system(this.o.now(), 'sim_command_failed', {
      command: r.command,
      error: r.error ?? '',
      detail: r.detail ?? '',
    });
    this.o.onChange();
  }

  private fail(command: 'smoke' | 'rescue', detail: string): void {
    this.o.feed.system(this.o.now(), 'sim_command_failed', { command, error: 'failed', detail });
    this.o.onChange();
  }

  /**
   * Smoke column (T34): the runway's middle comes from OurAirports (cached), moved by the
   * scenario's random offset; the bridge gets plain coordinates. A runway without coordinates,
   * or no network, is one line in the feed.
   */
  private async sendSmoke(c: SmokeCommand): Promise<void> {
    if (c.action === 'stop') {
      this.stopSmoke();
      return;
    }
    // X-Plane takes no smoke command (T18): nothing to say in the feed.
    if ((await this.o.sim()) === 'xplane') return;
    if (c.runway === null) return this.fail('smoke', 'no planned runway in the OFP');
    const mid = await this.o.data.runwayPoint(c.airport, c.runway, this.o.now());
    if (mid === null) return this.fail('smoke', `no coordinates for ${c.airport} RWY ${c.runway}`);
    const p = c.offset ? besideRunway(mid, c.offset.alongNm, c.offset.sideNm) : mid;
    if (!this.o.flying()) return; // the flight ended while the file was fetched
    this.smokeOn = true;
    this.o.bridge.sendCommand('smoke_start', {
      lat: Math.round(p.lat * 1e6) / 1e6,
      lon: Math.round(p.lon * 1e6) / 1e6,
    });
  }

  /** Takes the smoke down; a no-op if none was started. */
  private stopSmoke(): void {
    if (!this.smokeOn) return;
    this.smokeOn = false;
    this.o.bridge.sendCommand('smoke_stop');
  }

  /**
   * Rescue services (T54, game rules of 2026-10-17): the landing runway from OurAirports (planned,
   * else the longest, landing into the METAR wind), fire trucks by the aircraft's category group and models by the airport (large
   * or not, North America or not), the ambulance by region. The bridge gets the whole request each
   * time; it keeps the vehicles that already stand when only the level or the ambulance changes.
   */
  private async sendRescue(c: RescueCommand): Promise<void> {
    const settings = await this.o.settings();
    // X-Plane takes no rescue commands (T18): nothing to say in the feed.
    if (!settings.rescue || activeSim(settings.simChoice, this.o.bridge.view) === 'xplane') return;
    if (c.action === 'stop') {
      this.stopRescue();
      return;
    }
    const prev = this.rescue;
    const rank = (f: 'full' | 'standby' | 'medical' | null) =>
      f === 'full' ? 2 : f === 'standby' ? 1 : 0;
    const asked = c.level === 'medical' ? null : c.level;
    const next = {
      airport: c.airport,
      runway: c.runway,
      windFromDeg: c.windFromDeg,
      fire: rank(asked) >= rank(prev?.fire ?? null) ? asked : (prev?.fire ?? null),
      medic: c.level === 'medical' || (prev?.medic ?? false),
    };
    if (
      prev !== null &&
      prev.airport === next.airport &&
      prev.fire === next.fire &&
      prev.medic === next.medic
    ) {
      return; // a lower level after a higher one, or the same again
    }
    this.rescue = next;
    const seq = ++this.rescueSeq;
    const now = this.o.now();
    const rwy = await this.o.data.landingRunway(next.airport, next.runway, now, next.windFromDeg);
    if (seq !== this.rescueSeq || !this.o.flying()) return; // superseded or flight over
    if (rwy === null) {
      return this.fail(
        'rescue',
        `no runway coordinates for ${next.airport}${next.runway ? ` RWY ${next.runway}` : ''}`,
      );
    }
    const large = next.fire === null ? false : await this.o.data.isLargeAirport(next.airport, now);
    if (seq !== this.rescueSeq || !this.o.flying()) return;
    const t = settings.rescueTitles;
    const fireTitles =
      next.fire === null
        ? []
        : vehicleTitles(
            fireGroup(t, next.airport, large === true),
            fireTruckCount(this.o.aircraftIcao()),
          );
    const medicTitles = next.medic ? vehicleTitles(medicGroup(t, next.airport), 1) : [];
    if (fireTitles.length === 0 && medicTitles.length === 0) {
      return this.fail('rescue', 'no vehicle titles in the settings');
    }
    this.rescueOn = true;
    this.o.bridge.sendCommand('rescue_start', {
      level: next.fire ?? 'medical',
      thrLat: Math.round(rwy.thrLat * 1e6) / 1e6,
      thrLon: Math.round(rwy.thrLon * 1e6) / 1e6,
      hdg: Math.round(rwy.headingDeg * 10) / 10 === 360 ? 0 : Math.round(rwy.headingDeg * 10) / 10,
      lengthM: rwy.lengthM,
      side: upwindSide(rwy.headingDeg, next.windFromDeg),
      fire: fireTitles.join('|'),
      fireFlip: fireFlips(fireTitles, settings.rescueFlipped),
      medic: medicTitles.join('|'),
    });
  }

  /** Takes the rescue vehicles down (alarm over, end of the flight, app exit). */
  private stopRescue(): void {
    this.rescue = null;
    this.rescueSeq++;
    if (!this.rescueOn) return;
    this.rescueOn = false;
    this.o.bridge.sendCommand('rescue_stop');
  }
}

/**
 * A point beside a runway: `alongNm` from its middle in the direction of the runway (negative =
 * back), then `sideNm` off its axis (positive = right of that direction).
 */
function besideRunway(
  mid: { lat: number; lon: number; headingDeg: number },
  alongNm: number,
  sideNm: number,
): { lat: number; lon: number } {
  const move = (p: { lat: number; lon: number }, deg: number, nm: number) =>
    nm === 0 ? p : destinationPoint(p, nm > 0 ? deg : deg + 180, Math.abs(nm));
  return move(move(mid, mid.headingDeg, alongNm), mid.headingDeg + 90, sideNm);
}
