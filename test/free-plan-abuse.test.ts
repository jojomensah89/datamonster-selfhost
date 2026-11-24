import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToken } from '../src/agent/tokens';
import { createSession, recordingLimits } from '../src/worker/auth';
import { cacheSizes, forgetAllSites, getSite, type Env } from '../src/worker/env';
import app from '../src/worker/index';
import { makeD1 } from './helpers/d1';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const DAY = 86_400_000;
/** The per-account limits live in memory, so every test is its own account. */
let run = 0;

function setup(o: Record<string, string> = {}) {
  const db = makeD1();
  forgetAllSites();
  const me = 'free' + ++run;
  db.raw.exec(
    `INSERT INTO users (id,email,created_at,plan_status) VALUES ('${me}','f@example.com',0,'none'),('other','o@example.com',0,'none');
     INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at,owner_id,stripe_webhook_secret,dodo_webhook_secret) VALUES ('sitefree1','F','f.example.com','UTC','USD','kf',1,'${me}','whsec_s','whsec_ZA=='),('siteothr1','O','o.example.com','UTC','USD','ko',1,'other',NULL,NULL)`,
  );
  const env = { DB: db.d1, SESSION_SECRET: 's', ADMIN_PASSWORD: 'p', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g', POLAR_ACCESS_TOKEN: 't', POLAR_PRODUCT_ID: 'prod', ...o } as unknown as Env;
  const call = (p: string, i: RequestInit = {}) => app.request('https://dm.test' + p, i, env, { waitUntil() {} } as never);
  const as = async (id: string, p: string, method = 'GET', json?: unknown) =>
    call(p, { method, headers: { cookie: 'dm_auth=' + (await createSession(env, 'u:' + (id === 'free' ? me : id))) }, body: json === undefined ? undefined : JSON.stringify(json) });
  const n = (q: string) => Number((db.raw.prepare('SELECT COUNT(*) AS n FROM ' + q).get() as { n: number }).n);
  const stripe = (o2: unknown) => {
    const body = JSON.stringify(o2);
    const ts = Math.floor(Date.now() / 1000);
    return call('/api/webhooks/stripe/sitefree1', { method: 'POST', body, headers: { 'stripe-signature': `t=${ts},v1=${createHmac('sha256', 'whsec_s').update(`${ts}.${body}`).digest('hex')}` } });
  };
  const dodo = (o2: unknown) => {
    const body = JSON.stringify(o2);
    const ts = String(Math.floor(Date.now() / 1000));
    return call('/api/webhooks/dodo/sitefree1', { method: 'POST', body, headers: { 'webhook-id': 'e', 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + createHmac('sha256', Buffer.from('ZA==', 'base64')).update(`e.${ts}.${body}`).digest('base64') } });
  };
  return { me, db, env, call, as, n, stripe, dodo };
}

describe('a hostile Free account', () => {
  it('1 cannot grow the agent log without end', async () => {
    const t = setup();
    const { secret } = await createToken(t.db.d1, t.me, { name: 'x' });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 24, 1) });
    let last = 200;
    for (let m = 0; m < 12; m++) {
      vi.setSystemTime(Date.now() + 60_000);
      for (let i = 0; i < 200; i++) last = (await t.call('/api/agent/v1/list_sites', { headers: { authorization: 'Bearer ' + secret } })).status;
    }
    expect([last, t.n('agent_audit') <= 1000]).toEqual([429, true]);
    vi.setSystemTime(Date.UTC(2026, 10, 25, 1));
    expect((await t.call('/api/agent/v1/list_sites', { headers: { authorization: 'Bearer ' + secret } })).status).toBe(200);
  }, 60_000);
  it('2 cannot store a quarter of a megabyte in one payment', async () => {
    const t = setup();
    const big = 'x'.repeat(200_000);
    await t.call('/api/v1/payments', { method: 'POST', headers: { authorization: 'Bearer kf' }, body: JSON.stringify({ transaction_id: 'a', amount: 1, name: big, email: big, customer_id: big, visitor_id: 'visitor-1' }) });
    await t.dodo({ type: 'payment.succeeded', data: { payment_id: 'p', total_amount: 1, currency: 'USD', customer: { name: big, email: big }, product_cart: [{ product_id: 'pdt_' + big }], metadata: { dm_visitor_id: big } } });
    for (const [table, sum] of [['payments', "LENGTH(id)+LENGTH(COALESCE(name,''))+LENGTH(COALESCE(email,''))+LENGTH(COALESCE(customer_id,''))"], ['pending_payments', 'LENGTH(payload)+LENGTH(product_id)'], ['visitors', "LENGTH(id)+LENGTH(COALESCE(name,''))+LENGTH(COALESCE(email,''))"]])
      expect([table, Number((t.db.raw.prepare(`SELECT COALESCE(MAX(${sum}),0) AS n FROM ${table}`).get() as { n: number }).n) < 6000]).toEqual([table, true]);
    const long = await t.call('/api/v1/payments', { method: 'POST', headers: { authorization: 'Bearer kf' }, body: JSON.stringify({ transaction_id: big, amount: 1 }) });
    expect(long.status).toBe(400);
  });
  it('3 keeps its payment allowance for payments', async () => {
    const t = setup({ FREE_EVENT_LIMIT: '2' });
    for (let i = 0; i < 4; i++) {
      await t.stripe({ type: 'customer.updated', data: { object: {} } });
      await t.dodo({ type: 'subscription.active', data: {} });
    }
    await t.stripe({ type: 'checkout.session.completed', data: { object: { id: 'cs', payment_status: 'paid', payment_intent: 'pi', amount_total: 500, currency: 'usd', created: Date.now() / 1000 } } });
    expect(t.n('payments')).toBe(1);
  });
  it('4 cannot make agent tokens without end', async () => {
    const t = setup();
    for (let i = 0; i < 300; i++) {
      const r = (await (await t.as('free', '/api/agent-tokens', 'POST', { name: 'x' })).json()) as { token?: { id: string } };
      if (r.token) await t.as('free', '/api/agent-tokens/' + r.token.id, 'DELETE');
    }
    expect(t.n('agent_tokens')).toBeLessThanOrEqual(100);
  }, 60_000);
  it('5 cannot pass the website limit by asking at the same moment', async () => {
    const t = setup();
    t.db.raw.exec(`DELETE FROM sites WHERE owner_id = '${t.me}'`);
    await Promise.all(Array.from({ length: 8 }, (_, i) => t.as('free', '/api/sites', 'POST', { domain: `s${i}.example.com` })));
    expect(t.n(`sites WHERE owner_id = '${t.me}'`)).toBe(1);
  });
  it('6 does not reach Polar before it has ever paid', async () => {
    const t = setup();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{}', { status: 422 });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await t.as('free', '/api/billing/receipts/22222222-2222-4222-8222-222222222222');
    await t.as('free', '/api/billing/portal');
    expect(calls).toBe(0);
  });
  it('7 cannot have pages fetched without a pause by making and removing launches', async () => {
    const t = setup();
    let fetched = 0;
    vi.stubGlobal('fetch', async () => {
      fetched++;
      return new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } });
    });
    for (let i = 0; i < 60; i++) {
      const p = (await (await t.as('free', '/api/sites/sitefree1/placements', 'POST', { name: 'n' + i, listing_url: 'https://example.org/' + i, match_source: 'n' + i })).json()) as { placement: { id: string } };
      await t.as('free', `/api/sites/sitefree1/placements/${p.placement.id}/verify`, 'POST', {});
    }
    expect([fetched > 0, fetched <= 20]).toEqual([true, true]);
  }, 30_000);
  it('8 is paused by the same rule whatever the limits are set to', async () => {
    const t = setup({ FREE_SITE_LIMIT: '2' });
    t.db.raw.exec(`INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at,owner_id) VALUES ('sitefree2','G','g.example.com','UTC','USD','k2',2,'${t.me}'),('sitefree3','H','h.example.com','UTC','USD','k3',3,'${t.me}')`);
    const on: string[] = [];
    for (const s of ['sitefree1', 'sitefree2', 'sitefree3']) if (await recordingLimits(t.env, (await getSite(t.db.d1, s))!)) on.push(s);
    const u = ((await (await t.as('free', '/api/auth/me')).json()) as { user: { sites_limit: number } }).user;
    expect(on.length).toBe(u.sites_limit);
  });
  it('9 is told when a refunded plan still renews, so it can be stopped', async () => {
    const t = setup();
    t.db.raw.exec(`INSERT INTO plan_subscriptions (id,user_id,status,until,source_at,updated_at,refunded_at) VALUES ('11111111-1111-4111-8111-111111111111','${t.me}','active',${Date.now() + 20 * DAY},1,1,${Date.now()}); UPDATE users SET plan='monthly', plan_status='refunded', plan_until=${Date.now() - 1} WHERE id='${t.me}'`);
    const u = ((await (await t.as('free', '/api/auth/me')).json()) as { user: Record<string, unknown> }).user;
    expect([u.paid, u.renewing]).toEqual([false, true]);
  });
  it("10 cannot empty everyone's site cache", async () => {
    const t = setup();
    await getSite(t.db.d1, 'siteothr1');
    await getSite(t.db.d1, 'sitefree1');
    await t.as('free', '/api/sites/sitefree1', 'DELETE');
    expect(cacheSizes().sites).toBe(1);
  });
  it('11 has its sites counted through an index', () => {
    const t = setup();
    const plan = t.db.raw.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM sites WHERE owner_id = 'x'").all().map((r) => String((r as { detail: string }).detail)).join();
    expect(plan).toMatch(/INDEX/);
  });
  it('12 sees nothing of another customer on the new routes', async () => {
    const t = setup();
    const u = (await (await t.as('free', '/api/billing/usage')).json()) as { sites: { id: string }[] };
    expect(u.sites.map((s) => s.id)).toEqual(['sitefree1']);
    expect((await t.as('free', '/api/sites/siteothr1')).status).toBe(404);
    for (const p of ['/api/billing/usage', '/api/billing/account', '/api/billing/receipts/22222222-2222-4222-8222-222222222222']) expect((await t.call(p)).status).toBe(401);
    expect(JSON.stringify(await (await t.as('free', '/api/sites')).json())).not.toMatch(/owner_email|owner_plan|free_site/);
  });
  it('13 cannot read the webhook secrets or plan of a site through a provider route', async () => {
    const t = setup();
    expect(JSON.stringify(await (await t.as('free', '/api/sites/sitefree1/providers')).json())).not.toMatch(/whsec|owner_/);
    expect((await t.as('free', '/api/sites/siteothr1/providers')).status).toBe(404);
  });
});
