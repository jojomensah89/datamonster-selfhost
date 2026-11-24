import type { Context } from 'hono';
import { bumpUsage, recordingLimits, takePayment, utcMonth } from './auth';
import { getSite, SITE_WITH_OWNER_SQL, type AppEnv, type Site, type SiteWithOwner } from './env';
import { verifyStandardWebhook, verifyStripeWebhook } from './lib/crypto';
import { currencyDecimals } from '../shared/currency';

export { currencyDecimals };

interface PaymentInput {
  id: string;
  provider: string;
  ts: number;
  amount: number; // minor units; negative for refunds
  kind: 'payment' | 'refund';
  currency: string;
  visitorId?: string | null;
  sessionId?: string | null;
  customerId?: string | null;
  email?: string | null;
  name?: string | null;
  subscriptionId?: string | null;
  checkoutId?: string | null;
  productId?: string | null;
  renewal?: boolean;
}

export type MatchedBy = 'metadata' | 'return_page' | 'customer' | 'email' | 'timing';

/** The visit that gets the credit: the visitor's last visit that came from somewhere (last non-direct touch). */
export function creditedSessionSql() {
  return `SELECT id FROM sessions WHERE site_id = ? AND visitor_id = ? AND started_at <= ?
          ORDER BY (channel != 'Direct') DESC, started_at DESC LIMIT 1`;
}

/**
 * Work out which visitor paid and which visit gets the credit, trying the most reliable signal first:
 *  1. metadata   dm_visitor_id passed to the checkout
 *  2. return_page  the visitor landed on your return URL with ?payment_id= (Dodo) or ?session_id= (Stripe)
 *  3. customer   the same customer paid before (renewals)
 *  4. email      the email matches a visitor you identify()'d
 *  5. timing     exactly one visitor clicked a Dodo/Stripe checkout link (or a checkout goal) shortly before the payment
 * Credit goes to the last non-direct visit, so "saw a tweet, came back directly 17 days later and paid"
 * is credited to the tweet.
 */
async function attribute(db: D1Database, site: Site, p: PaymentInput) {
  let visitorId = p.visitorId ?? null;
  let matchedBy: MatchedBy | null = visitorId ? 'metadata' : null;
  let renewal = !!p.renewal;

  if (!visitorId) {
    const claim = await db
      .prepare('SELECT visitor_id FROM payment_claims WHERE site_id = ? AND payment_id IN (?, ?, ?) ORDER BY ts LIMIT 1')
      .bind(site.id, p.id, p.subscriptionId ?? p.id, p.checkoutId ?? p.id)
      .first<{ visitor_id: string }>();
    if (claim) [visitorId, matchedBy] = [claim.visitor_id, 'return_page'];
  }

  if (p.customerId || p.email) {
    const prev = await db
      .prepare(
        `SELECT visitor_id FROM payments WHERE site_id = ? AND kind = 'payment' AND visitor_id IS NOT NULL AND id != ?
           AND ((customer_id IS NOT NULL AND customer_id = ?) OR (email IS NOT NULL AND email = ?))
         ORDER BY ts ASC LIMIT 1`,
      )
      .bind(site.id, p.id, p.customerId ?? null, p.email ?? null)
      .first<{ visitor_id: string }>();
    if (prev) {
      if (!visitorId) [visitorId, matchedBy] = [prev.visitor_id, 'customer'];
      // Same customer paid before: a subscription renewal or repeat purchase.
      if (p.kind === 'payment') renewal = true;
    }
  }
  if (!visitorId && p.email) {
    const v = await db
      .prepare('SELECT id FROM visitors WHERE site_id = ? AND email = ? ORDER BY first_seen DESC LIMIT 1')
      .bind(site.id, p.email)
      .first<{ id: string }>();
    if (v) [visitorId, matchedBy] = [v.id, 'email'];
  }
  let reason: string | null = null;
  if (!visitorId && p.kind === 'payment' && !renewal) {
    const t = await matchByTiming(db, site, p);
    if (t.visitorId) [visitorId, matchedBy] = [t.visitorId, 'timing'];
    reason = t.reason;
  }

  let sessionId: string | null = null;
  if (visitorId) {
    const s = await db.prepare(creditedSessionSql()).bind(site.id, visitorId, p.ts + 60_000).first<{ id: string }>();
    sessionId = s?.id ?? p.sessionId ?? null;
  }
  return { visitorId, sessionId, renewal, matchedBy, reason };
}

