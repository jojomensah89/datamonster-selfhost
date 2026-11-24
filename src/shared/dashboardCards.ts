/** The Overview cards people can hide and reorder. The five numbers and the chart above them always stay. */
export const CARDS = [
  { id: 'sources', label: 'Revenue by source' },
  { id: 'launches', label: 'Launches' },
  { id: 'live', label: 'Live now' },
  { id: 'locations', label: 'Locations' },
  { id: 'channels', label: 'Channels and campaigns' },
  { id: 'pages', label: 'Pages' },
  { id: 'devices', label: 'Browsers and devices' },
  { id: 'goals', label: 'Goals and journeys' },
] as const;

export type CardId = (typeof CARDS)[number]['id'];
export interface CardPref {
  id: CardId;
  on: boolean;
}

export const DEFAULT_CARDS: readonly CardPref[] = CARDS.map((c) => ({ id: c.id, on: true }));

const known = (id: string): id is CardId => CARDS.some((c) => c.id === id);

/**
 * A layout anyone sent or stored, made safe to use. Unknown and repeated ids are dropped; cards it does not mention
 * (added since it was saved) go last, switched on. Anything that is not a list of {id, on} is the default.
 */
export function parseCards(input: unknown): CardPref[] {
  const fallback = () => DEFAULT_CARDS.map((c) => ({ ...c }));
  if (!Array.isArray(input)) return fallback();
  const out: CardPref[] = [];
  for (const c of input) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.on !== 'boolean') return fallback();
    if (known(c.id) && !out.some((o) => o.id === c.id)) out.push({ id: c.id, on: c.on });
  }
  return [...out, ...fallback().filter((c) => !out.some((o) => o.id === c.id))];
}

export const isDefaultCards = (cards: readonly CardPref[]) =>
  cards.length === DEFAULT_CARDS.length && cards.every((c, i) => c.id === DEFAULT_CARDS[i].id && c.on === DEFAULT_CARDS[i].on);

/** What the sites table stores: JSON, or NULL for the default. */
export function storeCards(input: unknown): string | null {
  const cards = parseCards(input);
  return isDefaultCards(cards) ? null : JSON.stringify(cards);
}

/** What the API returns for a stored value: the layout, or null for the default. */
export function readCards(stored: string | null | undefined): CardPref[] | null {
  if (!stored) return null;
  try {
    const cards = parseCards(JSON.parse(stored));
    return isDefaultCards(cards) ? null : cards;
  } catch {
    return null;
  }
}
