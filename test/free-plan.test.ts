import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToken } from '../src/agent/tokens';
import { createSession, pickFreeSite, planLimits, recordingPlan, utcMonth } from '../src/worker/auth';
import { forgetAllSites, type Env } from '../src/worker/env';
import app from '../src/worker/index';
import { makeD1 } from './helpers/d1';

const DAY = 86_400_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
const SUB = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(overrides: Partial<Env> = {}) {
  const db = makeD1();
  forgetAllSites();
  const future = Date.now() + 20 * DAY;
  db.raw.exec(
    `INSERT INTO users (id, email, created_at, plan, plan_status, plan_until) VALUES ('free', 'f@example.com', 0, NULL, 'none', NULL), ('pro', 'p@example.com', 0, 'monthly', 'active', ${future}), ('adm', 'admin@example.com', 0, NULL, 'none', NULL);
     INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES
       ('sitefree1', 'F1', 'f1.example.com', 'UTC', 'USD', 'kf1', 1, 'free'), ('sitepro1', 'P1', 'p1.example.com', 'UTC', 'USD', 'kp1', 1, 'pro'), ('sitepro2', 'P2', 'p2.example.com', 'UTC', 'USD', 'kp2', 2, 'pro'), ('siteadm1', 'A1', 'a1.example.com', 'UTC', 'USD', 'ka1', 1, 'adm');`,
  );
  const env = { DB: db.d1, SESSION_SECRET: 's', ADMIN_PASSWORD: 'pw', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g', ADMIN_EMAILS: 'admin@example.com', POLAR_ACCESS_TOKEN: 'polar_oat_secret', POLAR_PRODUCT_ID: 'prod', POLAR_ENVIRONMENT: 'sandbox', PLAN_ADDRESS_DAILY_LIMIT: '100000', ...overrides } as Env;
  const call = (path: string, init: RequestInit = {}) => app.request('https://dm.test' + path, init, env, { waitUntil() {} } as never);
  const as = async (id: string, path: string, method = 'GET', json?: unknown) =>
    call(path, { method, headers: { cookie: 'dm_auth=' + (await createSession(env, 'u:' + id)) }, body: json === undefined ? undefined : JSON.stringify(json) });
  let ip = 0;
  const visit = (site: string, domain: string, n = 1) =>
    (async () => {
      for (let i = 0; i < n; i++) await call('/api/event', { method: 'POST', headers: { 'user-agent': UA, 'cf-connecting-ip': `198.51.${(ip >> 8) & 255}.${ip++ & 255}` }, body: JSON.stringify({ w: site, t: 'pageview', u: `https://${domain}/`, vid: `visitor${site}${i}`, sid: `session${site}${i}` }) });
    })();
  const events = (site: string) => Number((db.raw.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ?').get(site) as { n: number }).n);
  const user = async (id: string) => ((await (await as(id, '/api/auth/me')).json()) as { user: Record<string, any> }).user;
  const usage = async (id: string) => (await (await as(id, '/api/billing/usage')).json()) as { month: string; total: number; days: number[]; sites: { id: string; events: number; recording: boolean }[]; other: number };
  const lapse = (ago: number) => {
    db.raw.exec(`UPDATE users SET plan_status = 'expired', plan_until = ${Date.now() - ago * DAY} WHERE id = 'pro'`);
    forgetAllSites();
  };
  return { db, env, call, as, visit, events, user, usage, lapse };
}

describe('Free', () => {
  it('opens the app straight after sign-in, with one website and no card', async () => {
    const t = setup();
    expect(await t.user('free')).toMatchObject({ paid: false, events_limit: 5_000, hard_limit: 5_000, sites_limit: 1, sites_used: 1, renews_at: null });
    for (const p of ['/api/sites', '/api/sites/sitefree1/overview', '/api/agent-tokens', '/api/billing/usage', '/api/billing/account']) expect([p, (await t.as('free', p)).status]).toEqual([p, 200]);
    const { secret } = await createToken(t.db.d1, 'free', { name: 'x' });
    expect((await t.call('/api/agent/v1/list_sites', { headers: { authorization: 'Bearer ' + secret } })).status).toBe(200);
    const more = await t.as('free', '/api/sites', 'POST', { domain: 'two.example.com' });
    expect([more.status, await more.json()]).toEqual([402, { error: 'Free includes 1 website. Go Pro in Billing for 10.' }]);
    expect((await t.as('free', '/api/sites/sitepro1')).status).toBe(404);
  });
  it('records to its limit and not one event past it, then again next month', async () => {
    const t = setup({ FREE_EVENT_LIMIT: '3' });
    await t.visit('sitefree1', 'f1.example.com', 5);
    expect(t.events('sitefree1')).toBe(3);
    expect(await t.usage('free')).toMatchObject({ total: 3, other: 0 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 35 * DAY });
    await t.visit('sitefree1', 'f1.example.com', 2);
    expect(t.events('sitefree1')).toBe(5);
  });
  it("one address can't use up the month", () => {
    for (const limit of ['1', '2', '31', '32', '100', '5000']) {
      const l = planLimits({ FREE_EVENT_LIMIT: limit } as Env, 'free');
      expect(l.addressDailyLimit).toBeGreaterThan(0);
      if (Number(limit) > 31) expect(l.addressDailyLimit * 31).toBeLessThan(l.hardEventLimit);
    }
    expect(planLimits({ PLAN_ADDRESS_DAILY_LIMIT: '7' } as Env, 'free').addressDailyLimit).toBe(7);
  });
  it('takes payments without counting them, up to an allowance of their own', async () => {
    const t = setup({ FREE_EVENT_LIMIT: '2' });
    const pay = (i: number) => t.call('/api/v1/payments', { method: 'POST', headers: { authorization: 'Bearer kf1' }, body: JSON.stringify({ transaction_id: 't' + i, amount: 5 }) });
    await t.visit('sitefree1', 'f1.example.com', 2);
    expect([(await pay(1)).status, (await pay(2)).status, (await pay(3)).status]).toEqual([200, 200, 402]);
    expect((await t.user('free')).events_used).toBe(2);
  });
  it('bounds how much one account can ask for', async () => {
    const t = setup();
    const cookie = 'dm_auth=' + (await createSession(t.env, 'u:free'));
    let last = 200;
    for (let i = 0; i < 620 && last === 200; i++) last = (await t.call('/api/agent-tokens', { headers: { cookie } })).status;
    expect(last).toBe(429);
    expect((await t.as('pro', '/api/agent-tokens')).status).toBe(200);
  });
});

describe('after Pro', () => {
  it('finishes the month under its limits, then Free', () => {
    const at = Date.UTC(2026, 10, 24);
    expect([recordingPlan(null, at), recordingPlan(0, at), recordingPlan(at + 1, at), recordingPlan(at - DAY, at), recordingPlan(Date.UTC(2026, 9, 31, 23), at)]).toEqual(['free', 'free', 'pro', 'pro', 'free']);
    expect([recordingPlan(Date.UTC(2026, 10, 24), Date.UTC(2026, 10, 30, 23, 59)), recordingPlan(Date.UTC(2026, 10, 24), Date.UTC(2026, 11, 1))]).toEqual(['pro', 'free']);
  });
  it('keeps the busiest website recording and pauses the rest, whose data stays', async () => {
    const t = setup();
    await t.visit('sitepro1', 'p1.example.com', 1);
    await t.visit('sitepro2', 'p2.example.com', 3);
    t.lapse(40);
    await t.visit('sitepro1', 'p1.example.com', 2);
    await t.visit('sitepro2', 'p2.example.com', 2);
    expect([t.events('sitepro1'), t.events('sitepro2')]).toEqual([1, 5]);
    expect((await t.usage('pro')).sites).toMatchObject([{ id: 'sitepro1', events: 1, recording: false }, { id: 'sitepro2', events: 5, recording: true }]);
    expect((await t.as('pro', '/api/sites/sitepro1/overview')).status).toBe(200);
    // Payments and goals for a paused website are not taken either.
    expect((await t.call('/api/v1/payments', { method: 'POST', headers: { authorization: 'Bearer kp1' }, body: JSON.stringify({ transaction_id: 't', amount: 5 }) })).status).toBe(402);
    expect((await t.call('/api/v1/goals', { method: 'POST', headers: { authorization: 'Bearer kp1' }, body: JSON.stringify({ visitor_id: 'visitorsitepro10', name: 'g' }) })).status).toBe(402);
    const body = JSON.stringify({ type: 'order.paid', data: { id: 'o', total_amount: 500, currency: 'usd', created_at: new Date().toISOString(), customer: {} } });
    t.db.raw.exec("UPDATE sites SET polar_webhook_secret = 'whsec_" + Buffer.from('k').toString('base64') + "'");
    forgetAllSites();
    const hook = (site: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      return t.call('/api/webhooks/polar/' + site, { method: 'POST', body, headers: { 'webhook-id': 'e', 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + createHmac('sha256', 'k').update(`e.${ts}.${body}`).digest('base64') } });
    };
    expect([(await hook('sitepro1')).status, (await hook('sitepro2')).status]).toEqual([200, 200]);
    expect(t.db.raw.prepare('SELECT site_id FROM payments').all()).toEqual([{ site_id: 'sitepro2' }]);
  });
  it('does not move to another website by itself, unless that one is deleted', async () => {
    const t = setup();
    await t.visit('sitepro2', 'p2.example.com', 2);
    t.lapse(40);
    expect(await pickFreeSite(t.db.d1, 'pro')).toBe('sitepro2');
    t.db.raw.exec(`INSERT INTO usage_daily VALUES ('pro', '${new Date().toISOString().slice(0, 10)}', 'sitepro1', 999)`);
    expect(await pickFreeSite(t.db.d1, 'pro')).toBe('sitepro2');
    expect((await t.as('pro', '/api/sites/sitepro2', 'DELETE')).status).toBe(200);
    await t.visit('sitepro1', 'p1.example.com', 1);
    expect(t.events('sitepro1')).toBe(1);
    expect(await t.usage('pro')).toMatchObject({ total: 1002, other: 2, sites: [{ id: 'sitepro1', events: 1000, recording: true }] });
  });
  it('records everywhere until the month ends', async () => {
    const t = setup({ FREE_EVENT_LIMIT: '1' });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 24, 12) });
    t.lapse(1);
    await t.visit('sitepro1', 'p1.example.com', 2);
    await t.visit('sitepro2', 'p2.example.com', 2);
    expect([t.events('sitepro1'), t.events('sitepro2')]).toEqual([2, 2]);
    expect(await t.user('pro')).toMatchObject({ paid: false, events_limit: 50_000, sites_limit: 1, pro_limits_until: Date.UTC(2026, 11, 1) });
    expect((await t.usage('pro')).sites.every((s) => s.recording)).toBe(true);
  });
});

