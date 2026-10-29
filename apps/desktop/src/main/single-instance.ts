// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * One app instance (T66): a second start (shortcut, `ACARS Link.bat`) would open a second Hoppie
 * transport with the same logon code (double polling, invariant 6), a second recording of the flight
 * and a second bridge on a taken port. The second process quits before any of that; the first one
 * brings its window to the front.
 */

/** The part of Electron's `app` used here. */
export interface InstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
  quit(): void;
}

/** The part of `BrowserWindow` used here. */
export interface WindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Shows, restores and focuses the window; false when there is none (yet, or any more). */
export function bringToFront(win: WindowLike | null): boolean {
  if (win === null || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

/**
 * Takes the single-instance lock. Without it: quits and returns false, and the caller must stop at
 * once (no network, no bridge, no window). With it: every later start brings `window()` to the front.
 */
export function holdSingleInstance(app: InstanceApp, window: () => WindowLike | null): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    bringToFront(window());
  });
  return true;
}
