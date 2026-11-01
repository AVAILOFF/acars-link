// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * The one list of components and data the app uses (T74): what the "About" page shows and where the
 * credits on the settings page come from. A test keeps it in step with the tables of
 * `THIRD-PARTY-NOTICES.md` (`notice` is the start of the row's first column), so a source added to
 * one place cannot be missing from the other.
 */

import type { MessageKey } from '../renderer/src/messages-en.js';

/** The two installers (T72): the personal build holds data without a licence for redistribution. */
export type BuildVariant = 'public' | 'personal';

export interface DataSource {
  readonly id: string;
  readonly name: string;
  /** Start of the first column of this source's row in `THIRD-PARTY-NOTICES.md`. */
  readonly notice: string;
  /** `bundled` is inside the installer; `service` is fetched while the app runs. */
  readonly kind: 'bundled' | 'service';
  /** `personal`: not in the public build. */
  readonly build: 'both' | 'personal';
  /** What it is and its licence: UI strings (`messages-<lang>.ts`, `src.<id>.*`, T86). */
  readonly what: MessageKey;
  readonly license: MessageKey;
  /** The credit line the source's terms ask for or require; null = none asked. Shown as written. */
  readonly credit: string | null;
  readonly url?: string;
}

export const SOURCES: readonly DataSource[] = [
  {
    id: 'electron',
    name: 'Electron, Chromium',
    notice: 'Electron, Chromium',
    kind: 'bundled',
    build: 'both',
    what: 'src.electron.what',
    license: 'src.electron.license',
    credit: null,
  },
  {
    id: 'react',
    name: 'React, Zustand, Vite',
    notice: 'React, Zustand, Vite runtime parts',
    kind: 'bundled',
    build: 'both',
    what: 'src.react.what',
    license: 'src.react.license',
    credit: null,
  },
  {
    id: 'dotnet',
    name: '.NET 10, ASP.NET Core',
    notice: '.NET 10 runtime and ASP.NET Core',
    kind: 'bundled',
    build: 'both',
    what: 'src.dotnet.what',
    license: 'src.dotnet.license',
    credit: null,
  },
  {
    id: 'simconnect',
    name: 'SimConnect (MSFS SDK)',
    notice: 'SimConnect client, linked statically',
    kind: 'bundled',
    build: 'both',
    what: 'src.simconnect.what',
    license: 'src.simconnect.license',
    credit: null,
  },
  {
    id: 'openflights',
    name: 'OpenFlights',
    notice: 'OpenFlights `airlines.dat`',
    kind: 'bundled',
    build: 'both',
    what: 'src.openflights.what',
    license: 'src.openflights.license',
    credit: 'OpenFlights.org, ODbL',
    url: 'https://openflights.org/data',
  },
  {
    id: 'eur-cal',
    name: 'EUROCONTROL SSR Code Allocation List',
    notice: 'EUROCONTROL SSR Code Allocation List',
    kind: 'bundled',
    build: 'personal',
    what: 'src.eur-cal.what',
    license: 'src.eur-cal.license',
    credit: null,
  },
  {
    id: 'icao-apac',
    name: 'ICAO APAC eANP',
    notice: 'ICAO APAC eANP Vol II Part IV',
    kind: 'bundled',
    build: 'personal',
    what: 'src.icao-apac.what',
    license: 'src.icao-apac.license',
    credit: null,
  },
  {
    id: 'faa',
    name: 'FAA JO 7110.66H NBCAP',
    notice: 'FAA JO 7110.66H NBCAP tables',
    kind: 'bundled',
    build: 'both',
    what: 'src.faa.what',
    license: 'src.faa.license',
    credit: null,
  },
  {
    id: 'sera',
    name: 'SERA Appendix 3',
    notice: 'SERA Appendix 3',
    kind: 'bundled',
    build: 'both',
    what: 'src.sera.what',
    license: 'src.sera.license',
    credit: null,
  },
  {
    id: 'eclipses',
    name: 'NASA Five Millennium Canon of Solar Eclipses',
    notice: 'NASA Five Millennium Canon of Solar Eclipses',
    kind: 'bundled',
    build: 'both',
    what: 'src.eclipses.what',
    license: 'src.eclipses.license',
    credit: 'F. Espenak and J. Meeus, NASA',
  },
  {
    id: 'tables',
    name: 'Air show and aviation history tables',
    notice: 'Air show and aviation history tables',
    kind: 'bundled',
    build: 'both',
    what: 'src.tables.what',
    license: 'src.tables.license',
    credit: null,
  },
  {
    id: 'hoppie',
    name: "Hoppie's ACARS",
    notice: "Hoppie's ACARS (hoppie.nl)",
    kind: 'service',
    build: 'both',
    what: 'src.hoppie.what',
    license: 'src.hoppie.license',
    credit: null,
  },
  {
    id: 'vatspy',
    name: 'VATSpy Data Project',
    notice: 'VATSpy Data Project',
    kind: 'service',
    build: 'both',
    what: 'src.vatspy.what',
    license: 'src.vatspy.license',
    credit: 'VATSpy Data Project, CC BY-SA 4.0',
    url: 'https://github.com/vatsimnetwork/vatspy-data-project',
  },
  {
    id: 'vatsim',
    name: 'VATSIM data',
    notice: 'VATSIM data',
    kind: 'service',
    build: 'both',
    what: 'src.vatsim.what',
    license: 'src.vatsim.license',
    credit: null,
    url: 'https://vatsim.net/docs/policy/commercial-use',
  },
  {
    id: 'nattrak',
    name: 'natTrak',
    notice: 'natTrak (NAT tracks)',
    kind: 'service',
    build: 'personal',
    what: 'src.nattrak.what',
    license: 'src.nattrak.license',
    credit: null,
  },
  {
    id: 'ourairports',
    name: 'OurAirports',
    notice: 'OurAirports',
    kind: 'service',
    build: 'both',
    what: 'src.ourairports.what',
    license: 'src.ourairports.license',
    credit: null,
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    notice: 'OpenStreetMap via Overpass API',
    kind: 'service',
    build: 'both',
    what: 'src.osm.what',
    license: 'src.osm.license',
    credit: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
  },
  {
    id: 'awc',
    name: 'aviationweather.gov',
    notice: 'aviationweather.gov',
    kind: 'service',
    build: 'both',
    what: 'src.awc.what',
    license: 'src.awc.license',
    credit: null,
  },
  {
    id: 'eonet',
    name: 'NASA EONET',
    notice: 'NASA EONET',
    kind: 'service',
    build: 'both',
    what: 'src.eonet.what',
    license: 'src.eonet.license',
    credit: 'NASA EONET',
    url: 'https://eonet.gsfc.nasa.gov/',
  },
  {
    id: 'swpc',
    name: 'NOAA SWPC',
    notice: 'NOAA SWPC',
    kind: 'service',
    build: 'both',
    what: 'src.swpc.what',
    license: 'src.swpc.license',
    credit: null,
  },
  {
    id: 'usgs',
    name: 'USGS earthquake feed',
    notice: 'USGS earthquake feed',
    kind: 'service',
    build: 'both',
    what: 'src.usgs.what',
    license: 'src.usgs.license',
    credit: 'U.S. Geological Survey',
  },
  {
    id: 'spacedevs',
    name: 'TheSpaceDevs Launch Library 2',
    notice: 'TheSpaceDevs Launch Library 2',
    kind: 'service',
    build: 'both',
    what: 'src.spacedevs.what',
    license: 'src.spacedevs.license',
    credit: 'TheSpaceDevs Launch Library 2',
  },
  {
    id: 'nager',
    name: 'Nager.Date',
    notice: 'Nager.Date public holidays',
    kind: 'service',
    build: 'both',
    what: 'src.nager.what',
    license: 'src.nager.license',
    credit: null,
  },
  {
    id: 'jolpica',
    name: 'Jolpica F1',
    notice: 'Jolpica F1',
    kind: 'service',
    build: 'both',
    what: 'src.jolpica.what',
    license: 'src.jolpica.license',
    credit: null,
  },
  {
    id: 'aerodatabox',
    name: 'AeroDataBox (RapidAPI)',
    notice: 'AeroDataBox via RapidAPI',
    kind: 'service',
    build: 'both',
    what: 'src.aerodatabox.what',
    license: 'src.aerodatabox.license',
    credit: null,
  },
  {
    id: 'simbrief',
    name: 'SimBrief',
    notice: 'SimBrief',
    kind: 'service',
    build: 'both',
    what: 'src.simbrief.what',
    license: 'src.simbrief.license',
    credit: null,
  },
];

/** The sources of one build: the public installer has none of the `personal` ones. */
export function sourcesFor(variant: BuildVariant): readonly DataSource[] {
  return SOURCES.filter((s) => variant === 'personal' || s.build === 'both');
}

/** A source by id; the ids used by the settings page are checked by a test. */
export function sourceById(id: string): DataSource {
  const s = SOURCES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`unknown data source: ${id}`);
  return s;
}
