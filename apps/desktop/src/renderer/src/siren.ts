import { useEffect } from 'react';
import { useStore } from './store.js';

/**
 * Rescue siren on the PC speakers (T54, setting "Siren", off by default): a wail made with Web
 * Audio — a tone sweeping up and down — so no sound file and no licence. It sounds while the main
 * process says so (`AppState.siren`: a `full` landing from touchdown until the aircraft stops).
 * Only the presentation: when to sound is decided in the main process.
 */

/** Wail: from LOW_HZ to HIGH_HZ and back every PERIOD_S seconds. */
const LOW_HZ = 650;
const HIGH_HZ = 1350;
const PERIOD_S = 4;
const VOLUME = 0.06;

interface Wail {
  stop(): void;
}

function startWail(): Wail | null {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return null; // no audio device: a missed sound is fine
  }
  const tone = ctx.createOscillator();
  tone.type = 'sawtooth';
  tone.frequency.value = (LOW_HZ + HIGH_HZ) / 2;
  const sweep = ctx.createOscillator();
  sweep.type = 'triangle';
  sweep.frequency.value = 1 / PERIOD_S;
  const depth = ctx.createGain();
  depth.gain.value = (HIGH_HZ - LOW_HZ) / 2;
  sweep.connect(depth).connect(tone.frequency);
  const gain = ctx.createGain();
  gain.gain.value = VOLUME;
  tone.connect(gain).connect(ctx.destination);
  tone.start();
  sweep.start();
  return {
    stop() {
      void ctx.close().catch(() => {});
    },
  };
}

export function useSiren(): void {
  const on = useStore((s) => s.app?.siren === true);
  useEffect(() => {
    if (!on) return;
    const w = startWail();
    return () => w?.stop();
  }, [on]);
}

/** The "test" button in Settings: a few seconds of the siren. */
export function testSiren(seconds = 3): void {
  const w = startWail();
  if (w !== null) setTimeout(() => w.stop(), seconds * 1000);
}