const TIMING_WINDOW_MS = 3 * 3_600_000;
const MIN = 60_000;

/**
 * Last resort when nothing identifies the buyer: look at who clicked a Dodo/Stripe/Polar checkout link (or a checkout goal)
 * in the 3 hours before the payment. The strongest sign is coming back to the site right after paying
 * (Dodo, Stripe and Polar redirect buyers to your return page); people who clicked Buy and gave up don't.
 * Only ever picks a visitor when the evidence points to exactly one person.
 */
async function matchByTiming(db: D1Database, site: Site, p: PaymentInput): Promise<{ visitorId: string | null; reason: string }> {
  const clicks = await db
    .prepare(
      `SELECT e.visitor_id, MAX(e.ts) AS last_click FROM events e
       WHERE e.site_id = ? AND e.ts BETWEEN ? AND ?
         AND ((e.type = 'outbound' AND (e.name LIKE '%dodopayments.com%' OR e.name LIKE '%buy.stripe.com%' OR e.name LIKE '%checkout.stripe.com%' OR e.name LIKE '%buy.polar.sh%' OR e.name LIKE '%polar.sh/checkout%'))
              OR (e.type = 'goal' AND (e.name LIKE '%checkout%' OR e.name LIKE '%buy%' OR e.name LIKE '%purchase%')))
         AND NOT EXISTS (SELECT 1 FROM payments o WHERE o.site_id = e.site_id AND o.visitor_id = e.visitor_id
                         AND o.kind = 'payment' AND o.id != ? AND o.ts BETWEEN ? AND ?)
       GROUP BY e.visitor_id ORDER BY last_click DESC LIMIT 50`,
    )
    .bind(site.id, p.ts - TIMING_WINDOW_MS, p.ts + 2 * MIN, p.id, p.ts - TIMING_WINDOW_MS, p.ts + TIMING_WINDOW_MS)
    .all<{ visitor_id: string; last_click: number }>();
  const cands = clicks.results;
  if (!cands.length) return { visitorId: null, reason: 'No one clicked a checkout link in the 3 hours before this payment (was the script installed yet?)' };
  if (cands.length === 1) return { visitorId: cands[0].visitor_id, reason: 'Only checkout click before the payment' };

  // Who came back to the site shortly after the payment, after having clicked checkout?
  const placeholders = cands.map(() => '?').join(',');
  const views = await db
    .prepare(
      `SELECT visitor_id, ts FROM events
       WHERE site_id = ? AND type = 'pageview' AND ts BETWEEN ? AND ? AND visitor_id IN (${placeholders})
       LIMIT 1000`,
    )
    .bind(site.id, p.ts - MIN, p.ts + 30 * MIN, ...cands.map((c) => c.visitor_id))
    .all<{ visitor_id: string; ts: number }>();
  const lastClick = new Map(cands.map((c) => [c.visitor_id, c.last_click]));
  // A pageview after their last checkout click = they came back from the checkout.
  const returned = [...new Set(views.results.filter((v) => v.ts > (lastClick.get(v.visitor_id) ?? Infinity)).map((v) => v.visitor_id))];
  if (returned.length === 1) return { visitorId: returned[0], reason: 'Came back to the site right after paying' };

  // Nobody (or several people) came back: fall back to a single clicker in the 30 minutes before paying.
  const recent = cands.filter((c) => c.last_click >= p.ts - 30 * MIN && c.last_click <= p.ts + MIN);
  if (recent.length === 1) return { visitorId: recent[0].visitor_id, reason: 'Only checkout click in the 30 minutes before the payment' };

  return {
    visitorId: null,
    reason: `${cands.length} people clicked checkout before this payment${returned.length > 1 ? ` and ${returned.length} came back right after` : ''}; too close to call`,
  };
}

