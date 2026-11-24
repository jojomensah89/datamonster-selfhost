import type { Context } from 'hono';
import { SITE_WITH_OWNER_SQL, type AppEnv, type SiteWithOwner } from '../worker/env';
import { recordPayment } from '../worker/payments';

export type ProviderSite = SiteWithOwner & { polar_webhook_secret: string | null };
export const text = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
export const id = (v: unknown): string | null => typeof v === 'number' ? String(v) : text(v);
export async function providerSite(c: Context<AppEnv>) {
  return c.env.DB.prepare(`${SITE_WITH_OWNER_SQL} WHERE s.id = ?`).bind(c.req.param('siteId')).first<ProviderSite>();
}
export type Input = Parameters<typeof recordPayment>[2];
/** One cumulative refund row per order. MIN is atomic, tolerates concurrent and out-of-order deliveries. */
export async function save(c: Context<AppEnv>, site: ProviderSite, input: Input) {
  if (!Number.isSafeInteger(input.amount) || !input.currency || !input.id) return;
  await recordPayment(c.env.DB, site, input);
  if (input.kind === 'refund') {
    await c.env.DB.prepare("UPDATE payments SET amount = MIN(amount, ?) WHERE id = ? AND site_id = ? AND kind = 'refund'")
      .bind(input.amount, input.id, site.id).run();
  }
}
