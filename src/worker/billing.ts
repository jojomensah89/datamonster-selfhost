import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { isHosted, pickFreeSite, planLimits, PLAN_SLACK_MS, recordingPlan, siteAccessSql, utcMonth, type User } from './auth';
import { forgetOwnerSites, type AppEnv, type Env } from './env';
import { verifyStandardWebhook } from './lib/crypto';
import { memoryLimiter } from './lib/limits';

/** The Polar API version our requests and the webhook endpoint use. */
export const POLAR_VERSION = '2026-10';
const isSandbox = (env: Env) => env.POLAR_ENVIRONMENT === 'sandbox';
const canCheckout = (env: Env) => !!(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCT_ID);

/** Public plan info for the landing/pricing page. */
export async function planInfo(env: Env) {
  const hosted = isHosted(env);
  const price = env.PLAN_PRICE || '$5';
  const { eventLimit, siteLimit } = planLimits(env);
  const free = planLimits(env, 'free');
  const repo = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(env.DEPLOY_REPO_URL ?? '') ? env.DEPLOY_REPO_URL : null;
  return {
    hosted,
    interval: 'month',
    price,
    eventLimit,
    siteLimit,
    free: { eventLimit: free.eventLimit, siteLimit: free.siteLimit },
    deployUrl: repo ? `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repo)}` : null,
    supportEmail: env.SUPPORT_EMAIL || null,
    checkout: hosted && canCheckout(env),
  };
}