export async function recordPayment(db: D1Database, site: Site, input: PaymentInput) {
  const p = tidy(input);
  const { visitorId, sessionId, renewal, matchedBy } = await attribute(db, site, p);
  // Seen before (a retry, or Stripe's invoice.paid arriving before checkout.session.completed): fill in what
  // was missing, and let checkout metadata win over a weaker match.
  const better = `(payments.visitor_id IS NULL OR excluded.matched_by = 'metadata')`;
  const stmts = [
    db
      .prepare(
        `INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name, renewal, matched_by, subscription_id, checkout_id, product_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           visitor_id = CASE WHEN ${better} THEN COALESCE(excluded.visitor_id, payments.visitor_id) ELSE payments.visitor_id END,
           session_id = CASE WHEN ${better} THEN COALESCE(excluded.session_id, payments.session_id) ELSE payments.session_id END,
           matched_by = CASE WHEN ${better} THEN COALESCE(excluded.matched_by, payments.matched_by) ELSE payments.matched_by END,
           checkout_id = COALESCE(payments.checkout_id, excluded.checkout_id)
         WHERE payments.site_id = excluded.site_id`,
      )
      .bind(
        p.provider === 'dodo' || p.provider === 'stripe' ? `${site.id}:${p.id}` : p.id,
        site.id,
        p.provider,
        p.ts,
        p.amount,
        p.kind,
        p.currency.toUpperCase(),
        visitorId,
        sessionId,
        p.customerId ?? null,
        p.email ?? null,
        p.name ?? null,
        renewal ? 1 : 0,
        matchedBy,
        p.subscriptionId ?? null,
        p.checkoutId ?? null,
        p.productId ?? null,
      ),
  ];
  // A payment tells us who an anonymous visitor really is.
  if (visitorId && p.kind === 'payment' && (p.email || p.name)) {
    stmts.push(
      db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, visitorId, p.ts),
      db
        .prepare('UPDATE visitors SET email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE site_id = ? AND id = ?')
        .bind(p.email ?? null, p.name ?? null, site.id, visitorId),
    );
  }
  await db.batch(stmts);
  return { visitorId, sessionId };
}

/** Each payment takes several queries, so a call works through a few; the caller passes `next` back for the rest. */
export const REMATCH_BATCH = 20;

/** Try again to link payments that have no visitor yet (e.g. ones recorded before a fallback existed). */
export async function rematchPayments(db: D1Database, site: Site, after?: string | null) {
  const [afterTs, afterId] = /^\d+\|/.test(after ?? '') ? [Number(after!.split('|', 1)[0]), after!.slice(after!.indexOf('|') + 1)] : [-1, ''];
  const rows = await db
    .prepare(
      `SELECT * FROM payments WHERE site_id = ? AND kind = 'payment' AND visitor_id IS NULL AND (ts > ? OR (ts = ? AND id > ?))
       ORDER BY ts, id LIMIT ${REMATCH_BATCH}`,
    )
    .bind(site.id, afterTs, afterTs, afterId)
    .all<{ id: string; ts: number; amount: number; currency: string; customer_id: string | null; email: string | null; name: string | null; provider: string; subscription_id: string | null }>();
  let matched = 0;
  const details: { id: string; name: string | null; matched: boolean; reason: string | null }[] = [];
  for (const r of rows.results) {
    const a = await attribute(db, site, {
      id: (r.provider === 'dodo' || r.provider === 'stripe') && r.id.startsWith(`${site.id}:`) ? r.id.slice(site.id.length + 1) : r.id,
      provider: r.provider,
      ts: r.ts,
      amount: r.amount,
      kind: 'payment',
      currency: r.currency,
      customerId: r.customer_id,
      email: r.email,
      name: r.name,
      subscriptionId: r.subscription_id,
    });
    details.push({ id: r.id, name: r.name, matched: !!a.visitorId, reason: a.reason });
    if (!a.visitorId) continue;
    matched++;
    await db.batch([
      db
        .prepare('UPDATE payments SET visitor_id = ?, session_id = ?, matched_by = ?, renewal = ? WHERE site_id = ? AND id = ?')
        .bind(a.visitorId, a.sessionId, a.matchedBy, a.renewal ? 1 : 0, site.id, r.id),
      db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, a.visitorId, r.ts),
      db
        .prepare('UPDATE visitors SET email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE site_id = ? AND id = ?')
        .bind(r.email, r.name, site.id, a.visitorId),
    ]);
  }
  const last = rows.results[rows.results.length - 1];
  return { checked: rows.results.length, matched, details, next: rows.results.length === REMATCH_BATCH ? `${last.ts}|${last.id}` : null };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

