import { describe, expect, it } from 'vitest';
import { AIRCRAFT_FAMILIES } from '../src/scenario/aircraft.js';
import { checkSimCommand, SIM_COMMANDS } from '../src/sim/commands.js';
import {
  DEFAULT_RESCUE_FLIPPED,
  DEFAULT_RESCUE_TITLES,
  FIRE_TRUCKS,
  fireFlips,
  fireGroup,
  fireTruckCount,
  medicGroup,
  RESCUE_CATEGORY,
  rescueCategory,
  rescueRegion,
  upwindSide,
  vehicleTitles,
} from '../src/sim/rescue.js';

/** T54: the user's game rules for the rescue vehicles (decisions of 2026-10-17). */

describe('rescue vehicles (T54)', () => {
  it('category groups and truck counts: 1–5 → 1, 6–7 → 4, 8–10 → 8', () => {
    expect(FIRE_TRUCKS).toEqual({ '1-5': 1, '6-7': 4, '8-10': 8 });
    expect(Object.keys(RESCUE_CATEGORY).sort()).toEqual([...AIRCRAFT_FAMILIES].sort());
    expect(fireTruckCount('A320')).toBe(4);
    expect(fireTruckCount('A21N')).toBe(4);
    expect(fireTruckCount('B38M')).toBe(4);
    expect(fireTruckCount('B752')).toBe(4); // narrow-body jet (T60)
    for (const t of ['A332', 'A359', 'A388', 'B744', 'B77W', 'B789'])
      expect(fireTruckCount(t)).toBe(8);
    for (const t of ['E170', 'E75L', 'CRJ9', 'AT76', 'DH8C']) expect(fireTruckCount(t)).toBe(1);
    for (const t of ['E190', 'E195', 'DH8D', 'e190']) expect(fireTruckCount(t)).toBe(4);
    expect(rescueCategory('C172')).toBe('1-5'); // not in the T40 table
    expect(fireTruckCount(null)).toBe(1);
  });

  it('region by the first letters of the ICAO code', () => {
    expect(rescueRegion('KJFK')).toBe('NA');
    expect(rescueRegion('CYYZ')).toBe('NA');
    expect(rescueRegion('RJTT')).toBe('JAPAN');
    expect(rescueRegion('ROAH')).toBe('JAPAN');
    expect(rescueRegion('RKSI')).toBe('ASIA');
    expect(rescueRegion('VHHH')).toBe('ASIA');
    expect(rescueRegion('WSSS')).toBe('ASIA');
    expect(rescueRegion('ZBAA')).toBe('ASIA');
    expect(rescueRegion('EDDF')).toBe('OTHER');
    expect(rescueRegion('LEBL')).toBe('OTHER');
    expect(rescueRegion('PHNL')).toBe('OTHER'); // only K and C count as North America
    expect(rescueRegion('SBGR')).toBe('OTHER');
  });

  it('fire truck models by airport size and region', () => {
    const t = DEFAULT_RESCUE_TITLES;
    expect(fireGroup(t, 'KJFK', true)).toEqual(['Truck Fire Airport Medium']);
    expect(fireGroup(t, 'EDDF', true)).toEqual(['ASO_Firetruck02', 'Truck Fire Airport Medium']);
    expect(fireGroup(t, 'KBVY', false)).toEqual([
      'Truck Fire Long 02',
      'Microsoft_Truck_Fire_Long',
    ]);
    expect(fireGroup(t, 'LOWI', false)).toEqual(['Truck Fire Short']);
    expect(Object.values(t).flat()).not.toContain('FSDT_Firetruck_Panther_6x6_red');
  });

  it('ambulance models by region', () => {
    const t = DEFAULT_RESCUE_TITLES;
    expect(medicGroup(t, 'RJBB')).toEqual(['Van Asia High Roof Medic Japan']);
    expect(medicGroup(t, 'RCTP')).toEqual(['Van Asia High Roof Medic', 'Van Asia Low Roof Medic']);
    expect(medicGroup(t, 'KLAX')).toEqual(['Truck Utility NorthAm Medic']);
    expect(medicGroup(t, 'EGLL')).toEqual([
      'Truck Utility Europe Medic Box',
      'Truck Utility Europe Medic Flush',
    ]);
    expect(medicGroup(t, 'FAOR')).toEqual(medicGroup(t, 'EGLL'));
  });

  it('trucks wait upwind: the side the METAR wind comes from, right without wind', () => {
    // Runway 24 (240°): wind from 300 is from the right, from 180 from the left.
    expect(upwindSide(240, 300)).toBe('right');
    expect(upwindSide(240, 180)).toBe('left');
    expect(upwindSide(60, 300)).toBe('left'); // the other direction of the same runway
    expect(upwindSide(240, 240)).toBe('right'); // straight along: right
    expect(upwindSide(240, null)).toBe('right'); // calm, variable or no METAR
  });

  it('fewer models than vehicles: they take turns; at most 8; empty group → none', () => {
    expect(vehicleTitles(['A', 'B'], 4)).toEqual(['A', 'B', 'A', 'B']);
    expect(vehicleTitles(['A', 'B', 'C'], 1)).toEqual(['A']);
    expect(vehicleTitles(['A'], 20)).toHaveLength(8);
    expect(vehicleTitles([' ', ''], 4)).toEqual([]);
    expect(vehicleTitles([' A '], 1)).toEqual(['A']);
  });

  it('rescue_start / rescue_stop are checked like the bridge does', () => {
    expect(SIM_COMMANDS).toContain('rescue_start');
    expect(SIM_COMMANDS).toContain('rescue_stop');
    const ok = {
      level: 'full',
      thrLat: 50.04,
      thrLon: 8.59,
      hdg: 250,
      lengthM: 4000,
      side: 'right',
      fire: 'ASO_Firetruck02|Truck Fire Short',
      fireFlip: '0|0',
      medic: '',
    };
    expect(checkSimCommand('rescue_start', ok)).toBeNull();
    expect(
      checkSimCommand('rescue_start', {
        ...ok,
        level: 'medical',
        fire: '',
        fireFlip: '',
        medic: 'Car Bush Medic',
      }),
    ).toBeNull();
    expect(checkSimCommand('rescue_start', { ...ok, level: 'huge' })).toMatch(/level/);
    expect(checkSimCommand('rescue_start', { ...ok, thrLat: 91 })).toMatch(/thrLat/);
    expect(checkSimCommand('rescue_start', { ...ok, hdg: 360 })).toMatch(/hdg/);
    expect(checkSimCommand('rescue_start', { ...ok, lengthM: 0 })).toMatch(/lengthM/);
    expect(checkSimCommand('rescue_start', { ...ok, fire: 'A||B' })).toMatch(/empty title/);
    expect(checkSimCommand('rescue_start', { ...ok, fire: 'a|b|c|d|e|f|g|h|i' })).toMatch(
      /at most 8/,
    );
    expect(checkSimCommand('rescue_start', { ...ok, level: 'medical' })).toMatch(/no fire/);
    expect(checkSimCommand('rescue_start', { ...ok, side: 'up' })).toMatch(/side/);
    expect(checkSimCommand('rescue_start', { ...ok, fireFlip: '0' })).toMatch(/fireFlip/);
    expect(checkSimCommand('rescue_start', { ...ok, fireFlip: '0|2' })).toMatch(/fireFlip/);
    expect(
      fireFlips(['ASO_Firetruck02', 'Truck Fire Airport Medium'], DEFAULT_RESCUE_FLIPPED),
    ).toBe('0|1');
    expect(fireFlips([], DEFAULT_RESCUE_FLIPPED)).toBe('');
    expect(checkSimCommand('rescue_start', { level: 'full' })).toMatch(/only/);
    expect(checkSimCommand('rescue_stop', {})).toBeNull();
    expect(checkSimCommand('rescue_stop', { x: 1 })).toMatch(/no arguments/);
  });
});
