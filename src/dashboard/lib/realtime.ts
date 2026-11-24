import { useCallback, useEffect, useRef, useState } from 'react';
import { displayName } from '../../shared/names';
import { api } from './api';
import { countryName, fmtMoney } from './format';

/** The shape of GET /api/sites/:id/realtime (src/worker/stats.ts `realtime`). */
export interface LiveVisitor {
  visitor_id: string;
  session_id: string;
  lat: number | null;
  lon: number | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  source: string;
  referrer_domain: string | null;
  page: string | null;
  started_at: number;
  last_seen_at: number;
  pageviews: number;
  name: string | null;
  email: string | null;
  /** Lifetime spend in the site's currency, minor units. Not money paid during this visit. */
  spent: number;
}

export interface FeedItem {
  id: string;
  ts: number;
  type: 'pageview' | 'goal' | 'payment' | 'refund';
  label?: string;
  /** Minor units; refunds are negative. */
  amount?: number;
  visitor_id: string | null;
  name: string | null;
  email?: string | null;
  country: string | null;
  /** The city of the visit the event belongs to (for a payment, the visit it was attributed to). */
  city?: string | null;
  lat: number | null;
  lon: number | null;
}

export interface Realtime {
  now: number;
  currency: string;
  decimals: number;
  domain: string;
  window: { active_ms: number; feed_ms: number; active_since: number; feed_since: number };
  active: { visitors: number; countries: number; unlocated: number };
  payments: { count: number; amount: number; refunds: number; refunded: number; net: number };
  other_currencies: { currency: string; payments: number; amount: number }[];
  truncated: { visitors: boolean; events: boolean; payments: boolean };
  visitors: LiveVisitor[];
  feed: FeedItem[];
}

/** Active visitors in one place. The key is stable across polls while the place is the same. */
export interface CityGroup {
  key: string;
  lat: number;
  lon: number;
  city: string | null;
  country: string | null;
  visitors: LiveVisitor[];
}

const placeKey = (country: string | null, city: string | null, lat: number, lon: number) => `${country ?? '-'}|${city ?? `${lat.toFixed(1)},${lon.toFixed(1)}`}`;

/** Located visitors grouped by city, largest first. Visitors without coordinates are left out (counted separately). */
export function groupByCity(visitors: LiveVisitor[]): CityGroup[] {
  const groups = new Map<string, CityGroup>();
  for (const v of visitors) {
    if (v.lat === null || v.lon === null) continue;
    const key = placeKey(v.country, v.city, v.lat, v.lon);
    const g = groups.get(key);
    if (g) g.visitors.push(v);
    else groups.set(key, { key, lat: v.lat, lon: v.lon, city: v.city, country: v.country, visitors: [v] });
  }
  return [...groups.values()].sort((a, b) => b.visitors.length - a.visitors.length || a.key.localeCompare(b.key));
}

export const groupKeyOf = (v: Pick<LiveVisitor, 'lat' | 'lon' | 'country' | 'city'>) => (v.lat === null || v.lon === null ? null : placeKey(v.country, v.city, v.lat, v.lon));

/** "Accra, Ghana", "Ghana", or null. */
export function placeName(city: string | null | undefined, country: string | null | undefined) {
  const c = country ? countryName(country) : null;
  if (city && c) return `${city}, ${c}`;
  return city || c || null;
}

/**
 * Polls the realtime endpoint while `enabled` and the tab is visible. Keeps the last good data on an error, with the
 * time it was fetched, so a failed poll never blanks the screen.
 */
export function useRealtime(siteId: string, intervalMs: number, enabled = true) {
  const [data, setData] = useState<Realtime | null>(null);
  const [error, setError] = useState('');
  const [fetchedAt, setFetchedAt] = useState(0);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const d = await api<Realtime>(`/api/sites/${siteId}/realtime`);
      setData(d);
      setFetchedAt(Date.now());
      setError('');
    } catch (e) {
      setError((e as Error).message || 'Network error');
    } finally {
      busy.current = false;
    }
  }, [siteId]);

  useEffect(() => {
    if (!enabled) return;
    if (document.visibilityState === 'visible') load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), intervalMs);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, intervalMs, enabled]);

  return { data, error, fetchedAt, reload: load };
}