const cut = (s: string | null | undefined, n: number) => s?.slice(0, n) ?? null;
/** Providers' texts are short; whoever holds a site's secret could send any length. */
const tidy = (p: PaymentInput): PaymentInput => ({
  ...p,
  id: p.id.slice(0, 200),
  currency: p.currency.slice(0, 10),
  visitorId: cut(p.visitorId, 64),
  sessionId: cut(p.sessionId, 64),
  customerId: cut(p.customerId, 200),
  email: cut(p.email, 200),
  name: cut(p.name, 200),
  subscriptionId: cut(p.subscriptionId, 200),
  checkoutId: cut(p.checkoutId, 200),
  productId: cut(p.productId, 100),
});

function pickMeta(meta: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!meta) return null;
  for (const k of keys) if (str(meta[k])) return meta[k] as string;
  return null;
}

/** Which of this owner's sites have seen the visitor. Another owner's data is never evidence about this one's payments. */
async function ownerSitesWithVisitor(db: D1Database, site: Site, visitorId: string) {
  const r = await db
    .prepare('SELECT v.site_id FROM visitors v JOIN sites s ON s.id = v.site_id WHERE v.id = ? AND s.owner_id IS ? ORDER BY v.site_id = ? DESC LIMIT 20')
    .bind(visitorId, site.owner_id ?? null, site.id)
    .all<{ site_id: string }>();
  return r.results.map((x) => x.site_id);
}

/**
 * Does this Dodo payment belong to this site? true = yes, false = another site's, null = can't tell yet.
 * Dodo sends every payment in the account to every webhook, so this is decided per product. `learn` is
 * set when the payment itself proves the product is this site's.
 */
async function ownsDodoPayment(db: D1Database, site: Site, products: string[], visitorId: string | null) {
  const manual = (site.dodo_product_ids ?? '').split(',').filter(Boolean);
  if (manual.length) return { owned: products.some((id) => manual.includes(id)), learn: false };

  // The buyer's visitor id is first-party to one site's domain.
  if (visitorId) {
    const sites = await ownerSitesWithVisitor(db, site, visitorId);
    if (sites.includes(site.id)) return { owned: true, learn: true };
    if (sites.length) return { owned: false, learn: false };
  }
  if (products.length) {
    // Product ids belong to one Dodo account, so only the same owner's sites can claim them.
    const r = await db
      .prepare(
        `SELECT dp.site_id FROM dodo_products dp JOIN sites s ON s.id = dp.site_id
         WHERE dp.product_id IN (${products.map(() => '?').join(',')}) AND s.owner_id IS ?`,
      )
      .bind(...products, site.owner_id ?? null)
      .all<{ site_id: string }>();
    const sites = r.results.map((x) => x.site_id);
    if (sites.includes(site.id)) return { owned: true, learn: false };
    if (sites.length) return { owned: false, learn: false };
  }
  // A new product: it's this site's if no other site of the same owner takes Dodo payments.
  const other = await db
    .prepare('SELECT 1 FROM sites WHERE id != ? AND dodo_webhook_secret IS NOT NULL AND owner_id IS ? LIMIT 1')
    .bind(site.id, site.owner_id ?? null)
    .first();
  return { owned: other ? null : true, learn: !other };
}

/**
 * Remember that these products belong to the site: count its waiting payments, and drop the copies the owner's other
 * sites were holding. Only a signed webhook or the signed-in owner may cause this, never a tracking event: anyone can send those.
 */
export async function learnDodoProducts(db: D1Database, site: Site, products: string[]) {
  if (!products.length) return;
  const ph = products.map(() => '?').join(',');
  const pending = await db
    .prepare(`SELECT payload FROM pending_payments WHERE site_id = ? AND product_id IN (${ph})`)
    .bind(site.id, ...products)
    .all<{ payload: string }>();
  await db.batch([
    ...products.map((id) => db.prepare('INSERT OR IGNORE INTO dodo_products (product_id, site_id) VALUES (?, ?)').bind(id, site.id)),
    // Only payments this site holds too: a site that never got the payment can't drop another site's only copy.
    db
      .prepare(
        `DELETE FROM pending_payments WHERE site_id IN (SELECT id FROM sites WHERE owner_id IS ?) AND payment_id IN
           (SELECT payment_id FROM pending_payments WHERE site_id = ? AND product_id IN (${ph}))`,
      )
      .bind(site.owner_id ?? null, site.id, ...products),
  ]);
  for (const row of pending.results) await recordPayment(db, site, JSON.parse(row.payload) as PaymentInput);
}

