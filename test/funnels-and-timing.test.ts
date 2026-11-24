import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import app from '../src/worker/index';
import { createSession } from '../src/worker/auth';
import { funnel } from '../src/worker/stats';
import { makeD1 } from './helpers/d1';

let db: ReturnType<typeof makeD1>;
const polarSecret = 'whsec_' + Buffer.from('polar-timing-secret').toString('base64');
const env = () => ({ DB: db.d1, SESSION_SECRET: 'session', ADMIN_PASSWORD: 'pw' });

async function authCookie() {
  return 'dm_auth=' + (await createSession(env() as never, 'admin'));
}

beforeEach(() => {
  db = makeD1();
  db.raw
    .prepare(
      "INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at,polar_webhook_secret) VALUES ('site-1','Site','example.com','UTC','USD','key',0,?)",
    )
    .run(polarSecret);
});

describe('payment funnel steps and revenue per step', () => {
  const from = Date.UTC(2026, 10, 1);
  const to = Date.UTC(2026, 10, 30);

  const site = {
    id: 'site-1',
    name: 'Site',
    domain: 'example.com',
    timezone: 'UTC',
    currency: 'USD',
    api_key: 'key',
    dodo_webhook_secret: null,
    created_at: 0,
  };

  it('tracks ordered page -> goal -> payment progression and attributes site-currency revenue per step', async () => {
    const t0 = Date.UTC(2026, 10, 10, 10, 0);
    // v1: / -> /pricing -> payment ($50 USD + €20 EUR excluded)
    // v2: / -> /pricing -> (no payment)
    // v3: / -> (drops off)
    // v4: payment BEFORE /pricing (should not advance to step 3 because payment happened before /pricing)
    for (const [vid, src] of [
      ['v1', 'X'],
      ['v2', 'X'],
      ['v3', 'Google'],
      ['v4', 'X'],
    ]) {
      db.raw.prepare('INSERT INTO visitors (site_id,id,first_seen) VALUES (?,?,?)').run('site-1', vid, t0);
      db.raw
        .prepare("INSERT INTO sessions (site_id,id,visitor_id,started_at,last_seen_at,source,channel) VALUES (?,?,?,?,?,?,'Social')")
        .run('site-1', `s-${vid}`, vid, t0, t0 + 1000, src);
    }

    const addEvent = (vid: string, ts: number, type: string, name: string | null, path: string) =>
      db.raw
        .prepare('INSERT INTO events (site_id,session_id,visitor_id,ts,type,name,path) VALUES (?,?,?,?,?,?,?)')
        .run('site-1', `s-${vid}`, vid, ts, type, name, path);

    addEvent('v1', t0 + 1000, 'pageview', null, '/');
    addEvent('v1', t0 + 2000, 'pageview', null, '/pricing');
    addEvent('v2', t0 + 1000, 'pageview', null, '/');
    addEvent('v2', t0 + 2000, 'pageview', null, '/pricing');
    addEvent('v3', t0 + 1000, 'pageview', null, '/');
    addEvent('v4', t0 + 1000, 'pageview', null, '/');
    addEvent('v4', t0 + 5000, 'pageview', null, '/pricing');

    const addPay = (id: string, vid: string, ts: number, amount: number, currency = 'USD', kind = 'payment', productId: string | null = 'prod_pro') =>
      db.raw
        .prepare(
          'INSERT INTO payments (id,site_id,provider,ts,amount,kind,currency,visitor_id,session_id,product_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(id, 'site-1', 'stripe', ts, amount, kind, currency, vid, `s-${vid}`, productId);

    addPay('p1', 'v1', t0 + 3000, 5000, 'USD', 'payment', 'prod_pro');
    addPay('p1_eur', 'v1', t0 + 3100, 2000, 'EUR', 'payment', 'prod_pro');
    addPay('p4_early', 'v4', t0 + 2000, 3000, 'USD', 'payment', 'prod_basic');

    const steps = await funnel(
      { db: db.d1, site, range: { from, to, granularity: 'day' }, filters: {}, offset: 0 },
      [
        { type: 'page', value: '/' },
        { type: 'page', value: '/pricing' },
        { type: 'payment', value: 'any' },
      ],
    );

    expect(steps).toEqual([
      { type: 'page', value: '/', visitors: 4, revenue: 8000 },
      { type: 'page', value: '/pricing', visitors: 3, revenue: 8000 },
      { type: 'payment', value: 'any', visitors: 1, revenue: 5000 },
    ]);

    // Product-specific payment step
    const prodSteps = await funnel(
      { db: db.d1, site, range: { from, to, granularity: 'day' }, filters: {}, offset: 0 },
      [
        { type: 'page', value: '/' },
        { type: 'payment', value: 'prod_basic' },
      ],
    );
    expect(prodSteps[1]).toMatchObject({ visitors: 1, revenue: 3000 });
  });

  it('allows creating a funnel with a payment step via POST /api/sites/:id/funnels', async () => {
    const res = await app.request(
      '/api/sites/site-1/funnels',
      {
        method: 'POST',
        headers: { cookie: await authCookie(), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Checkout funnel',
          steps: [
            { type: 'page', value: '/' },
            { type: 'payment', value: '' },
          ],
        }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; steps: { type: string; value: string }[] };
    expect(body.steps).toEqual([
      { type: 'page', value: '/' },
      { type: 'payment', value: 'any' },
    ]);
  });
});

describe('Polar checkout timing fallback attribution', () => {
  it.each(['https://buy.polar.sh/polar_cl_abc', 'https://polar.sh/checkout/polar_cl_xyz'])(
    'attributes an untagged Polar order via outbound checkout click timing (%s)',
    async (checkoutUrl) => {
      const now = Date.now();
      db.raw.prepare('INSERT INTO visitors (site_id,id,first_seen) VALUES (?,?,?)').run('site-1', 'v-polar', now - 60_000);
      db.raw
        .prepare("INSERT INTO sessions (site_id,id,visitor_id,started_at,last_seen_at,source,channel) VALUES (?,?,?,?,?,'X','Organic Social')")
        .run('site-1', 's-polar', 'v-polar', now - 60_000, now - 10_000);
      db.raw
        .prepare("INSERT INTO events (site_id,session_id,visitor_id,ts,type,name,path) VALUES (?,?,?,?,'outbound',?,?)")
        .run('site-1', 's-polar', 'v-polar', now - 15_000, checkoutUrl, '/pricing');

      const payload = {
        type: 'order.paid',
        timestamp: new Date(now).toISOString(),
        data: {
          id: 'order-timing-1',
          created_at: new Date(now).toISOString(),
          status: 'paid',
          paid: true,
          total_amount: 1900,
          currency: 'usd',
          customer_id: 'cust-timing-1',
          metadata: {},
          customer: { email: 'timing@example.com', name: 'Timing Buyer' },
        },
      };
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(now / 1000));
      const sig = createHmac('sha256', Buffer.from(polarSecret.slice(6), 'base64'))
        .update(`msg_timing.${ts}.${body}`)
        .digest('base64');

      const res = await app.request(
        '/api/webhooks/polar/site-1',
        {
          method: 'POST',
          headers: {
            'webhook-id': 'msg_timing',
            'webhook-timestamp': ts,
            'webhook-signature': `v1,${sig}`,
          },
          body,
        },
        env(),
      );
      expect(res.status).toBe(200);
      const payment = db.raw.prepare('SELECT visitor_id, session_id, matched_by FROM payments WHERE site_id = ?').get('site-1') as {
        visitor_id: string | null;
        session_id: string | null;
        matched_by: string | null;
      };
      expect(payment).toEqual({ visitor_id: 'v-polar', session_id: 's-polar', matched_by: 'timing' });
    },
  );
});
