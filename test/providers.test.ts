import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import app from '../src/worker/index';
import { makeD1 } from './helpers/d1';
import { createSession } from '../src/worker/auth';

let db: ReturnType<typeof makeD1>;
const secret = 'whsec_' + Buffer.from('fixture-secret').toString('base64');
const lemonSecret = 'lemon-fixture-secret';
const env = () => ({ DB: db.d1, SESSION_SECRET: 'session', ADMIN_PASSWORD: 'pw' });
const rows = () => db.raw.prepare('SELECT * FROM payments ORDER BY id').all();
function polar(type = 'order.paid', overrides = {}) {
  return { type, timestamp: new Date().toISOString(), data: { id: 'order-1', created_at: new Date().toISOString(), modified_at: new Date().toISOString(), status: 'paid', paid: true, total_amount: 1200, refunded_amount: 300, refunded_tax_amount: 20, currency: 'usd', customer_id: 'customer-1', checkout_id: 'checkout-1', subscription_id: 'sub-1', metadata: { dm_visitor_id: 'visitor-1' }, customer: { email: 'BUYER@example.com', name: 'Buyer' }, ...overrides } };
}
async function deliver(provider: string, event: unknown, options: { timestamp?: number; invalid?: boolean; site?: string; legacy?: boolean } = {}) {
  const body = JSON.stringify(event), timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'webhook-id': 'delivery-1',
    'webhook-timestamp': timestamp,
    'webhook-signature': 'v1,' + createHmac('sha256', options.legacy ? Buffer.from(secret) : Buffer.from(secret.slice(6), 'base64')).update(`delivery-1.${timestamp}.${body}`).digest('base64'),
  };
  if (options.invalid) for (const key of Object.keys(headers)) if (key.includes('ignature')) headers[key] += 'bad';
  return app.request(`/api/webhooks/${provider}/${options.site ?? 'site-1'}`, { method: 'POST', headers, body }, env());
}
beforeEach(() => {
  db = makeD1();
  db.raw.prepare("INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at,polar_webhook_secret,lemonsqueezy_webhook_secret) VALUES ('site-1','Site','example.com','UTC','USD','key',0,?,?)").run(secret, lemonSecret);
  db.raw.prepare("INSERT INTO visitors (site_id,id,first_seen) VALUES ('site-1','visitor-1',0)").run();
  db.raw.prepare("INSERT INTO sessions (site_id,id,visitor_id,started_at,last_seen_at,source,channel) VALUES ('site-1','session-1','visitor-1',0,0,'X','Social')").run();
});
describe('polar', () => {
  it('verifies signatures, attributes metadata and deduplicates redelivery', async () => {
    expect((await deliver('polar', polar())).status).toBe(200);
    expect((await deliver('polar', polar())).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ provider: 'polar', amount: 1200, currency: 'USD', visitor_id: 'visitor-1', session_id: 'session-1', matched_by: 'metadata', email: 'buyer@example.com' });
  });
  it('rejects invalid signatures without writes', async () => {
    expect((await deliver('polar', polar(), { invalid: true })).status).toBe(401);
    expect(rows()).toHaveLength(0);
  });
  it('returns 404 for unknown sites', async () => {
    expect((await deliver('polar', polar(), { site: 'missing' })).status).toBe(404);
  });
  it('ignores unrelated events', async () => {
    expect((await deliver('polar', polar('customer.updated'))).status).toBe(200);
    expect(rows()).toHaveLength(0);
  });
  it('maps renewals to the original customer without metadata', async () => {
    await deliver('polar', polar());
    const renewal = polar('order.paid', { id: 'order-2', metadata: {}, billing_reason: 'subscription_cycle' });
    await deliver('polar', renewal);
    expect(rows().find(r => r.renewal === 1)).toMatchObject({ amount: 1200, visitor_id: 'visitor-1', matched_by: 'customer' });
  });
  it('records cumulative partial refunds once and tolerates stale redelivery', async () => {
    await deliver('polar', polar());
    const refund = (amount: number) => polar('order.refunded', { refunded_amount: amount, refunded_tax_amount: 0 });
    for (const amount of [300, 300, 800, 300]) expect((await deliver('polar', refund(amount))).status).toBe(200);
    expect(rows()).toHaveLength(2);
    expect(rows().find(r => r.kind === 'refund')).toMatchObject({ amount: -800, renewal: 0 });
  });
});
it.each([-301, 301])('rejects Polar timestamps outside tolerance (%s)', async offset => {
  expect((await deliver('polar', polar(), { timestamp: Math.floor(Date.now() / 1000) + offset })).status).toBe(401);
});
it('accepts legacy Polar signing secrets', async () => { expect((await deliver('polar', polar(), { legacy: true })).status).toBe(200); });
it('reads Polar customer metadata and link reference metadata', async () => {
  await deliver('polar', polar('order.paid', { metadata: { reference_id: 'dm_visitor-1' } }));
  await deliver('polar', polar('order.paid', { id: 'order-2', metadata: {}, customer_metadata: { visitor_id: 'visitor-1' } }));
  expect(rows().every(r => r.matched_by === 'metadata')).toBe(true);
});
it('matches Polar checkout claims', async () => {
  db.raw.prepare("INSERT INTO payment_claims (site_id,payment_id,visitor_id,ts) VALUES ('site-1','checkout-1','visitor-1',0)").run();
  await deliver('polar', polar('order.paid', { metadata: {} }));
  expect(rows()[0]).toMatchObject({ matched_by: 'return_page' });
});
async function owner(method: string, body?: unknown, cookie?: string, hosted = false) {
  return app.request('/api/sites/site-1/providers', { method, headers: { cookie: cookie ?? '', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { ...env(), ...(hosted ? { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' } : {}) } as never);
}
async function cookie(subject = 'admin') { return 'dm_auth=' + await createSession(env() as never, subject); }
it('requires owner authentication for GET and PATCH', async () => {
  expect((await owner('GET')).status).toBe(401);
  expect((await owner('PATCH', { polar_webhook_secret: null })).status).toBe(401);
});
it('masks secrets, updates and clears independently', async () => {
  const auth = await cookie();
  const res = await owner('PATCH', { polar_webhook_secret: 'new-secret' }, auth);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ polar_webhook_secret: '********', connected: { polar: true }, last_payment: { dodo: null, stripe: null, polar: null } });
  expect((await owner('PATCH', { polar_webhook_secret: null }, auth)).status).toBe(200);
  expect(await (await owner('GET', undefined, auth)).json()).toMatchObject({ connected: { polar: false } });
});
it('refuses hosted cross-account access', async () => {
  db.raw.prepare("INSERT INTO users (id,email,created_at,plan_status,plan_until) VALUES ('other','other@example.com',0,'active',9999999999999)").run();
  db.raw.prepare("UPDATE sites SET owner_id = 'owner' WHERE id = 'site-1'").run();
  const auth = await cookie('u:other');
  expect((await owner('GET', undefined, auth, true)).status).toBe(404);
  expect((await owner('PATCH', { polar_webhook_secret: null }, auth, true)).status).toBe(404);
  expect(db.raw.prepare('SELECT polar_webhook_secret FROM sites').get()?.polar_webhook_secret).toBe(secret);
});
it('reports the newest payment per provider so a saved secret is not shown as a received webhook', async () => {
  const auth = await cookie();
  expect(await (await owner('GET', undefined, auth)).json()).toMatchObject({ last_payment: { polar: null, stripe: null, dodo: null } });
  expect((await deliver('polar', polar())).status).toBe(200);
  const ts = (db.raw.prepare("SELECT MAX(ts) AS ts FROM payments WHERE provider = 'polar'").get() as { ts: number }).ts;
  db.raw.prepare("INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at) VALUES ('site-2','Other','other.com','UTC','USD','key2',0)").run();
  db.raw.prepare("INSERT INTO payments (id,site_id,provider,ts,amount,currency) VALUES ('p-other','site-2','stripe',5,100,'USD')").run();
  const body = await (await owner('GET', undefined, auth)).json() as { last_payment: Record<string, number | null> };
  expect(body.last_payment).toEqual({ dodo: null, stripe: null, polar: ts });
});
it('rejects invalid updates atomically', async () => {
  expect((await owner('PATCH', { polar_webhook_secret: null, lemonsqueezy_webhook_secret: 'x' }, await cookie())).status).toBe(400);
  expect(db.raw.prepare('SELECT polar_webhook_secret FROM sites').get()?.polar_webhook_secret).toBe(secret);
});

it('never exposes provider secrets through existing site responses', async () => {
  for (const path of ['/api/sites', '/api/sites/site-1']) {
    const res = await app.request(path, { headers: { cookie: await cookie() } }, env());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain(lemonSecret);
  }
});
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

it('tags supported checkout URLs and preserves Stripe/Dodo and custom Polar references', () => {
  const source = readFileSync('public/js/script.js', 'utf8');
  const start = source.indexOf('  function tagCheckoutLink(a)');
  const end = source.indexOf('  function tagCheckoutLinks()', start);
  const tag = runInNewContext(source.slice(start, end) + '; tagCheckoutLink', {
    URL, attribution: () => ({ dm_visitor_id: 'vid', dm_session_id: 'sid' }),
  });
  const check = (href: string, key: string, value: string | null) => {
    const a = { href }; tag(a); expect(new URL(a.href).searchParams.get(key)).toBe(value);
  };
  check('https://buy.polar.sh/abc?x=1', 'reference_id', 'dm_vid');
  check('https://polar.sh/checkout/abc', 'reference_id', 'dm_vid');
  check('https://buy.polar.sh/abc?reference_id=customer', 'reference_id', 'customer');
  check('https://shop.lemonsqueezy.com/buy/abc', 'checkout[custom][dm_visitor_id]', null);
  check('https://checkout.dodopayments.com/buy/abc', 'metadata_dm_visitor_id', 'vid');
  check('https://buy.stripe.com/abc', 'client_reference_id', 'dm_vid__sid');
  check('https://buy.stripe.com/abc?client_reference_id=custom', 'client_reference_id', 'custom');
});
