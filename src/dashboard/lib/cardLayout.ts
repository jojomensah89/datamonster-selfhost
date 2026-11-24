import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { parseCards, type CardPref } from '../../shared/dashboardCards';
import { api } from './api';

interface Entry {
  cards: CardPref[];
  /** The last layout the server confirmed; a failed save goes back to it. */
  saved: CardPref[];
  pending: boolean;
  error: boolean;
  /** When the last save finished. */
  settledAt: number;
}

type Save = (siteId: string, cards: CardPref[], leaving: boolean) => Promise<unknown>;

/**
 * Card layouts changed in this tab. A change shows at once and is saved after a short pause, one request at a time
 * per site, so an older save never lands on top of a newer one. Kept outside the page, so a change made just before
 * leaving it still shows on the way back while its save is running.
 */
export class CardLayouts {
  private entries = new Map<string, Entry>();
  /** Changes waiting to be sent. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Map<string, number>();
  private listeners = new Set<() => void>();

  constructor(
    private save: Save,
    private delay = 400,
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  entry(siteId: string) {
    return this.entries.get(siteId);
  }

  private put(siteId: string, e: Entry) {
    this.entries.set(siteId, e);
    this.listeners.forEach((fn) => fn());
  }

  /** `shown` is the layout on screen before this change. */
  set(siteId: string, cards: CardPref[], shown: CardPref[]) {
    const cur = this.entries.get(siteId);
    this.put(siteId, { cards, saved: cur?.pending ? cur.saved : shown, pending: true, error: false, settledAt: cur?.settledAt ?? 0 });
    clearTimeout(this.timers.get(siteId));
    this.timers.set(siteId, setTimeout(() => this.flush(siteId), this.delay));
  }

  clearError(siteId: string) {
    const cur = this.entries.get(siteId);
    if (cur?.error) this.put(siteId, { ...cur, error: false });
  }

  /** Save a waiting change now. `leaving`: the page is closing, so it cannot wait for the save before it. */
  flush(siteId: string, leaving = false) {
    if (!this.timers.has(siteId)) return;
    clearTimeout(this.timers.get(siteId));
    // Still waiting: sent when the running save finishes.
    if (this.inFlight.get(siteId) && !leaving) return;
    this.timers.delete(siteId);
    void this.send(siteId, leaving);
  }

  private async send(siteId: string, leaving: boolean) {
    const sent = this.entries.get(siteId)!.cards;
    this.inFlight.set(siteId, (this.inFlight.get(siteId) ?? 0) + 1);
    let ok = true;
    try {
      await this.save(siteId, sent, leaving);
    } catch {
      ok = false;
    }
    this.inFlight.set(siteId, this.inFlight.get(siteId)! - 1);
    const cur = this.entries.get(siteId)!;
    if (cur.cards !== sent) {
      // Changed again meanwhile: the newer layout decides what is shown.
      if (ok) this.put(siteId, { ...cur, saved: sent });
      this.flush(siteId);
      return;
    }
    const cards = ok ? sent : cur.saved;
    this.put(siteId, { cards, saved: cards, pending: false, error: !ok, settledAt: Date.now() });
  }
}

export const cardLayouts = new CardLayouts((siteId, cards, leaving) =>
  api(`/api/sites/${siteId}`, { method: 'PATCH', json: { dashboard_cards: cards }, keepalive: leaving }),
);

/** The site's cards: what was changed in this tab, else what the server has. */
export function useCardLayout(siteId: string, saved: CardPref[] | null | undefined, store = cardLayouts) {
  // Sites are fetched when the page opens, so a save that finished after that is newer than the fetched layout.
  const openedAt = useRef(Date.now());
  const entry = useSyncExternalStore(store.subscribe, () => store.entry(siteId));
  const fetched = useMemo(() => parseCards(saved), [saved]);
  const local = entry && (entry.pending || entry.settledAt >= openedAt.current) ? entry : null;
  const cards = local?.cards ?? fetched;

  useEffect(() => {
    const leave = () => store.flush(siteId, true);
    const hide = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hide);
      store.flush(siteId);
    };
  }, [siteId, store]);

  return {
    cards,
    error: !!local?.error,
    setCards: useCallback((next: CardPref[]) => store.set(siteId, next, cards), [siteId, cards, store]),
    flush: useCallback(() => store.flush(siteId), [siteId, store]),
    clearError: useCallback(() => store.clearError(siteId), [siteId, store]),
  };
}