/** Answered as received, so the provider doesn't keep retrying. */
const NOT_RECORDING = { ok: true, ignored: 'this website is not recording on its plan' };

/** Dodo Payments webhook: POST /api/webhooks/dodo/:siteId */
export async function handleDodoWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.dodo_webhook_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);

  const body = await c.req.text();
  const ok = await verifyStandardWebhook(
    site.dodo_webhook_secret,
    {
      id: c.req.header('webhook-id') ?? null,
      timestamp: c.req.header('webhook-timestamp') ?? null,
      signature: c.req.header('webhook-signature') ?? null,
    },
    body,
  );
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  const event = JSON.parse(body) as { type: string; timestamp?: string; data: Record<string, any> };
  if (event.type !== 'payment.succeeded' && event.type !== 'refund.succeeded') return c.json({ ok: true, ignored: 'event not used' });
  const data = event.data ?? {};
  const customer = (data.customer ?? {}) as Record<string, unknown>;
  const meta = { ...(customer.metadata as object), ...(data.metadata as object) } as Record<string, unknown>;
  const ts = Date.parse(data.created_at ?? event.timestamp ?? '') || Date.now();

  const products: string[] = Array.isArray(data.product_cart) ? data.product_cart.slice(0, 50).map((p: any) => str(p?.product_id)?.slice(0, 100)).filter((x: string | undefined): x is string => !!x) : [];

  if (event.type === 'payment.succeeded') {
    let amount = Number(data.total_amount) || 0;
    let currency = String(data.currency ?? site.currency);
    if (currency.toUpperCase() !== site.currency && str(data.settlement_currency)?.toUpperCase() === site.currency) {
      amount = Number(data.settlement_amount) || amount;
      currency = data.settlement_currency;
    }
    const payment = tidy({
      id: String(data.payment_id),
      provider: 'dodo',
      ts,
      amount,
      kind: 'payment',
      currency,
      visitorId: pickMeta(meta, ['dm_visitor_id', 'visitor_id', 'datamonster_visitor_id']),
      sessionId: pickMeta(meta, ['dm_session_id', 'session_id', 'datamonster_session_id']),
      customerId: str(customer.customer_id) ?? str(data.customer_id),
      email: str(customer.email)?.toLowerCase() ?? null,
      name: str(customer.name),
      subscriptionId: str(data.subscription_id) ?? (Array.isArray(data.subscription_ids) ? str(data.subscription_ids[0]) : null),
      productId: products[0] ?? null,
    });
    const { owned, learn } = await ownsDodoPayment(c.env.DB, site, products, payment.visitorId ?? null);
    if (owned === false) return c.json({ ok: true, ignored: 'another site\'s product' });
    const waiting = await c.env.DB.prepare('SELECT 1 FROM pending_payments WHERE site_id = ? AND payment_id = ?').bind(site.id, payment.id).first();
    if (!waiting && !(await takePayment(c.env, site, { id: `${site.id}:${payment.id}` }))) return c.json(NOT_RECORDING);
    if (owned === null) {
      await c.env.DB.prepare('INSERT OR IGNORE INTO pending_payments (site_id, payment_id, product_id, ts, payload) VALUES (?, ?, ?, ?, ?)')
        .bind(site.id, payment.id, payment.productId, ts, JSON.stringify(payment))
        .run();
      return c.json({ ok: true, pending: 'unknown product' });
    }
    await recordPayment(c.env.DB, site, payment);
    if (learn) await learnDodoProducts(c.env.DB, site, products);
  } else if (event.type === 'refund.succeeded') {
    const original = await c.env.DB.prepare('SELECT * FROM payments WHERE id = ? AND site_id = ?')
      .bind(`${site.id}:${data.payment_id}`, site.id)
      .first<{ id: string; visitor_id: string | null; session_id: string | null; currency: string; amount: number }>();
    // A refund of a payment this site never recorded (another product, or before tracking) isn't this site's.
    if (!original) {
      await c.env.DB.prepare('DELETE FROM pending_payments WHERE site_id = ? AND payment_id = ?').bind(site.id, String(data.payment_id)).run();
      return c.json({ ok: true, ignored: 'unknown payment' });
    }
    const refundId = `${site.id}:${data.refund_id ?? `refund_${data.payment_id}`}`.slice(0, 250);
    if (!(await takePayment(c.env, site, { id: refundId, refundOf: original.id }))) return c.json(NOT_RECORDING);
    const amount = Number(data.amount) || original.amount || 0;
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name)
       VALUES (?, ?, 'dodo', ?, ?, 'refund', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        refundId,
        site.id,
        ts,
        -Math.abs(amount),
        String(data.currency ?? original.currency ?? site.currency).toUpperCase(),
        original.visitor_id ?? null,
        original.session_id ?? null,
        cut(str(customer.customer_id), 200),
        cut(str(customer.email)?.toLowerCase(), 200),
        cut(str(customer.name), 200),
      )
      .run();
  }
  // Every other event type is acknowledged so Dodo doesn't retry it.
  return c.json({ ok: true });
}

