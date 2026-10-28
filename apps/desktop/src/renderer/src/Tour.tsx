// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from './store.js';
import { useT } from './ui.js';
import { type Box, placeCard, TOUR_STOPS } from './welcome.js';

/**
 * The interface tour (T70): dims the window except one element (`data-tour`) and explains it in a
 * card next to it. A modal <dialog>: the app behind is inert, Esc closes. Positions follow the
 * window size; no timers (invariant 5).
 */
export function Tour() {
  const t = useT();
  const stop = useStore((s) => s.tour) ?? 0;
  const setTour = useStore((s) => s.setTour);
  const ref = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const name = TOUR_STOPS[stop] ?? 'rail';
  const last = stop === TOUR_STOPS.length - 1;

  useEffect(() => {
    const d = ref.current;
    if (d !== null && !d.open) d.showModal();
  }, []);

  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector(`[data-tour="${name}"]`);
      const c = card.current;
      const view = { w: window.innerWidth, h: window.innerHeight };
      const size = c === null ? { w: 320, h: 180 } : { w: c.offsetWidth, h: c.offsetHeight };
      if (el === null) {
        setSpot(null);
        setPos({ x: (view.w - size.w) / 2, y: (view.h - size.h) / 2 });
        return;
      }
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      const box = { x: r.left, y: r.top, w: r.width, h: r.height };
      setSpot(box);
      setPos(placeCard(box, size, view));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [name]);

  const go = (n: number | null) => setTour(n);

  return (
    <dialog
      ref={ref}
      className="tour"
      aria-labelledby="tour-title"
      aria-describedby="tour-text"
      onCancel={(e) => {
        e.preventDefault();
        go(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && !last) go(stop + 1);
        if (e.key === 'ArrowLeft' && stop > 0) go(stop - 1);
      }}
    >
      {spot === null ? (
        <div className="tour-dim" />
      ) : (
        <div
          className="tour-spot"
          style={{ left: spot.x - 4, top: spot.y - 4, width: spot.w + 8, height: spot.h + 8 }}
        />
      )}
      <div
        ref={card}
        className="modal-sheet tour-card"
        style={pos === null ? { visibility: 'hidden' } : { left: pos.x, top: pos.y }}
      >
        <header className="tour-head">
          <h2 id="tour-title">{t(`tour.${name}.title`)}</h2>
          <button
            type="button"
            className="btn-round light"
            aria-label={t('tour.close')}
            title={t('tour.close')}
            onClick={() => go(null)}
          >
            ✕
          </button>
        </header>
        <p id="tour-text" className="tour-text">
          {t(`tour.${name}.text`)}
        </p>
        <footer className="tour-foot">
          <span className="tour-count">
            {t('welcome.step', { n: stop + 1, of: TOUR_STOPS.length })}
          </span>
          {stop > 0 && (
            <button type="button" className="btn" onClick={() => go(stop - 1)}>
              {t('welcome.back')}
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => go(last ? null : stop + 1)}>
            {t(last ? 'tour.finish' : 'welcome.next')}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