/** Calls Polar's API. Null when it fails for any reason; the reason is logged, never shown. `token` is a customer's own session. */
async function polarCall(env: Env, method: 'GET' | 'POST' | 'PATCH', path: string, body?: Record<string, unknown>, token = env.POLAR_ACCESS_TOKEN): Promise<{ status: number; data: Data } | null> {
  try {
    const res = await fetch(`https://${isSandbox(env) ? 'sandbox-api' : 'api'}.polar.sh${path}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'polar-version': POLAR_VERSION },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) return { status: res.status, data: ((await res.json().catch(() => null)) as Data | null) ?? {} };
    // A path can hold an id, never a token.
    console.error(`Polar ${path} answered ${res.status}`, (await res.text()).slice(0, 500));
  } catch (e) {
    console.error(`Polar ${path} failed`, e);
  }
  return null;
}
const polarPost = async (env: Env, path: string, body: Record<string, unknown>) => (await polarCall(env, 'POST', path, body))?.data ?? null;

/** A session that may only see and change this one customer, or null. */
async function customerSession(c: Context<AppEnv>): Promise<{ token: string | null; portal: string | null } | null> {
  if (!isHosted(c.env) || !c.env.POLAR_ACCESS_TOKEN) return null;
  const s = await polarPost(c.env, '/v1/customer-sessions/', { external_customer_id: c.get('user').id, return_url: `${new URL(c.req.url).origin}/billing` });
  return s && { token: str(s.token), portal: polarUrl(s.customer_portal_url) };
}

/** Only ever sends the customer to Polar itself. */
function polarUrl(raw: unknown): string | null {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' && (url.hostname === 'polar.sh' || url.hostname.endsWith('.polar.sh')) ? url.toString() : null;
  } catch {
    return null;
  }
}

// Each call makes a session at Polar, whose API is rate limited for everyone together.
const startsPerAccount = memoryLimiter(10, 60_000);
const failed = (c: Context<AppEnv>, what: 'checkout' | 'portal' | 'receipt') => c.redirect(`/billing?error=${what}`);

/** GET /api/billing/checkout: start a checkout for the signed-in account and send the browser to it. */
export async function checkout(c: Context<AppEnv>) {
  const user = c.get('user');
  if (!isHosted(c.env) || !canCheckout(c.env)) return c.json({ error: 'Billing is not configured yet' }, 503);
  if (user.paid) return c.redirect('/billing');
  if (!startsPerAccount(user.id)) return failed(c, 'checkout');
  const origin = new URL(c.req.url).origin;
  // If this site tracks itself with DataMonster, credit the purchase to the visit that led to it.
  const id = (name: string) => /^[\w-]{8,64}$/.exec(getCookie(c, name) ?? '')?.[0];
  const vid = id('dm_vid');
  const sid = id('dm_sid');
  const session = await polarPost(c.env, '/v1/checkouts/', {
    products: [c.env.POLAR_PRODUCT_ID],
    // Ties the subscription to this account. Set here, from the session, so the buyer can't change it.
    external_customer_id: user.id,
    ...(user.email ? { customer_email: user.email } : {}),
    ...(user.name ? { customer_name: user.name.slice(0, 200) } : {}),
    ...(c.req.header('cf-connecting-ip') ? { customer_ip_address: c.req.header('cf-connecting-ip') } : {}),
    metadata: { ...(vid ? { dm_visitor_id: vid } : {}), ...(sid ? { dm_session_id: sid } : {}) },
    // Polar fills in the id; the tracker on that page links the payment to the visitor even without metadata.
    success_url: `${origin}/billing?paid=1&checkout_id={CHECKOUT_ID}`,
    return_url: `${origin}/billing`,
  });
  const url = polarUrl(session?.url);
  return url ? c.redirect(url) : failed(c, 'checkout');
}

/** GET /api/billing/portal: Polar's page where a customer cancels, changes their card and finds invoices. */
export async function portal(c: Context<AppEnv>) {
  const user = c.get('user');
  if (!isHosted(c.env) || !c.env.POLAR_ACCESS_TOKEN) return c.json({ error: 'Billing is not configured yet' }, 503);
  // Someone who never paid has no page there, so Polar isn't asked.
  if (!(await pays(c, user)) || !startsPerAccount(user.id)) return failed(c, 'portal');
  const session = await customerSession(c);
  return session?.portal ? c.redirect(session.portal) : failed(c, 'portal');
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const time = (v: unknown) => {
  const t = Date.parse(str(v) ?? '');
  return Number.isFinite(t) ? t : null;
};

type Data = Record<string, any>;

// ---------- the billing page

/** GET /api/billing/usage: this month (UTC) by day and by website. */
export async function usage(c: Context<AppEnv>) {
  const user = c.get('user');
  if (!isHosted(c.env)) return c.json({ error: 'Billing is for hosted accounts' }, 404);
  const now = Date.now();
  const month = utcMonth(now);
  const today = new Date(now).getUTCDate();
  const access = siteAccessSql(c.env, user);
  const rows = user.admin
    ? // The owner's own sites have no limits, so nothing counts them; their stored events do.
      c.env.DB.prepare(`SELECT e.site_id, date(e.ts / 1000, 'unixepoch') AS day, COUNT(*) AS events FROM events e WHERE e.ts >= ? AND e.site_id IN (SELECT s.id FROM sites s WHERE ${access.sql}) GROUP BY 1, 2`).bind(Date.parse(`${month}-01`), ...access.params)
    : c.env.DB.prepare('SELECT site_id, day, events FROM usage_daily WHERE owner_id = ? AND day >= ?').bind(user.id, `${month}-01`);
  const [used, owned] = await c.env.DB.batch([rows, c.env.DB.prepare(`SELECT s.id, s.name, s.domain FROM sites s WHERE ${access.sql} ORDER BY s.created_at, s.id`).bind(...access.params)]);
  const sites = owned.results as { id: string; name: string; domain: string }[];
  // Free records one website; with more, the others are paused.
  const paused = !user.admin && recordingPlan(user.plan_until, now) === 'free' && sites.length > planLimits(c.env, 'free').siteLimit;
  const kept = paused ? await pickFreeSite(c.env.DB, user.id, now) : null;
  const days = Array.from({ length: today }, () => 0);
  const bySite = new Map<string, number>();
  for (const r of used.results as { site_id: string; day: string; events: number }[]) {
    const d = Number(r.day.slice(8));
    if (d <= today) days[d - 1] += r.events;
    bySite.set(r.site_id, (bySite.get(r.site_id) ?? 0) + r.events);
  }
  const counted = [...bySite.values()].reduce((a, b) => a + b, 0);
  const total = user.admin ? counted : Math.max(counted, user.events_used ?? 0);
  const list = sites.map((s) => ({ ...s, events: bySite.get(s.id) ?? 0, recording: !paused || s.id === kept }));
  return c.json({ month, total, days, sites: list, other: total - list.reduce((a, s) => a + s.events, 0) });
}

const looksPerAccount = memoryLimiter(20, 60_000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pays = (c: Context<AppEnv>, user: User) => c.env.DB.prepare('SELECT 1 FROM plan_subscriptions WHERE user_id = ? LIMIT 1').bind(user.id).first();

/** GET /api/billing/account: how this account pays, and what it has paid. Empty for one that never has. */
export async function account(c: Context<AppEnv>) {
  const user = c.get('user');
  if (!isHosted(c.env) || !(await pays(c, user))) return c.json({ method: null, orders: [] });
  if (!looksPerAccount(user.id)) return c.json({ error: 'Too many requests. Try again in a minute.' }, 429);
  const session = await customerSession(c);
  const get = async (path: string) => (session?.token ? ((await polarCall(c.env, 'GET', path, undefined, session.token))?.data ?? null) : null);
  const [me, methods, orders] = await Promise.all([
    get('/v1/customer-portal/customers/me'),
    get('/v1/customer-portal/customers/me/payment-methods?limit=20'),
    get(`/v1/customer-portal/orders/?limit=24&sorting=-created_at&product_id=${encodeURIComponent(c.env.POLAR_PRODUCT_ID ?? '')}`),
  ]);
  if (!Array.isArray(orders?.items)) return c.json({ error: "We couldn't load your payments." }, 502);
  const saved: Data[] = Array.isArray(methods?.items) ? methods.items : [];
  const m = saved.find((x) => x?.id === me?.default_payment_method_id) ?? saved[0];
  const meta = m?.method_metadata ?? {};
  const two = (n: unknown) => String(n).padStart(2, '0');
  return c.json({
    method: m
      ? {
          type: str(m.type) ?? 'card',
          brand: str(meta.brand),
          last4: /^\d{4}$/.test(String(meta.last4)) ? String(meta.last4) : null,
          expires: Number.isInteger(meta.exp_month) && Number.isInteger(meta.exp_year) ? `${two(meta.exp_month)}/${two(meta.exp_year % 100)}` : null,
        }
      : null,
    orders: (orders.items as Data[])
      .filter((o) => UUID.test(String(o?.id)))
      .map((o) => ({ id: o.id as string, at: time(o.created_at), amount: Number(o.total_amount) || 0, currency: (str(o.currency) ?? 'usd').toUpperCase(), status: str(o.status) ?? 'paid' })),
  });
}

const RECEIPT_TRIES = 5;

/** GET /api/billing/receipts/:id: the PDF for one payment. Polar draws it on first use, so the first ask may have to wait. */
export async function receipt(c: Context<AppEnv>) {
  const id = c.req.param('id') ?? '';
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  if (!(await pays(c, c.get('user'))) || !looksPerAccount(c.get('user').id)) return failed(c, 'receipt');
  const session = await customerSession(c);
  for (let i = 0; session?.token && i < RECEIPT_TRIES; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    const r = await polarCall(c.env, 'GET', `/v1/customer-portal/orders/${id}/receipt`, undefined, session.token);
    if (!r) break;
    const url = r.status === 200 ? receiptUrl(r.data.url) : null;
    if (url) return c.redirect(url);
    if (r.status !== 202) break;
  }
  return failed(c, 'receipt');
}

/** Receipts are files in Polar's storage. */
function receiptUrl(raw: unknown): string | null {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' && /(^|\.)(polar\.sh|amazonaws\.com)$/.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** POST /api/billing/cancel and /resume: whether the plan renews at the end of the month that is paid for. */
export const renewal = (renews: boolean) => async (c: Context<AppEnv>) => {
  const user = c.get('user');
  const db = c.env.DB;
  if (!looksPerAccount(user.id)) return c.json({ error: 'Too many requests. Try again in a minute.' }, 429);
  const sub = await db
    .prepare(`SELECT id FROM plan_subscriptions WHERE user_id = ? AND until > ? AND status IN (${renews ? "'cancelled'" : "'active', 'past_due'"}) ORDER BY until DESC LIMIT 1`)
    .bind(user.id, Date.now())
    .first<{ id: string }>();
  if (!sub || !UUID.test(sub.id)) return c.json({ error: renews ? 'There is no cancelled plan to keep.' : 'There is no plan to cancel.' }, 409);
  const session = await customerSession(c);
  const r = session?.token && (await polarCall(c.env, 'PATCH', `/v1/customer-portal/subscriptions/${sub.id}`, { cancel_at_period_end: !renews }, session.token));
  if (!r || r.data.id !== sub.id) return c.json({ error: "We couldn't reach the payment provider. Try again in a minute." }, 502);
  // The webhook says the same a moment later; this way the page is right at once.
  const changes = subscriptionChange(db, sub.id, user.id, r.data);
  if (changes.length) await db.batch([...changes, applyPlan(db, user.id)]);
  forgetOwnerSites(user.id);
  return c.json({ ok: true });
};

// ---------- what Polar tells us

/** POST /api/billing/webhook: Polar events for the plan product turn access on and off. */
export async function billingWebhook(c: Context<AppEnv>) {
  const secret = c.env.POLAR_WEBHOOK_SECRET?.trim();
  if (!secret) return c.json({ error: 'POLAR_WEBHOOK_SECRET is not set' }, 503);
  const body = await c.req.text();
  const headers = {
    id: c.req.header('webhook-id') ?? null,
    timestamp: c.req.header('webhook-timestamp') ?? null,
    signature: c.req.header('webhook-signature') ?? null,
  };
  // Polar's newer secrets follow Standard Webhooks; older ones use the whole secret text as the key.
  if (!(await verifyStandardWebhook(secret, headers, body)) && !(await verifyStandardWebhook(btoa(secret), headers, body))) {
    return c.json({ error: 'invalid signature' }, 401);
  }
  let event: { type?: unknown; data?: Data };
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const type = str(event?.type) ?? '';
  const d = event?.data ?? {};
  const isSubscription = type.startsWith('subscription.');
  if (!isSubscription && type !== 'order.paid' && type !== 'order.refunded') return c.json({ ok: true, ignored: 'event not used' });
  if (!c.env.POLAR_PRODUCT_ID) {
    console.warn('Billing event ignored: no plan product configured');
    return c.json({ ok: true, ignored: 'no plan product configured' });
  }
  if ((str(d.product_id) ?? str(d.product?.id)) !== c.env.POLAR_PRODUCT_ID) return c.json({ ok: true, ignored: 'other product' });
  const subId = isSubscription ? str(d.id) : str(d.subscription_id);
  if (!subId) return c.json({ ok: true, ignored: 'subscription required' });

  // A subscription belongs to the account it was first seen with. A new one belongs to the account our checkout started it
  // for; an email never chooses an account.
  const db = c.env.DB;
  const known = await db.prepare('SELECT user_id FROM plan_subscriptions WHERE id = ?').bind(subId).first<{ user_id: string }>();
  const external = str(d.customer?.external_id);
  const userId = known?.user_id ?? (external ? (await db.prepare('SELECT id FROM users WHERE id = ?').bind(external).first<{ id: string }>())?.id : undefined);
  if (!userId) {
    console.warn(`Billing event ${type} ignored: subscription is not tied to an account`);
    return c.json({ ok: true, ignored: 'no matching account' });
  }

  const changes = isSubscription
    ? subscriptionChange(db, subId, userId, d)
    : [...orderChange(db, subId, userId, d, type === 'order.refunded'), ...(type === 'order.paid' ? subscriptionChange(db, subId, userId, d.subscription ?? {}) : [])];
  if (!changes.length) return c.json({ ok: true, ignored: 'nothing to change' });
  // One batch, and the plan is worked out again every time, so a delivery that failed half-way is put right by its retry.
  await db.batch([...changes, applyPlan(db, userId)]);
  forgetOwnerSites(userId);
  return c.json({ ok: true });
}

/**
 * Every subscription event carries the whole subscription, so what counts is its state, not the event's name. Deliveries
 * can be late, repeated or out of order: only a state at least as new as the one we have is used, and an ended
 * subscription never comes back (Polar starts a new one).
 */
function subscriptionChange(db: D1Database, subId: string, userId: string, d: Data, now = Date.now()): D1PreparedStatement[] {
  const sourceAt = time(d.modified_at) ?? time(d.created_at);
  const periodEnd = time(d.current_period_end) ?? time(d.ends_at);
  if (sourceAt === null) return [];
  const write = (status: string, until: number, insertUntil: number, sql: string) => [
    db
      .prepare(
        `INSERT INTO plan_subscriptions (id, user_id, status, until, source_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, until = ${sql}, source_at = excluded.source_at, updated_at = excluded.updated_at
         WHERE excluded.source_at >= plan_subscriptions.source_at AND plan_subscriptions.status != 'expired'`,
      )
      .bind(subId, userId, status, insertUntil, sourceAt, now, until),
  ];
  switch (d.status) {
    case 'active':
    case 'trialing': {
      if (periodEnd === null) return [];
      // Cancelled: access runs to the end of the period that was paid for.
      if (d.cancel_at_period_end === true) {
        const ends = time(d.ends_at) ?? periodEnd;
        return write('cancelled', ends, ends, '?');
      }
      return write('active', periodEnd + PLAN_SLACK_MS, periodEnd + PLAN_SLACK_MS, '?');
    }
    case 'past_due': {
      // The period has already moved on to the one that wasn't paid for, so it can't be what counts here.
      const until = (time(d.past_due_at) ?? sourceAt) + PLAN_SLACK_MS;
      return write('past_due', until, until, 'MIN(until, ?)');
    }
    case 'paused':
    case 'unpaid':
      return write(d.status, now, 0, 'MIN(until, ?)');
    case 'canceled':
    case 'incomplete_expired':
    case 'trial_ended':
      return write('expired', now, 0, 'MIN(until, ?)');
    default: // incomplete: a checkout that hasn't been paid is not a plan
      return [];
  }
}

/**
 * Which payment is the newest, and whether it was refunded in full. Only the newest order counts, so an old refund or a
 * late copy changes nothing, and only a newer payment lifts a refund.
 */
function orderChange(db: D1Database, subId: string, userId: string, d: Data, refund: boolean, now = Date.now()): D1PreparedStatement[] {
  const orderId = str(d.id);
  const at = time(d.created_at);
  if (!orderId || at === null) return [];
  if (refund ? d.status !== 'refunded' : d.status !== 'paid' && d.paid !== true) return []; // a partial refund keeps the plan
  return [
    db
      .prepare(
        `INSERT INTO plan_subscriptions (id, user_id, status, until, payment_id, payment_at, refunded_at, updated_at) VALUES (?, ?, 'incomplete', 0, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET payment_id = excluded.payment_id, payment_at = excluded.payment_at, updated_at = excluded.updated_at,
           refunded_at = CASE WHEN excluded.refunded_at IS NULL THEN NULL ELSE COALESCE(plan_subscriptions.refunded_at, excluded.refunded_at) END
         WHERE ${refund ? 'excluded.payment_at >= plan_subscriptions.payment_at' : 'excluded.payment_at >= plan_subscriptions.payment_at AND plan_subscriptions.payment_id IS NOT excluded.payment_id'}`,
      )
      .bind(subId, userId, orderId, at, refund ? now : null, now),
  ];
}

/** The account's plan is its best subscription: one still renewing if there is one, otherwise whichever lasts longest. */
function applyPlan(db: D1Database, userId: string, now = Date.now()) {
  return db
    .prepare(
      `WITH subs AS (
         SELECT CASE WHEN refunded_at IS NULL THEN status ELSE 'refunded' END AS status,
                CASE WHEN refunded_at IS NULL THEN until ELSE MIN(until, refunded_at) END AS until, updated_at
         FROM plan_subscriptions WHERE user_id = ?),
       best AS (SELECT status FROM subs ORDER BY (status = 'active' AND until > ?) DESC, until DESC, updated_at DESC LIMIT 1)
       UPDATE users SET plan = 'monthly', plan_status = (SELECT status FROM best), plan_until = (SELECT MAX(until) FROM subs),
         paid_at = CASE WHEN (SELECT status FROM best) = 'active' THEN COALESCE(paid_at, ?) ELSE paid_at END,
         -- On Pro every website records. Which one Free would keep is worked out again when that day comes.
         free_site_id = CASE WHEN (SELECT MAX(until) FROM subs) > ? THEN NULL ELSE free_site_id END
       -- Without a single subscription that was ever a plan (a first payment that failed), there is nothing to apply.
       WHERE id = ? AND (SELECT MAX(until) FROM subs) > 0`,
    )
    .bind(userId, now, now, now, userId);
}
