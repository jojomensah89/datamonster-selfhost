import { classify, findKnownSource } from '../../shared/sources';
import { fmtNumber } from './format';

/** A saved link as the owner endpoints return it (src/agent/links.ts). */
export interface SavedLink {
  id: string;
  ref: string;
  destination: string;
  label: string | null;
  /** 'owner', or the id of the agent token that made it. */
  created_by: string;
  created_at: number;
  archived_at: number | null;
  url: string;
  visitors: number;
  customers: number;
  revenue: number;
}

/** Where a link gets posted. The tags make a visit report under that source and channel (src/shared/sources.ts). */
export interface Place {
  label: string;
  source: string;
  medium: string;
}
export const PLACES: Place[] = [
  { label: 'Instagram', source: 'instagram', medium: 'social' },
  { label: 'Facebook', source: 'facebook', medium: 'social' },
  { label: 'X / Twitter', source: 'x', medium: 'social' },
  { label: 'LinkedIn', source: 'linkedin', medium: 'social' },
  { label: 'Reddit', source: 'reddit', medium: 'social' },
  { label: 'YouTube', source: 'youtube', medium: 'video' },
  { label: 'Medium', source: 'medium', medium: 'article' },
  { label: 'Newsletter', source: 'newsletter', medium: 'email' },
  { label: 'Product Hunt', source: 'producthunt', medium: 'referral' },
  { label: 'Other', source: '', medium: '' },
];

/** Mirrors REF_PATTERN in src/agent/links.ts. */
export const REF_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
const REF_MAX = 49;

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, REF_MAX)
    .replace(/-+$/, '');
}

/** "Launch post" on Reddit gives "reddit-launch-post". Empty until there is a name. */
export function suggestRef(place: Place, name: string): string {
  if (!name.trim()) return '';
  // A name with no Latin letters or digits has no slug of its own.
  const slug = slugify(name) || 'link';
  if (!place.source || slug === place.source || slug.startsWith(`${place.source}-`)) return slug;
  return slugify(`${place.source}-${slug}`);
}

/** What a ref being typed is turned into: only characters the server accepts. A trailing hyphen stays, so typing can go on. */
export const typedRef = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, REF_MAX);

export type LinkPlan = { path: string; url: (ref: string) => string } | { error: string };

/**
 * The path to save for a page, with the place's utm_source and utm_medium added unless the page already has them,
 * and the URL to share for a ref. Mirrors destinationFor and taggedUrl in src/agent/links.ts, which still decide;
 * test/links-page.test.ts checks the two agree.
 */
export function planLink(domain: string, page: string, place: Place): LinkPlan {
  const site = domain.toLowerCase();
  let raw = page.trim() || '/';
  // "shipkit.dev/pricing" is a page on the site, not a path called shipkit.dev.
  const typed = raw.toLowerCase();
  for (const host of [site, `www.${site}`]) {
    if (typed === host || ['/', '?', '#'].some((c) => typed.startsWith(host + c))) raw = `https://${raw}`;
  }
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  let u: URL;
  try {
    u = new URL(absolute || raw.startsWith('/') ? raw : `/${raw}`, `https://${site}`);
  } catch {
    return { error: 'That is not a valid page address. Use a path like /pricing.' };
  }
  const host = u.hostname.toLowerCase();
  const www = host === `www.${site}`;
  if (!/^https?:$/.test(u.protocol) || u.port || u.username || u.password || (host !== site && !www)) {
    return { error: `The page must be on ${domain}.` };
  }
  if (u.searchParams.has('ref') || u.searchParams.has('via')) {
    return { error: 'This page already has a link tag (ref or via). Remove it: the one below is added for you.' };
  }
  let search = u.search;
  const add = (key: string, value: string) => {
    if (value && !u.searchParams.has(key)) search += `${search ? '&' : '?'}${key}=${value}`;
  };
  add('utm_source', place.source);
  add('utm_medium', place.medium);
  const local = `${u.pathname}${search}${u.hash}`;
  const origin = `https://${u.host}`;
  return {
    // A path is enough on the site's own domain; www, or a path that reads like another host, needs the full URL.
    path: www || local.startsWith('//') ? origin + local : local,
    url: (ref) => `${origin}${u.pathname}${search}${search ? '&' : '?'}ref=${ref}${u.hash}`,
  };
}

/** The page a link opens, without the source tags: "/pricing?plan=pro". */
export function pageOf(destination: string): string {
  try {
    const u = new URL(destination);
    const own = u.search
      .slice(1)
      .split('&')
      .filter((p) => p && !/^utm_(source|medium)=/i.test(p));
    return `${u.pathname}${own.length ? `?${own.join('&')}` : ''}${u.hash}`;
  } catch {
    return destination;
  }
}

/** The same page in words, for "Opens ...". */
export const opens = (destination: string) => {
  const page = pageOf(destination);
  return page === '/' ? 'your homepage' : page;
};

export const byRevenue = (a: SavedLink, b: SavedLink) => b.revenue - a.revenue || b.visitors - a.visitors || b.created_at - a.created_at;

/** What a link goes by: its label, else its ref. */
export const nameOf = (l: SavedLink) => l.label || l.ref;

/** "1 customer", "1,204 customers". */
export const count = (n: number, one: string) => `${fmtNumber(n)} ${one}${n === 1 ? '' : 's'}`;

