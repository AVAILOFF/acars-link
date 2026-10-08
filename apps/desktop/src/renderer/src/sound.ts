import { useEffect, useRef } from 'react';
import messageSound from './assets/message.mp3';
import { useStore } from './store.js';

/**
 * Sound on a new airline message (setting "Sound on new message", off by default). Plays once
 * per state update that brings new outbound telexes, however many; entries already in the feed
 * when the window opens make no sound. Only the presentation: no business logic here.
 */
export function useMessageSound(): void {
  const enabled = useStore((s) => s.settings?.soundOnMessage === true);
  const feed = useStore((s) => s.app?.feed);
  const seen = useRef<Set<string> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (feed === undefined) return;
    const ids = feed.filter((e) => e.kind === 'outbound').map((e) => e.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !(seen.current as Set<string>).has(id));
    for (const id of fresh) seen.current.add(id);
    if (fresh.length > 0 && enabled) playMessageSound(audio);
  }, [feed, enabled]);
}

/** Plays the message sound (also the "test" button in Settings). */
export function playMessageSound(ref?: { current: HTMLAudioElement | null }): void {
  const holder = ref ?? { current: null };
  holder.current ??= new Audio(messageSound);
  const a = holder.current;
  a.currentTime = 0;
  // Autoplay may be refused (no user gesture yet): a missed sound is fine.
  void a.play().catch(() => {});
}
