import type { AcarsApi } from '../../shared/api.js';

declare global {
  interface Window {
    /** Exposed by the preload script (src/preload/index.ts). */
    readonly acars: AcarsApi;
  }
}
