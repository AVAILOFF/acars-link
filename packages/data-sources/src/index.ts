/**
 * @acars/data-sources — external data adapters (T13, docs/06 "Внешние данные"): METAR/TAF
 * (aviationweather.gov), VATSIM ATC, NASA EONET, OSM stands (Overpass), space launches
 * (TheSpaceDevs Launch Library, T28), special events (T29: NOAA SWPC, SIGMET VA, USGS,
 * Nager.Date, Jolpica F1, NHL). HTTP through the
 * injected `HttpClient`, results as the core's `ExtDataUpdate`. No keys: free APIs only
 * (docs/08, decision 4).
 */
export const DATA_SOURCES_PACKAGE = '@acars/data-sources';

export * from './common.js';
export * from './eonet.js';
export * from './holidays.js';
export * from './launches.js';
export * from './nattrak.js';
export * from './ourairports.js';
export * from './quakes.js';
export * from './service.js';
export * from './sigmet.js';
export * from './spacewx.js';
export * from './sport.js';
export * from './stands.js';
export * from './vatsim.js';
export * from './vatspy.js';
export * from './wx.js';