/** The source a link was made for, for its icon: its utm_source, else a source its ref names ("reddit", "hn-comment"). */
export function sourceOf(l: Pick<SavedLink, 'destination' | 'ref'>): string | null {
  let utm: string | null = null;
  try {
    utm = new URL(l.destination).searchParams.get('utm_source');
  } catch {}
  if (utm) return findKnownSource(utm)?.name ?? utm;
  return (findKnownSource(l.ref) ?? findKnownSource(l.ref.split('-')[0]))?.name ?? null;
}

/** Made for an email, whose source may have no icon of its own. */
export function isEmail(l: Pick<SavedLink, 'destination' | 'ref'>): boolean {
  let q = new URLSearchParams();
  try {
    q = new URL(l.destination).searchParams;
  } catch {}
  const known = findKnownSource(sourceOf(l));
  return (known?.channel ?? classify({ referrerDomain: null, utmSource: q.get('utm_source'), utmMedium: q.get('utm_medium') }).channel) === 'Email';
}

// ---------------------------------------------------------------- the list's groups

export const GROUPS = ['earning', 'visited', 'unvisited', 'archived'] as const;
export type GroupId = (typeof GROUPS)[number];

/** Sales or refunds in a period without visits still count as activity, so such a link is never filed under "No visits". */
export function groupOf(l: SavedLink): GroupId {
  if (l.archived_at) return 'archived';
  if (l.revenue > 0) return 'earning';
  return l.visitors > 0 || l.customers > 0 || l.revenue < 0 ? 'visited' : 'unvisited';
}

const ORDER: Record<GroupId, (a: SavedLink, b: SavedLink) => number> = {
  earning: byRevenue,
  visited: (a, b) => b.visitors - a.visitors || byRevenue(a, b),
  unvisited: (a, b) => b.created_at - a.created_at,
  archived: (a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0),
};

export function groupLinks(links: SavedLink[]): Record<GroupId, SavedLink[]> {
  const out: Record<GroupId, SavedLink[]> = { earning: [], visited: [], unvisited: [], archived: [] };
  for (const l of links) out[groupOf(l)].push(l);
  for (const g of GROUPS) out[g].sort(ORDER[g]);
  return out;
}

/** A group's heading. "Yet" is only true of all time. */
export function groupTitle(g: GroupId, allTime: boolean): string {
  if (g === 'earning') return 'Bringing in money';
  if (g === 'archived') return 'Archived';
  if (g === 'visited') return allTime ? 'Visits, no sales yet' : 'Visits, no sales in this period';
  return allTime ? 'No visits yet' : 'No visits in this period';
}

export const ARCHIVED = 'Archived links keep working, and their visits still count.';

/** In place of the rates of a link whose visits have brought nothing. "Yet" is only true of all time. */
export const noSales = (allTime: boolean) => (allTime ? 'No sales yet' : 'No sales in this period');

/** Why a link with sales shows no revenue. */
export function refundNote(l: SavedLink): string | null {
  if (l.revenue < 0) return 'refunded';
  return l.revenue === 0 && l.customers > 0 ? 'refunded or free' : null;
}

/** Links whose name, link tag or page contains the text. */
export function searchLinks(links: SavedLink[], query: string): SavedLink[] {
  const q = query.trim().toLowerCase();
  if (!q) return links;
  return links.filter((l) => [nameOf(l), l.ref, pageOf(l.destination), opens(l.destination)].some((t) => t.toLowerCase().includes(q)));
}

export const FIRST_ROWS = 10;
export const MORE_ROWS = 20;

/** How many rows a group must show for the one at `index` to be among them, in "Show more" steps. */
export const rowsToShow = (index: number) => FIRST_ROWS + Math.max(0, Math.ceil((index + 1 - FIRST_ROWS) / MORE_ROWS)) * MORE_ROWS;

/** A bar's width as a percentage of its side. A value above zero always shows. */
export function barWidth(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(100, Math.max(1, (value / max) * 100));
}

/** The same as a CSS length, for what the bar's clip leaves visible. */
export function barLength(value: number, max: number): string {
  const w = barWidth(value, max);
  return w > 0 ? `max(2px, ${w}%)` : '0px';
}

/** A share in whole percent, never rounded to nothing or to everything. */
export function fmtShare(share: number): string {
  if (!(share > 0)) return '0%';
  if (share < 0.01) return '<1%';
  if (share > 0.99 && share < 1) return '>99%';
  return `${Math.round(share * 100)}%`;
}

/** Money per visitor: always in cents, so $1.80 is not shown as $1.8, and a fraction of a cent not as nothing. */
export function fmtEach(minor: number, currency: string, decimals: number): string {
  const unit = 1 / 10 ** decimals;
  const v = minor * unit;
  const tiny = v > 0 && v < unit;
  try {
    const digits = v === 0 || Math.abs(v) >= 1000 ? 0 : decimals;
    const f = new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    return tiny ? `<${f.format(unit)}` : f.format(v);
  } catch {
    return tiny ? `<${unit.toFixed(decimals)} ${currency}` : `${v.toFixed(decimals)} ${currency}`;
  }
}

/** Customers per visitor, or null with no visits, or when some customers came from earlier ones. */
export function conversionOf(l: SavedLink): string | null {
  if (!l.visitors || l.customers > l.visitors) return null;
  const rate = l.customers / l.visitors;
  if (rate > 0 && rate < 0.001) return '<0.1%';
  return `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%`;
}