describe('the billing page', () => {
  it('adds up: days, websites and the total are the same events', async () => {
    const t = setup();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 3, 12) });
    await t.visit('sitepro1', 'p1.example.com', 2);
    vi.setSystemTime(Date.UTC(2026, 10, 24, 12));
    await t.visit('sitepro1', 'p1.example.com', 1);
    await t.visit('sitepro2', 'p2.example.com', 4);
    const u = await t.usage('pro');
    expect([u.month, u.days.length, u.days[2], u.days[23], u.total, u.other]).toEqual(['2026-11', 24, 2, 5, 7, 0]);
    expect(u.days.reduce((a, b) => a + b)).toBe(7);
    expect(u.sites.map((s) => s.events)).toEqual([3, 4]);
    expect((await t.usage('free')).total).toBe(0);
  });
  it('shows the owner their own websites, without limits', async () => {
    const t = setup();
    await t.visit('siteadm1', 'a1.example.com', 3);
    await t.visit('sitepro1', 'p1.example.com', 2);
    expect(await t.usage('adm')).toMatchObject({ total: 3, other: 0, sites: [{ id: 'siteadm1', events: 3, recording: true }] });
    expect((await t.call('/api/billing/usage')).status).toBe(401);
  });
  it('says when the plan renews, not when its slack runs out', async () => {
    const t = setup();
    const u = await t.user('pro');
    expect(u.renews_at).toBe(u.plan_until - 3 * DAY);
    t.db.raw.exec("UPDATE users SET plan_status = 'cancelled' WHERE id = 'pro'");
    expect((await t.user('pro')).renews_at).toBeNull();
  });
});

