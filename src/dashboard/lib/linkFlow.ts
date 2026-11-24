import { byRevenue, count, nameOf, type SavedLink } from './links';

/**
 * The flow at the top of the Links page: one ribbon per link, as thick on the left as its share of visitors and on the
 * right as its share of revenue. Both sides use one scale, so a ribbon that widens earns more than its share of visits.
 */
export interface FlowItem {
  /** The link's id, or OTHER for the rest together. */
  id: string;
  name: string;
  /** Null for the rest together. */
  link: SavedLink | null;
  visitors: number;
  customers: number;
  /** As recorded: negative when refunds outweigh payments. */
  revenue: number;
  /** 0 to 1. Refunds cannot make a share negative. */
  visitorShare: number;
  revenueShare: number;
}

export const OTHER = 'other';
export const FLOW_TOP = 7;

const earned = (l: SavedLink) => Math.max(0, l.revenue);
const sum = (links: SavedLink[], of: (l: SavedLink) => number) => links.reduce((a, l) => a + of(l), 0);

/**
 * The ribbons, top to bottom: up to 7 links, the rest in one "Other". Empty when there is nothing to compare: fewer
 * than two active links with visits, or no revenue.
 */
export function flowItems(links: SavedLink[]): FlowItem[] {
  const active = links.filter((l) => !l.archived_at);
  if (active.filter((l) => l.visitors > 0).length < 2 || sum(active, (l) => l.revenue) <= 0) return [];
  const drawn = active.filter((l) => l.visitors > 0 || l.revenue > 0);
  const visitors = sum(drawn, (l) => l.visitors);
  const revenue = sum(drawn, earned);

  // Whichever share is larger makes a link worth showing, so traffic that never pays is not hidden by small sales.
  const weight = (l: SavedLink) => Math.max(l.visitors / visitors, earned(l) / revenue);
  const ranked = [...drawn].sort((a, b) => weight(b) - weight(a) || byRevenue(a, b));
  // "Other" standing for a single link would say less than its name in the same space.
  const top = ranked.slice(0, ranked.length === FLOW_TOP + 1 ? FLOW_TOP + 1 : FLOW_TOP);
  // Both kinds are always represented.
  for (const kind of [(l: SavedLink) => l.revenue > 0, (l: SavedLink) => l.revenue <= 0]) {
    const best = ranked.find(kind);
    if (best && !top.some(kind)) top[top.length - 1] = best;
  }
  const shown = new Set(top);
  const rest = drawn.filter((l) => !shown.has(l));

  const item = (id: string, name: string, link: SavedLink | null, of: SavedLink[]): FlowItem => ({
    id,
    name,
    link,
    visitors: sum(of, (l) => l.visitors),
    customers: sum(of, (l) => l.customers),
    revenue: sum(of, (l) => l.revenue),
    visitorShare: sum(of, (l) => l.visitors) / visitors,
    revenueShare: sum(of, earned) / revenue,
  });
  const one = (l: SavedLink) => item(l.id, nameOf(l), l, [l]);
  const paying = top.filter((l) => l.revenue > 0).sort(byRevenue);
  const unpaid = top.filter((l) => l.revenue <= 0).sort((a, b) => b.visitors - a.visitors || byRevenue(a, b));
  const other = rest.length ? [item(OTHER, `Other (${count(rest.length, 'link')})`, null, rest)] : [];
  const otherPays = other.length > 0 && other[0].revenueShare > 0;
  return [...paying.map(one), ...(otherPays ? other : []), ...unpaid.map(one), ...(otherPays ? [] : other)];
}

/** One end of a ribbon, in px from the top of the flow. */
export interface FlowEnd {
  top: number;
  size: number;
  /** The slot the end sits in: where its text goes. */
  slotTop: number;
  slot: number;
}
export interface FlowBand {
  item: FlowItem;
  left: FlowEnd;
  right: FlowEnd;
}
export interface FlowLayout {
  height: number;
  bands: FlowBand[];
}

