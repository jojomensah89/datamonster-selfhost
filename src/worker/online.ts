import type { Hono, Context } from 'hono';
import { getSite, type AppEnv } from './env';

export const widgetDefaults = { enabled: false, visitors: false, threshold: 3, rounding: true, theme: 'auto', powered: true };
export function widgetOptions(input: Record<string, unknown>) {
  const o = { ...widgetDefaults, ...input };
  for (const k of ['enabled', 'visitors', 'rounding', 'powered'] as const) if (typeof o[k] !== 'boolean') throw new Error(`${k} must be boolean`);
  if (!Number.isInteger(o.threshold) || o.threshold < 3 || o.threshold > 10000) throw new Error('threshold must be an integer from 3 to 10000');
  if (!['auto', 'light', 'dark'].includes(String(o.theme))) throw new Error('theme must be auto, light or dark');
  return Object.fromEntries(Object.keys(widgetDefaults).map(k => [k, o[k as keyof typeof o]])) as typeof widgetDefaults;
}
export async function getWidget(db: D1Database, id: string) {
  const row = await db.prepare('SELECT widget_enabled, widget_visitors, widget_threshold, widget_rounding, widget_theme, widget_powered FROM sites WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw new Error('site not found');
  return { enabled: !!row.widget_enabled, visitors: !!row.widget_visitors, threshold: Number(row.widget_threshold), rounding: !!row.widget_rounding, theme: String(row.widget_theme), powered: !!row.widget_powered };
}
export async function saveWidget(db: D1Database, id: string, input: Record<string, unknown>) {
  const o = widgetOptions(input);
  await db.prepare('UPDATE sites SET widget_enabled=?, widget_visitors=?, widget_threshold=?, widget_rounding=?, widget_theme=?, widget_powered=? WHERE id=?').bind(+o.enabled, +o.visitors, o.threshold, +o.rounding, o.theme, +o.powered, id).run();
  return o;
}
export function widgetSnippet(id: string, origin: string, o: { theme: string; powered: boolean }) {
  const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return `<script async src="${escape(origin)}/js/widget.js"></script>\n<datamonster-online site="${escape(id)}" theme="${escape(o.theme)}" powered="${o.powered}" style="display:inline-block;height:34px"></datamonster-online>`;
}
export const publicCount = (n: number, threshold: number, rounding: boolean) => n < threshold ? null : rounding ? Math.floor(n / (n < 10 ? 1 : 10 ** (Math.floor(Math.log10(n)) - 1))) * (n < 10 ? 1 : 10 ** (Math.floor(Math.log10(n)) - 1)) : n;
/** Addresses over the limit this minute, so refusing them again writes nothing. Bounded; per isolate. */
const overLimit = new Map<string, number>();

export function mountOnline(app: Hono<AppEnv>) {
  app.all('/api/public/online/:siteId', async c => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET');
    c.header('Cache-Control', 'no-store');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    if (c.req.method !== 'GET') return c.body(null, 405);
    const id = c.req.param('siteId');
    if (!/^[\w-]{1,64}$/.test(id)) return c.body(null, 404);
    const refuse = () => { c.header('Retry-After', '60'); return c.body(null, 429); };
    // No raw address is retained.
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.req.header('cf-connecting-ip') || 'local'));
    const key = Array.from(new Uint8Array(hash)).map(x => x.toString(16).padStart(2, '0')).join('');
    const minute = Math.floor(Date.now()/60000);
    if (overLimit.get(key) === minute) return refuse();
    // Made-up ids are remembered, so repeating one reads nothing. The settings themselves are read fresh every time.
    if (!(await getSite(c.env.DB, id))) return c.body(null, 404);
    const row = await c.env.DB.prepare('SELECT widget_enabled,widget_visitors,widget_threshold,widget_rounding FROM sites WHERE id=?').bind(id).first<Record<string, number>>();
    if (!row?.widget_enabled) return c.body(null, 404);
    const cache = typeof caches !== 'undefined' ? (caches as CacheStorage & {default: Cache}).default : undefined;
    // Include privacy settings so disabling or tightening takes effect immediately.
    const cacheKey = new Request(`${new URL(c.req.url).origin}/api/public/online/${encodeURIComponent(id)}?v=${row.widget_visitors}-${row.widget_threshold}-${row.widget_rounding}`);
    const hit = await cache?.match(cacheKey);
    if (hit) return hit;
    // Only a request that needs counting reaches the stored counter.
    const limit = await c.env.DB.prepare('INSERT INTO widget_limits(key, minute, hits) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET minute=excluded.minute, hits=CASE WHEN widget_limits.minute=excluded.minute THEN widget_limits.hits+1 ELSE 1 END RETURNING hits').bind(key, minute).first<{ hits: number }>();
    const hits = Number(limit?.hits ?? 0);
    if (hits === 1) await c.env.DB.prepare('DELETE FROM widget_limits WHERE minute < ?').bind(minute - 1).run();
    if (hits > 120) {
      if (overLimit.size >= 5000) overLimit.clear();
      overLimit.set(key, minute);
      return refuse();
    }
    const now = Date.now();
    // Visits last at most a few hours, so the online count alone needs only those; 30 days is for the shared visitor count.
    const since = row.widget_visitors ? now - 30*86400000 : now - 6*3600000;
    const counts = await c.env.DB.prepare('SELECT COUNT(DISTINCT CASE WHEN last_seen_at > ? THEN visitor_id END) AS online, COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE site_id=? AND started_at > ?').bind(now-300000,id,since).first<{online:number;visitors:number}>();
    const body = { online: publicCount(counts?.online || 0,row.widget_threshold,!!row.widget_rounding), visitors: row.widget_visitors ? publicCount(counts?.visitors || 0,row.widget_threshold,!!row.widget_rounding) : null };
    c.header('Cache-Control', 'public, max-age=20, s-maxage=20');
    const response = c.json(body);
    if (cache) c.executionCtx.waitUntil(cache.put(cacheKey,response.clone()));
    return response;
  });
}
export async function widgetSettings(c: Context<AppEnv>) {
  const id = c.get('site').id;
  if (c.req.method === 'GET') return c.json(await getWidget(c.env.DB,id));
  try { return c.json(await saveWidget(c.env.DB,id,await c.req.json())); }
  catch (e) { return c.json({error: e instanceof Error ? e.message : 'Invalid options'},400); }
}