/**
 * One Stripe account can feed several sites, and Stripe sends every event to every endpoint. Without this,
 * a payment lands on whichever site's webhook happens to arrive first. A payment is another site's when its
 * checkout is tagged for that site (metadata dm_site_id), when the buyer's visitor id was only ever seen on
 * the owner's other sites, or (renewals, which carry no visitor) when the customer has only ever paid on other sites.
 * With no evidence either way it's recorded, as before.
 */
export async function stripePaymentIsElsewhere(
  db: D1Database,
  site: Site,
  p: { taggedSite?: string | null; visitorId?: string | null; customerId?: string | null },
): Promise<boolean> {
  if (p.taggedSite) return p.taggedSite !== site.id;
  if (p.visitorId) {
    const sites = await ownerSitesWithVisitor(db, site, p.visitorId);
    if (sites.length) return !sites.includes(site.id);
  }
  if (p.customerId) {
    const r = await db
      .prepare(
        `SELECT p.site_id FROM payments p JOIN sites s ON s.id = p.site_id
         WHERE p.provider = 'stripe' AND p.customer_id = ? AND s.owner_id IS ? GROUP BY p.site_id ORDER BY p.site_id = ? DESC LIMIT 20`,
      )
      .bind(p.customerId, site.owner_id ?? null, site.id)
      .all<{ site_id: string }>();
    const sites = r.results.map((x) => x.site_id);
    if (sites.length) return !sites.includes(site.id);
  }
  return false;
}

const STRIPE_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'invoice.paid', 'charge.refunded']);