/** Room for one line of text, a name and its visitors, beside a ribbon however thin it is. */
export const MIN_SLOT = 20;
const GAP = 8;
/** Height shared out on top of the slots. */
const SPREAD = 112;
/** Thinnest drawn ribbon end. */
export const HAIRLINE = 1.5;

/** px per whole share that makes the slots, none under MIN_SLOT, add up to `body`. Null when every share is 0. */
function scaleFor(shares: number[], body: number): number | null {
  let big = shares.filter((s) => s > 0);
  for (;;) {
    const total = big.reduce((a, s) => a + s, 0);
    if (!total) return null;
    const scale = (body - MIN_SLOT * (shares.length - big.length)) / total;
    const still = big.filter((s) => s * scale >= MIN_SLOT);
    if (still.length === big.length) return scale;
    big = still;
  }
}

const sizeOf = (share: number, scale: number) => (share > 0 ? Math.max(HAIRLINE, share * scale) : 0);

/** Beside the ribbons: each side stacked in the same order, both filling the height. */
export function wideLayout(items: FlowItem[]): FlowLayout {
  const n = items.length;
  if (!n) return { height: 0, bands: [] };
  const body = n * MIN_SLOT + SPREAD;
  const height = body + (n - 1) * GAP;
  const scales = [scaleFor(items.map((i) => i.visitorShare), body), scaleFor(items.map((i) => i.revenueShare), body)];
  const scale = Math.min(...scales.map((s) => s ?? Infinity), body);
  const side = (share: (i: FlowItem) => number): FlowEnd[] => {
    const slots = items.map((i) => Math.max(MIN_SLOT, share(i) * scale));
    const free = height - slots.reduce((a, s) => a + s, 0);
    let y = n > 1 ? 0 : free / 2;
    return items.map((i, k) => {
      const size = sizeOf(share(i), scale);
      const end = { top: y + (slots[k] - size) / 2, size, slotTop: y, slot: slots[k] };
      y += slots[k] + (n > 1 ? free / (n - 1) : 0);
      return end;
    });
  };
  const left = side((i) => i.visitorShare);
  const right = side((i) => i.revenueShare);
  return { height, bands: items.map((item, k) => ({ item, left: left[k], right: right[k] })) };
}

/** Height of the line of text above each ribbon on a narrow screen. */
export const NARROW_LABEL = 20;
/** Least height of a band: a full touch target. */
export const NARROW_BAND = 44;
const NARROW_GAP = 8;
const NARROW_SCALE = 150;

/** On a narrow screen: one band per link, its text above its ribbon, so no ribbon runs under another's text. */
export function narrowLayout(items: FlowItem[]): FlowLayout {
  let y = 0;
  const bands = items.map((item): FlowBand => {
    const a = sizeOf(item.visitorShare, NARROW_SCALE);
    const b = sizeOf(item.revenueShare, NARROW_SCALE);
    const slot = Math.max(NARROW_BAND, NARROW_LABEL + Math.max(a, b));
    const middle = y + NARROW_LABEL + (slot - NARROW_LABEL) / 2;
    const slotTop = y;
    const end = (size: number): FlowEnd => ({ top: middle - size / 2, size, slotTop, slot });
    y += slot + NARROW_GAP;
    return { item, left: end(a), right: end(b) };
  });
  return { height: Math.max(0, y - NARROW_GAP), bands };
}

const px = (n: number) => Math.round(n * 100) / 100;

/** A ribbon across a 100-unit wide box. The commands never change, so a new shape can be eased into. */
export function ribbonPath({ left, right }: Pick<FlowBand, 'left' | 'right'>): string {
  const [l0, l1, r0, r1] = [left.top, left.top + left.size, right.top, right.top + right.size].map(px);
  return `M0 ${l0}C50 ${l0} 50 ${r0} 100 ${r0}L100 ${r1}C50 ${r1} 50 ${l1} 0 ${l1}Z`;
}

/** An end's mark: a vertical stroke, `cap` px short at both ends for its round caps. */
export function nodePath(x: number, end: FlowEnd, cap: number): string {
  const inset = Math.min(cap, end.size / 2);
  return `M${x} ${px(end.top + inset)}L${x} ${px(end.top + end.size - inset)}`;
}
