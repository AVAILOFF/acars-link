// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { describe, expect, it } from 'vitest';
import { bringToFront, holdSingleInstance, type WindowLike } from '../src/main/single-instance.js';

class FakeApp {
  quits = 0;
  readonly listeners: (() => void)[] = [];
  constructor(private readonly lock: boolean) {}
  requestSingleInstanceLock() {
    return this.lock;
  }
  on(_event: 'second-instance', listener: () => void) {
    this.listeners.push(listener);
  }
  quit() {
    this.quits++;
  }
  secondStart() {
    for (const l of this.listeners) l();
  }
}

class FakeWindow implements WindowLike {
  readonly calls: string[] = [];
  constructor(
    public minimized = false,
    public visible = true,
    public destroyed = false,
  ) {}
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  isVisible() {
    return this.visible;
  }
  restore() {
    this.calls.push('restore');
    this.minimized = false;
  }
  show() {
    this.calls.push('show');
    this.visible = true;
  }
  focus() {
    this.calls.push('focus');
  }
}

describe('single instance (T66)', () => {
  it('without the lock: quits at once and tells the caller to stop', () => {
    const app = new FakeApp(false);
    expect(holdSingleInstance(app, () => null)).toBe(false);
    expect(app.quits).toBe(1);
    expect(app.listeners).toHaveLength(0);
  });

  it('with the lock: goes on; a second start brings the window to the front', () => {
    const app = new FakeApp(true);
    const win = new FakeWindow(true, true);
    expect(holdSingleInstance(app, () => win)).toBe(true);
    expect(app.quits).toBe(0);
    app.secondStart();
    expect(win.calls).toEqual(['restore', 'focus']);
  });

  it('a second start before the window exists or after it closed does nothing', () => {
    const app = new FakeApp(true);
    let win: FakeWindow | null = null;
    holdSingleInstance(app, () => win);
    app.secondStart();
    win = new FakeWindow(false, true, true);
    app.secondStart();
    expect(win.calls).toEqual([]);
    expect(app.quits).toBe(0);
  });

  it('bringToFront: shows a hidden window, focuses a plain one', () => {
    const hidden = new FakeWindow(false, false);
    expect(bringToFront(hidden)).toBe(true);
    expect(hidden.calls).toEqual(['show', 'focus']);
    const plain = new FakeWindow();
    bringToFront(plain);
    expect(plain.calls).toEqual(['focus']);
    expect(bringToFront(null)).toBe(false);
  });
});
