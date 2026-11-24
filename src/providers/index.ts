import type { Hono } from 'hono';
import type { AppEnv } from '../worker/env';
import { forgetSite } from '../worker/env';
import { requireUser, siteAccessSql } from '../worker/auth';
import { polar } from './polar';
import type { ProviderSite } from './shared';

const fields = ['polar_webhook_secret'] as const;
function masked(site: ProviderSite) {
  return Object.fromEntries(fields.map(key => [key, site[key] ? '********' : null]));
}
const PROVIDERS = ['dodo', 'stripe', 'polar'] as const;
/** The newest recorded payment or refund per provider: proof a signed webhook really arrived, not just a saved secret. */
async function lastPayments(db: D1Database, siteId: string) {
  const { results } = await db.prepare('SELECT provider, MAX(ts) AS ts FROM payments WHERE site_id = ? GROUP BY provider').bind(siteId).all<{ provider: string; ts: number }>();
  const out = Object.fromEntries(PROVIDERS.map(p => [p, null])) as Record<typeof PROVIDERS[number], number | null>;
  for (const r of results) if ((PROVIDERS as readonly string[]).includes(r.provider)) out[r.provider as typeof PROVIDERS[number]] = r.ts;
  return out;
}
export function mountProviders(app: Hono<AppEnv>) {
  app.post('/api/webhooks/polar/:siteId', polar);
  for (const method of ['get', 'patch'] as const) {
    app[method]('/api/sites/:id/providers', requireUser, async c => {
      const access = siteAccessSql(c.env, c.get('user'));
      const site = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`)
        .bind(c.req.param('id'), ...access.params).first<ProviderSite>();
      if (!site) return c.json({ error: 'not found' }, 404);
      if (method === 'patch') {
        const body = await c.req.json<Record<string, unknown>>().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !fields.includes(k as typeof fields[number]))) return c.json({ error: 'invalid provider fields' }, 400);
        for (const key of fields) {
          if (!(key in body)) continue;
          const value = body[key];
          if (value !== null && (typeof value !== 'string' || value.length > 4096 || value === '********')) return c.json({ error: 'invalid secret' }, 400);
        }
        const updates = fields.filter(key => key in body);
        if (updates.length) {
          await c.env.DB.prepare(`UPDATE sites SET ${updates.map(key => `${key} = ?`).join(', ')} WHERE id = ?`)
            .bind(...updates.map(key => typeof body[key] === 'string' ? (body[key] as string).trim() || null : null), site.id).run();
          for (const key of updates) site[key] = typeof body[key] === 'string' ? (body[key] as string).trim() || null : null;
          forgetSite(site.id);
        }
      }
      c.header('Cache-Control', 'no-store');
      return c.json({
        ...masked(site),
        connected: { polar: !!site.polar_webhook_secret },
        last_payment: await lastPayments(c.env.DB, site.id),
      });
    });
  }
}