describe('paying, from the billing page', () => {
  type Seen = { method: string; path: string; auth: string; body: any };
  function polar(t: ReturnType<typeof setup>, replies: Record<string, unknown> = {}) {
    t.db.raw.exec(`INSERT INTO plan_subscriptions (id, user_id, status, until, source_at, updated_at) VALUES ('${SUB}', 'pro', 'active', ${Date.now() + 20 * DAY}, 1, 1)`);
    const seen: Seen[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const u = new URL(url);
      seen.push({ method: init.method!, path: u.pathname, auth: new Headers(init.headers).get('authorization')!, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = replies[u.pathname] ?? (u.pathname === '/v1/customer-sessions/' ? { token: 'cust_tok', customer_portal_url: 'https://sandbox.polar.sh/portal' } : undefined);
      const reply = typeof r === 'function' ? r() : r;
      if (reply instanceof Response) return reply;
      return reply === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(reply), { status: 200 });
    });
    return seen;
  }
  const ME = '/v1/customer-portal/customers/me', METHODS = ME + '/payment-methods', ORDERS = '/v1/customer-portal/orders/', RECEIPT = `${ORDERS}${ORDER}/receipt`, SUBS = '/v1/customer-portal/subscriptions/' + SUB;
  const order = { id: ORDER, created_at: '2026-11-24T12:25:27Z', total_amount: 500, currency: 'usd', status: 'paid', product_id: 'prod', billing_address: { line1: 'secret street' } };

  it('lists how the account pays and what it paid, through a session of its own', async () => {
    const t = setup();
    const seen = polar(t, { [ME]: { default_payment_method_id: 'b', email: 'x' }, [METHODS]: { items: [{ id: 'a', type: 'card', method_metadata: { brand: 'visa', last4: '1111', exp_month: 1, exp_year: 2027 } }, { id: 'b', type: 'card', method_metadata: { brand: 'mastercard', last4: '4242', exp_month: 8, exp_year: 2029 } }] }, [ORDERS]: { items: [order, { id: 'not-a-uuid' }] } });
    expect(await (await t.as('pro', '/api/billing/account')).json()).toEqual({ method: { type: 'card', brand: 'mastercard', last4: '4242', expires: '08/29' }, orders: [{ id: ORDER, at: Date.parse('2026-11-24T12:25:27Z'), amount: 500, currency: 'USD', status: 'paid' }] });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/customer-sessions/', auth: 'Bearer polar_oat_secret', body: { external_customer_id: 'pro' } });
    expect(seen.slice(1).every((s) => s.auth === 'Bearer cust_tok')).toBe(true);
  });
  it('copes with a wallet that has no card number, and with Polar being away', async () => {
    const t = setup();
    polar(t, { [ME]: {}, [METHODS]: { items: [{ id: 'l', type: 'link' }] }, [ORDERS]: { items: [] } });
    expect(await (await t.as('pro', '/api/billing/account')).json()).toEqual({ method: { type: 'link', brand: null, last4: null, expires: null }, orders: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
    expect((await t.as('pro', '/api/billing/account')).status).toBe(502);
  });
  it('asks Polar nothing for an account that never paid', async () => {
    const t = setup();
    const seen = polar(t);
    expect(await (await t.as('free', '/api/billing/account')).json()).toEqual({ method: null, orders: [] });
    expect(seen).toEqual([]);
  });
  it('gives a receipt, waiting while Polar draws it, and only ever sends people to Polar storage', async () => {
    const t = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    polar(t, { [RECEIPT]: () => (n++ ? { url: 'https://polar-receipts.s3.amazonaws.com/r.pdf?sig=1' } : new Response(null, { status: 202 })) });
    const r = await t.as('pro', '/api/billing/receipts/' + ORDER);
    expect([r.status, r.headers.get('location'), n]).toEqual([302, 'https://polar-receipts.s3.amazonaws.com/r.pdf?sig=1', 2]);
    for (const url of ['https://evil.test/r.pdf', 'http://x.amazonaws.com/', 'https://amazonaws.com.evil.test/', 'javascript:1']) {
      polarAgain(t, { [RECEIPT]: { url } });
      expect((await t.as('pro', '/api/billing/receipts/' + ORDER)).headers.get('location')).toBe('/billing?error=receipt');
    }
    expect((await t.as('pro', '/api/billing/receipts/..%2f..%2fcustomers%2fme')).status).toBe(404);
  });
  const polarAgain = (t: ReturnType<typeof setup>, replies: Record<string, unknown>) => {
    t.db.raw.exec('DELETE FROM plan_subscriptions');
    return polar(t, replies);
  };
  it('cancels and keeps the plan, and the page is right at once', async () => {
    const t = setup();
    const end = new Date(Date.now() + 17 * DAY).toISOString();
    const state = (cancel: boolean, at: number) => ({ id: SUB, status: 'active', cancel_at_period_end: cancel, current_period_end: end, ends_at: cancel ? end : null, created_at: new Date(1000).toISOString(), modified_at: new Date(at).toISOString() });
    let cancelled = false;
    const seen = polar(t, { [SUBS]: () => state(cancelled, Date.now() + (cancelled ? 1 : 2)) });
    expect((await t.as('pro', '/api/billing/resume', 'POST')).status).toBe(409);
    cancelled = true;
    expect((await t.as('pro', '/api/billing/cancel', 'POST')).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'PATCH', path: SUBS, auth: 'Bearer cust_tok', body: { cancel_at_period_end: true } });
    expect(await t.user('pro')).toMatchObject({ paid: true, plan_status: 'cancelled', plan_until: Date.parse(end), renews_at: null });
    cancelled = false;
    expect((await t.as('pro', '/api/billing/resume', 'POST')).status).toBe(200);
    expect(seen.at(-1)!.body).toEqual({ cancel_at_period_end: false });
    expect(await t.user('pro')).toMatchObject({ plan_status: 'active', renews_at: Date.parse(end) });
  });
  it('changes nothing for someone else, for no plan, or when Polar answers oddly', async () => {
    const t = setup();
    const seen = polar(t, { [SUBS]: { id: '33333333-3333-4333-8333-333333333333', status: 'active' } });
    expect((await t.as('free', '/api/billing/cancel', 'POST')).status).toBe(409);
    expect(seen).toEqual([]);
    expect((await t.as('pro', '/api/billing/cancel', 'POST')).status).toBe(502);
    expect((await t.call('/api/billing/cancel', { method: 'POST' })).status).toBe(401);
    expect(await t.user('pro')).toMatchObject({ plan_status: 'active', paid: true });
  });
});

describe('the Pro button', () => {
  it('signs in and then opens Billing', async () => {
    const t = setup();
    const go = await t.call('/api/auth/google?plan=pro');
    const state = new URL(go.headers.get('location')!).searchParams.get('state')!;
    expect(state.endsWith('.pro')).toBe(true);
    const jwt = ['', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'g', sub: 'new-sub', email: 'new@example.com', email_verified: true })).toString('base64url'), ''].join('.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id_token: jwt })));
    const back = (s: string, cookie = s) => t.call(`/api/auth/google/callback?code=c&state=${encodeURIComponent(s)}`, { headers: { cookie: 'dm_oauth=' + encodeURIComponent(cookie) } });
    expect((await back(state)).headers.get('location')).toBe('/billing?signup=1');
    expect((await back(state)).headers.get('location')).toBe('/billing');
    const plain = new URL((await t.call('/api/auth/google')).headers.get('location')!).searchParams.get('state')!;
    expect((await back(plain)).headers.get('location')).toBe('/');
    expect((await back(plain + '.pro', plain)).headers.get('location')).toMatch(/login_error/);
  });
  it('a new account starts on Free with nothing used', async () => {
    const t = setup();
    t.db.raw.exec("INSERT INTO users (id, email, created_at, plan_status) VALUES ('n', 'n@example.com', 0, 'none')");
    expect(await t.user('n')).toMatchObject({ paid: false, sites_used: 0, events_used: 0, events_limit: 5_000 });
    expect(await t.usage('n')).toMatchObject({ month: utcMonth(), total: 0, sites: [], other: 0 });
    expect((await t.as('n', '/api/sites', 'POST', { domain: 'n.example.com' })).status).toBe(200);
  });
});