/** Stripe webhook: POST /api/webhooks/stripe/:siteId */
export async function handleStripeWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.stripe_webhook_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);

  const body = await c.req.text();
  if (!(await verifyStripeWebhook(site.stripe_webhook_secret, c.req.header('stripe-signature') ?? null, body))) {
    return c.json({ error: 'invalid signature' }, 401);
  }

  const event = JSON.parse(body) as { type: string; data: { object: Record<string, any> } };
  if (!STRIPE_EVENTS.has(event.type)) return c.json({ ok: true, ignored: 'event not used' });
  const o = event.data?.object ?? {};
  const ts = (Number(o.created) || Date.now() / 1000) * 1000;
  // Older API versions put these on the object, newer ones under `parent`.
  const subscriptionId = str(o.subscription) ?? str(o.parent?.subscription_details?.subscription);

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (o.payment_status !== 'paid') return c.json({ ok: true, ignored: 'not paid yet' });
    // Payment links can't carry metadata, so the script puts the visitor in client_reference_id: dm_<vid>__<sid>.
    const ref = /^dm_([\w-]+?)__([\w-]+)$/.exec(o.client_reference_id ?? '');
    const visitorId = pickMeta(o.metadata, ['dm_visitor_id', 'visitor_id']) ?? ref?.[1];
    const elsewhere = await stripePaymentIsElsewhere(c.env.DB, site, {
      taggedSite: pickMeta(o.metadata, ['dm_site_id']),
      visitorId,
      customerId: str(o.customer),
    });
    if (elsewhere) return c.json({ ok: true, ignored: 'not this site\'s payment' });
    // A subscription's first invoice also arrives as invoice.paid; the same id makes them one payment.
    const id = ((o.mode === 'subscription' ? str(o.invoice) : str(o.payment_intent)) ?? String(o.id)).slice(0, 200);
    if (!(await takePayment(c.env, site, { id: `${site.id}:${id}` }))) return c.json(NOT_RECORDING);
    await recordPayment(c.env.DB, site, {
      id,
      provider: 'stripe',
      ts,
      amount: Number(o.amount_total) || 0,
      kind: 'payment',
      currency: String(o.currency ?? site.currency),
      visitorId,
      sessionId: pickMeta(o.metadata, ['dm_session_id', 'session_id']) ?? ref?.[2],
      customerId: str(o.customer),
      email: str(o.customer_details?.email)?.toLowerCase() ?? null,
      name: str(o.customer_details?.name),
      subscriptionId,
      checkoutId: str(o.id),
    });
  } else if (event.type === 'invoice.paid') {
    // One-time Checkout payments are counted above; here only subscription invoices (first payment and renewals).
    if (!String(o.billing_reason).startsWith('subscription') || !(Number(o.amount_paid) > 0)) {
      return c.json({ ok: true, ignored: 'not a subscription payment' });
    }
    const meta = { ...(o.parent?.subscription_details?.metadata as object), ...(o.subscription_details?.metadata as object), ...(o.metadata as object) };
    if (await stripePaymentIsElsewhere(c.env.DB, site, { taggedSite: pickMeta(meta, ['dm_site_id']), customerId: str(o.customer) })) {
      return c.json({ ok: true, ignored: 'not this site\'s payment' });
    }
    const id = String(o.id).slice(0, 200);
    if (!(await takePayment(c.env, site, { id: `${site.id}:${id}` }))) return c.json(NOT_RECORDING);
    await recordPayment(c.env.DB, site, {
      id,
      provider: 'stripe',
      ts,
      amount: Number(o.amount_paid),
      kind: 'payment',
      currency: String(o.currency ?? site.currency),
      customerId: str(o.customer),
      email: str(o.customer_email)?.toLowerCase() ?? null,
      name: str(o.customer_name),
      subscriptionId,
      renewal: o.billing_reason === 'subscription_cycle',
    });
  } else if (event.type === 'charge.refunded') {
    const original =
      (await c.env.DB.prepare('SELECT * FROM payments WHERE site_id = ? AND id IN (?, ?)')
        .bind(site.id, `${site.id}:${str(o.payment_intent) ?? ''}`, `${site.id}:${str(o.invoice) ?? ''}`)
        .first<{ id: string; visitor_id: string | null; session_id: string | null }>()) ??
      // Newer API versions don't link a charge to its invoice; fall back to the customer's latest payment.
      (await c.env.DB.prepare("SELECT * FROM payments WHERE site_id = ? AND customer_id = ? AND kind = 'payment' ORDER BY ts DESC LIMIT 1")
        .bind(site.id, str(o.customer) ?? '')
        .first<{ id: string; visitor_id: string | null; session_id: string | null }>());
    if (!original) return c.json({ ok: true, ignored: 'unknown payment' });
    const refundId = `${site.id}:${String(o.id).slice(0, 200)}:refund`;
    if (!(await takePayment(c.env, site, { id: refundId, refundOf: original.id }))) return c.json(NOT_RECORDING);
    // amount_refunded is the running total, so a second partial refund raises it. Stripe can deliver out of order: the
    // larger total is always the later one. The payment may have been matched to a visitor since, so its credit follows.
    await c.env.DB.prepare(
      `INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name)
       VALUES (?, ?, 'stripe', ?, ?, 'refund', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET amount = MIN(payments.amount, excluded.amount),
         ts = CASE WHEN excluded.amount < payments.amount THEN excluded.ts ELSE payments.ts END,
         visitor_id = COALESCE(excluded.visitor_id, payments.visitor_id), session_id = COALESCE(excluded.session_id, payments.session_id)
       WHERE payments.site_id = excluded.site_id`,
    )
      .bind(
        refundId,
        site.id,
        Date.now(),
        -Math.abs(Number(o.amount_refunded) || 0),
        String(o.currency ?? site.currency).toUpperCase(),
        original.visitor_id,
        original.session_id,
        cut(str(o.customer), 200),
        cut(str(o.billing_details?.email)?.toLowerCase(), 200),
        cut(str(o.billing_details?.name), 200),
      )
      .run();
  }
  // Every other event type is acknowledged so Stripe doesn't retry it.
  return c.json({ ok: true });
}