/** Visitor text as one plain line: no line breaks that could pose as another entry, and no email addresses. */
const plain = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, ' ')
    .replace(/[^\s@|<>"'(),;:/?&=]+(?:@|%40)[^\s@|<>"'(),;:/?&=]+/gi, '[email]')
    .trim();

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * A plain-text snapshot an agent can read: exact counts, the windows they cover, what was cut short, who is here and
 * what happened. Emails are left out. Nothing is sent anywhere; the viewer copies it.
 */
export function snapshotText(site: { name: string; domain: string; timezone: string }, d: Realtime): string {
  const money = (m: number, cur = d.currency, dec = d.decimals) => fmtMoney(m, cur, dec);
  const at = new Date(d.now).toISOString();
  const lines: string[] = [];
  lines.push(`DataMonster live snapshot for ${site.domain} (${site.name})`, `As of ${at} (site timezone ${site.timezone})`, '');
  lines.push(`Active visitors (last ${minutes(d.window.active_ms)} min): ${d.active.visitors} in ${d.active.countries} ${d.active.countries === 1 ? 'country' : 'countries'}${d.active.unlocated ? `, ${d.active.unlocated} without a location` : ''}`);
  const p = d.payments;
  lines.push(
    `Payments (last ${minutes(d.window.feed_ms)} min, ${d.currency}): ${p.count} for ${money(p.amount)}` +
      (p.refunds ? `; ${p.refunds} ${p.refunds === 1 ? 'refund' : 'refunds'} of ${money(p.refunded)}; net ${money(p.net)}` : ''),
  );
  for (const o of d.other_currencies) lines.push(`Not included above: ${o.payments} ${o.payments === 1 ? 'payment' : 'payments'} in ${o.currency}, ${fmtMoney(o.amount, o.currency)}`);
  const cut = [d.truncated.visitors && 'visitor list', d.truncated.events && 'pageviews and goals', d.truncated.payments && 'payments'].filter(Boolean);
  if (cut.length) lines.push(`Lists cut short (counts and totals above are still exact): ${cut.join(', ')}`);

  const groups = groupByCity(d.visitors);
  if (groups.length) {
    lines.push('', 'Places (active visitors, locations approximate):');
    for (const g of groups.slice(0, 15)) lines.push(`- ${plain(placeName(g.city, g.country)) || 'Unknown'}: ${g.visitors.length}`);
  }
  if (d.visitors.length) {
    lines.push('', `Here now (${d.visitors.length}${d.truncated.visitors ? ` most recent of ${d.active.visitors}` : ''}): visitor | place | current page | source | lifetime spend`);
    for (const v of d.visitors.slice(0, 50))
      lines.push(`- ${displayName(v.visitor_id, plain(v.name))} | ${plain(placeName(v.city, v.country)) || 'unknown'} | ${plain(v.page) || '-'} | ${plain(v.source)} | ${v.spent ? money(v.spent) : '-'}`);
  }
  if (d.feed.length) {
    lines.push('', 'Recent activity (newest first):');
    for (const f of d.feed.slice(0, 25)) {
      const who = f.visitor_id ? displayName(f.visitor_id, plain(f.name)) : plain(f.name) || 'Unlinked customer';
      const where = plain(placeName(f.city, f.country));
      const what =
        f.type === 'pageview' ? `viewed ${plain(f.label)}` : f.type === 'goal' ? `completed ${plain(f.label)}` : f.type === 'payment' ? `paid ${money(f.amount ?? 0)}` : `refunded ${money(Math.abs(f.amount ?? 0))}`;
      lines.push(`- ${new Date(f.ts).toISOString()} ${who}${where ? ` (${where})` : ''} ${what}`);
    }
  }
  return lines.join('\n');
}
