// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * The one list of components and data the app uses (T74): what the "About" page shows and where the
 * credits on the settings page come from. A test keeps it in step with the tables of
 * `THIRD-PARTY-NOTICES.md` (`notice` is the start of the row's first column), so a source added to
 * one place cannot be missing from the other.
 */

import type { UiText } from './api.js';

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
  readonly what: UiText;
  readonly license: UiText;
  /** The credit line the source's terms ask for or require; null = none asked. Shown as written. */
  readonly credit: string | null;
  readonly url?: string;
}

/** T85: a language missing here is shown in English. */
const t = (en: string, ru: string): UiText => ({ en, ru });

export const SOURCES: readonly DataSource[] = [
  {
    id: 'electron',
    name: 'Electron, Chromium',
    notice: 'Electron, Chromium',
    kind: 'bundled',
    build: 'both',
    what: t('Application shell', 'Оболочка приложения'),
    license: t('MIT and the Chromium licences', 'MIT и лицензии Chromium'),
    credit: null,
  },
  {
    id: 'react',
    name: 'React, Zustand, Vite',
    notice: 'React, Zustand, Vite runtime parts',
    kind: 'bundled',
    build: 'both',
    what: t('Interface libraries', 'Библиотеки интерфейса'),
    license: t('MIT', 'MIT'),
    credit: null,
  },
  {
    id: 'dotnet',
    name: '.NET 10, ASP.NET Core',
    notice: '.NET 10 runtime and ASP.NET Core',
    kind: 'bundled',
    build: 'both',
    what: t('Runtime of the simulator bridge', 'Среда выполнения моста к симулятору'),
    license: t('MIT (Microsoft)', 'MIT (Microsoft)'),
    credit: null,
  },
  {
    id: 'simconnect',
    name: 'SimConnect (MSFS SDK)',
    notice: 'SimConnect client, linked statically',
    kind: 'bundled',
    build: 'both',
    what: t(
      'Link to Microsoft Flight Simulator, built into the bridge',
      'Связь с Microsoft Flight Simulator, встроена в мост',
    ),
    license: t('Microsoft MSFS SDK licence', 'Лицензия Microsoft MSFS SDK'),
    credit: null,
  },
  {
    id: 'openflights',
    name: 'OpenFlights',
    notice: 'OpenFlights `airlines.dat`',
    kind: 'bundled',
    build: 'both',
    what: t(
      'Airlines, airports, routes and aircraft types (the next leg, hubs)',
      'Авиакомпании, аэропорты, маршруты и типы самолётов (следующий рейс, хабы)',
    ),
    license: t('ODbL 1.0, Database Contents License', 'ODbL 1.0, Database Contents License'),
    credit: 'OpenFlights.org, ODbL',
    url: 'https://openflights.org/data',
  },
  {
    id: 'eur-cal',
    name: 'EUROCONTROL SSR Code Allocation List',
    notice: 'EUROCONTROL SSR Code Allocation List',
    kind: 'bundled',
    build: 'personal',
    what: t('Squawk codes in Europe', 'Коды транспондера в Европе'),
    license: t('© EUROCONTROL', '© EUROCONTROL'),
    credit: null,
  },
  {
    id: 'icao-apac',
    name: 'ICAO APAC eANP',
    notice: 'ICAO APAC eANP Vol II Part IV',
    kind: 'bundled',
    build: 'personal',
    what: t('Squawk codes in Asia and the Pacific', 'Коды транспондера в Азии и Тихом океане'),
    license: t('© ICAO, all rights reserved', '© ICAO, все права защищены'),
    credit: null,
  },
  {
    id: 'faa',
    name: 'FAA JO 7110.66H NBCAP',
    notice: 'FAA JO 7110.66H NBCAP tables',
    kind: 'bundled',
    build: 'both',
    what: t('Squawk codes in the USA', 'Коды транспондера в США'),
    license: t('Public domain', 'Общественное достояние'),
    credit: null,
  },
  {
    id: 'sera',
    name: 'SERA Appendix 3',
    notice: 'SERA Appendix 3',
    kind: 'bundled',
    build: 'both',
    what: t('Table of flight levels', 'Таблица эшелонов'),
    license: t('Regulation (EU) 923/2012, EUR-Lex', 'Регламент (ЕС) 923/2012, EUR-Lex'),
    credit: null,
  },
  {
    id: 'eclipses',
    name: 'NASA Five Millennium Canon of Solar Eclipses',
    notice: 'NASA Five Millennium Canon of Solar Eclipses',
    kind: 'bundled',
    build: 'both',
    what: t('Solar eclipses', 'Солнечные затмения'),
    license: t('NASA, reproduction with credit', 'NASA, воспроизведение с указанием источника'),
    credit: 'F. Espenak and J. Meeus, NASA',
  },
  {
    id: 'tables',
    name: 'Air show and aviation history tables',
    notice: 'Air show and aviation history tables',
    kind: 'bundled',
    build: 'both',
    what: t('Air shows and aviation history facts', 'Авиашоу и факты из истории авиации'),
    license: t(
      'Source and date of verification in each entry',
      'Источник и дата сверки у каждой записи',
    ),
    credit: null,
  },
  {
    id: 'hoppie',
    name: "Hoppie's ACARS",
    notice: "Hoppie's ACARS (hoppie.nl)",
    kind: 'service',
    build: 'both',
    what: t(
      'The ACARS network the messages go through',
      'Сеть ACARS, через которую идут сообщения',
    ),
    license: t(
      'No published terms for third-party clients',
      'Условия для сторонних программ не опубликованы',
    ),
    credit: null,
  },
  {
    id: 'vatspy',
    name: 'VATSpy Data Project',
    notice: 'VATSpy Data Project',
    kind: 'service',
    build: 'both',
    what: t('FIR boundaries and VATSIM centres', 'Границы FIR и центры VATSIM'),
    license: t('CC BY-SA 4.0', 'CC BY-SA 4.0'),
    credit: 'VATSpy Data Project, CC BY-SA 4.0',
    url: 'https://github.com/vatsimnetwork/vatspy-data-project',
  },
  {
    id: 'vatsim',
    name: 'VATSIM data',
    notice: 'VATSIM data',
    kind: 'service',
    build: 'both',
    what: t('Controllers online on VATSIM', 'Диспетчеры на VATSIM'),
    license: t(
      'Free non-commercial use (VATSIM Commercial Use Policy v2.0)',
      'Бесплатное некоммерческое использование (VATSIM Commercial Use Policy v2.0)',
    ),
    credit: null,
    url: 'https://vatsim.net/docs/policy/commercial-use',
  },
  {
    id: 'nattrak',
    name: 'natTrak',
    notice: 'natTrak (NAT tracks)',
    kind: 'service',
    build: 'personal',
    what: t('North Atlantic tracks', 'Североатлантические треки'),
    license: t('No published terms', 'Условия не опубликованы'),
    credit: null,
  },
  {
    id: 'ourairports',
    name: 'OurAirports',
    notice: 'OurAirports',
    kind: 'service',
    build: 'both',
    what: t('Airports, runways and frequencies', 'Аэропорты, ВПП и частоты'),
    license: t('Public domain', 'Общественное достояние'),
    credit: null,
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    notice: 'OpenStreetMap via Overpass API',
    kind: 'service',
    build: 'both',
    what: t('Gates and stands at airports', 'Гейты и стоянки в аэропортах'),
    license: t('ODbL', 'ODbL'),
    credit: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
  },
  {
    id: 'awc',
    name: 'aviationweather.gov',
    notice: 'aviationweather.gov',
    kind: 'service',
    build: 'both',
    what: t('METAR, TAF and SIGMET', 'METAR, TAF и SIGMET'),
    license: t('US government data', 'Данные правительства США'),
    credit: null,
  },
  {
    id: 'eonet',
    name: 'NASA EONET',
    notice: 'NASA EONET',
    kind: 'service',
    build: 'both',
    what: t('Natural events near the route', 'Природные события у маршрута'),
    license: t(
      'NASA open data (CC0); for general information only',
      'Открытые данные NASA (CC0); только для общей информации',
    ),
    credit: 'NASA EONET',
    url: 'https://eonet.gsfc.nasa.gov/',
  },
  {
    id: 'swpc',
    name: 'NOAA SWPC',
    notice: 'NOAA SWPC',
    kind: 'service',
    build: 'both',
    what: t('Space weather', 'Космическая погода'),
    license: t(
      'US government data, public domain; not endorsed by NOAA',
      'Данные правительства США, общественное достояние; NOAA их не одобряет',
    ),
    credit: null,
  },
  {
    id: 'usgs',
    name: 'USGS earthquake feed',
    notice: 'USGS earthquake feed',
    kind: 'service',
    build: 'both',
    what: t('Earthquakes at the destination', 'Землетрясения в пункте назначения'),
    license: t(
      'Public domain; credit requested',
      'Общественное достояние; просят указывать источник',
    ),
    credit: 'U.S. Geological Survey',
  },
  {
    id: 'spacedevs',
    name: 'TheSpaceDevs Launch Library 2',
    notice: 'TheSpaceDevs Launch Library 2',
    kind: 'service',
    build: 'both',
    what: t('Rocket launches', 'Пуски ракет'),
    license: t(
      'Free to use; credit optional',
      'Свободное использование; указание источника по желанию',
    ),
    credit: 'TheSpaceDevs Launch Library 2',
  },
  {
    id: 'nager',
    name: 'Nager.Date',
    notice: 'Nager.Date public holidays',
    kind: 'service',
    build: 'both',
    what: t('Public holidays', 'Государственные праздники'),
    license: t('Non-commercial use', 'Только некоммерческое использование'),
    credit: null,
  },
  {
    id: 'jolpica',
    name: 'Jolpica F1',
    notice: 'Jolpica F1',
    kind: 'service',
    build: 'both',
    what: t('Formula 1 results', 'Результаты Формулы-1'),
    license: t('CC BY-NC-SA 4.0', 'CC BY-NC-SA 4.0'),
    credit: null,
  },
  {
    id: 'aerodatabox',
    name: 'AeroDataBox (RapidAPI)',
    notice: 'AeroDataBox via RapidAPI',
    kind: 'service',
    build: 'both',
    what: t(
      'Connecting flights and routes, with your key',
      'Стыковочные рейсы и маршруты, по вашему ключу',
    ),
    license: t('Terms of your RapidAPI plan', 'Условия вашего тарифа RapidAPI'),
    credit: null,
  },
  {
    id: 'simbrief',
    name: 'SimBrief',
    notice: 'SimBrief',
    kind: 'service',
    build: 'both',
    what: t('Your flight plans (OFP)', 'Ваши планы полёта (OFP)'),
    license: t('Terms of SimBrief', 'Условия SimBrief'),
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