async function siteFromApiKey(c: Context<AppEnv>): Promise<SiteWithOwner | null> {
  const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!key) return null;
  return c.env.DB.prepare(`${SITE_WITH_OWNER_SQL} WHERE s.api_key = ?`)
    .bind(key)
    .first<SiteWithOwner>();
}

/**
 * Generic payments API, for any provider without a built-in integration.
 * POST /api/v1/payments  Authorization: Bearer <site api key>
 * { "transaction_id": "...", "amount": 29.99, "currency": "USD", "visitor_id": "<dm_vid cookie>", "email": "..." }
 */
export async function handlePaymentApi(c: Context<AppEnv>) {
  const site = await siteFromApiKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!b || !str(b.transaction_id) || typeof b.amount !== 'number') {
    return c.json({ error: 'transaction_id (string) and amount (number, e.g. 29.99) are required' }, 400);
  }
  if ((b.transaction_id as string).length > 150) return c.json({ error: 'transaction_id is longer than 150 characters' }, 400);
  const currency = (str(b.currency) ?? site.currency).slice(0, 10).toUpperCase();
  const minor = Math.round((b.amount as number) * 10 ** currencyDecimals(currency));
  const refunded = b.refunded === true;
  const paymentId = `${site.id}:${b.transaction_id}`;
  const id = refunded ? `${paymentId}:refund` : paymentId;
  if (!(await takePayment(c.env, site, { id, refundOf: refunded ? paymentId : undefined }))) {
    return c.json({ error: 'This website is not recording on its DataMonster plan. See Billing.' }, 402);
  }
  const res = await recordPayment(c.env.DB, site, {
    id,
    provider: 'api',
    ts: typeof b.timestamp === 'string' ? Date.parse(b.timestamp) || Date.now() : Date.now(),
    amount: refunded ? -Math.abs(minor) : minor,
    kind: refunded ? 'refund' : 'payment',
    currency,
    visitorId: str(b.visitor_id),
    sessionId: str(b.session_id),
    customerId: str(b.customer_id),
    email: str(b.email)?.toLowerCase() ?? null,
    name: str(b.name),
    renewal: b.renewal === true,
  });
  return c.json({ ok: true, attributed: !!res.sessionId, visitor_id: res.visitorId });
}

/**
 * Server-side goals (e.g. "signup" from your backend).
 * POST /api/v1/goals  { "visitor_id": "...", "name": "signup" }
 */
export async function handleGoalApi(c: Context<AppEnv>) {
  const site = await siteFromApiKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const vid = str(b?.visitor_id);
  const name = str(b?.name)?.slice(0, 64);
  if (!vid || !name) return c.json({ error: 'visitor_id and name are required' }, 400);
  const s = await c.env.DB.prepare(
    'SELECT id, exit_page FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 1',
  )
    .bind(site.id, vid)
    .first<{ id: string; exit_page: string }>();
  if (!s) return c.json({ error: 'visitor not found' }, 404);
  const now = Date.now();
  // The same plan rules as goals from the page: they count toward the owner's month, and stop with the plan.
  const stmts: D1PreparedStatement[] = [];
  const limits = await recordingLimits(c.env, site, now);
  if (!limits) return c.json({ error: 'This website is not recording on its DataMonster plan. See Billing.' }, 402);
  if (limits !== 'none' && site.owner_id) {
    const used = await c.env.DB.prepare('SELECT events FROM usage_monthly WHERE owner_id = ? AND month = ?').bind(site.owner_id, utcMonth(now)).first<{ events: number }>();
    if ((used?.events ?? 0) >= limits.hardEventLimit) return c.json({ error: 'This month\'s event limit is used up' }, 429);
    stmts.push(...bumpUsage(c.env.DB, site.owner_id, site.id, now));
  }
  await c.env.DB.batch([
    ...stmts,
    c.env.DB.prepare('UPDATE sessions SET goals = goals + 1 WHERE site_id = ? AND id = ?').bind(site.id, s.id),
    c.env.DB.prepare(
      "INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, 'goal', ?, ?, ?)",
    ).bind(site.id, s.id, vid, now, name, s.exit_page, b?.props ? JSON.stringify(b.props).slice(0, 1000) : null),
  ]);
  return c.json({ ok: true });
}
