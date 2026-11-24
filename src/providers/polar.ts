import type { Context } from 'hono';
import type { AppEnv } from '../worker/env';
import { takePayment } from '../worker/auth';
import { verifyStandardWebhook } from '../worker/lib/crypto';
import { providerSite, save, text } from './shared';

export async function polar(c: Context<AppEnv>) {
  const site = await providerSite(c);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  const secret = site.polar_webhook_secret;
  const body = await c.req.text();
  const headers = { id: c.req.header('webhook-id') ?? null, timestamp: c.req.header('webhook-timestamp') ?? null, signature: c.req.header('webhook-signature') ?? null };
  // Polar supports both Standard Webhooks secrets and its legacy full-string UTF-8 HMAC key.
  if (!secret || !(await verifyStandardWebhook(secret, headers, body) || await verifyStandardWebhook(btoa(secret), headers, body))) {
    return c.json({ error: 'invalid signature' }, 401);
  }
  let event;
  try { event = JSON.parse(body); } catch { return c.json({ error: 'invalid JSON' }, 400); }
  const d = event.data ?? {};
  const refund = event.type === 'order.refunded';
  if (!refund && event.type !== 'order.paid') return c.json({ ok: true });
  if (!text(d.id)) return c.json({ ok: true });
  if (!(await takePayment(c.env, site))) return c.json({ ok: true, ignored: 'this website is not recording on its plan' });
  const customer = d.customer ?? {};
  const meta = { ...customer.metadata, ...d.customer_metadata, ...d.metadata };
  const reference = text(meta.reference_id);
  await save(c, site, {
    id: `${site.id}:polar:${d.id}${refund ? ':refund' : ''}`, provider: 'polar',
    ts: Date.parse((refund ? d.modified_at : d.created_at) ?? event.timestamp) || Date.now(),
    amount: refund ? -Math.abs(d.refunded_amount + (d.refunded_tax_amount ?? 0)) : d.total_amount,
    kind: refund ? 'refund' : 'payment', currency: text(d.currency) ?? site.currency,
    visitorId: text(meta.dm_visitor_id) ?? text(meta.visitor_id) ?? (reference?.startsWith('dm_') ? reference.slice(3) : null),
    customerId: text(d.customer_id) ?? text(customer.id), email: text(customer.email)?.toLowerCase(), name: text(customer.name),
    subscriptionId: text(d.subscription_id), checkoutId: text(d.checkout_id), productId: text(d.product_id),
    renewal: d.billing_reason === 'subscription_cycle' || d.billing_reason === 'subscription_renewal',
  });
  return c.json({ ok: true });
}
