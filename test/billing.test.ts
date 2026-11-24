import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession, utcMonth } from '../src/worker/auth';
import { POLAR_VERSION } from '../src/worker/billing';
import { forgetAllSites, type Env } from '../src/worker/env';
import app from '../src/worker/index';
import { makeD1 } from './helpers/d1';

const DAY = 86_400_000;
const SECRET = 'whsec_' + Buffer.from('billing-secret').toString('base64');
afterEach(() => vi.unstubAllGlobals());

function setup(overrides: Partial<Env> = {}) {
  const db = makeD1();
  forgetAllSites();
  db.raw.exec(
    `INSERT INTO users (id, email, name, google_sub, created_at, plan_status) VALUES ('user-a', 'a@example.com', 'Ann', 'sa', 0, 'none'), ('user-b', 'b@example.com', NULL, 'sb', 0, 'none');
     INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES ('siteaaa1', 'A', 'a.example.com', 'UTC', 'USD', 'k1', 0, 'user-a');`,
  );
  const env = { DB: db.d1, SESSION_SECRET: 's', ADMIN_PASSWORD: 'pw', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g', POLAR_ACCESS_TOKEN: 'polar_oat_secret', POLAR_PRODUCT_ID: 'prod', POLAR_WEBHOOK_SECRET: SECRET, POLAR_ENVIRONMENT: 'sandbox', ...overrides } as Env;
  const call = (path: string, init: RequestInit = {}) => app.request('https://dm.test' + path, init, env, { waitUntil() {} } as never);
  const as = async (id: string, path: string, headers: Record<string, string> = {}) =>
    call(path, { headers: { cookie: `dm_auth=${await createSession(env, 'u:' + id)}${headers.cookie ? '; ' + headers.cookie : ''}`, ...(headers.ip ? { 'cf-connecting-ip': headers.ip } : {}) } });
  const deliver = (d: unknown, o: { key?: Buffer; at?: number; tamper?: boolean } = {}) => {
    const body = typeof d === 'string' ? d : JSON.stringify(d), ts = String(Math.floor((o.at ?? Date.now()) / 1000));
    const sig = createHmac('sha256', o.key ?? Buffer.from(SECRET.slice(6), 'base64')).update(`e.${ts}.${body}`).digest('base64');
    return call('/api/billing/webhook', { method: 'POST', body: o.tamper ? body + ' ' : body, headers: { 'webhook-id': 'e', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` } });
  };
  const plan = async (id = 'user-a') => ((await (await as(id, '/api/auth/me')).json()) as { user: { paid: boolean; plan_status: string; plan_until: number | null } }).user;
  return { db, env, call, as, deliver, plan };
}

// Times are minutes from a fixed start, so each state has a clear age.
const T0 = Date.now() - 2 * DAY;
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const state = (o: Record<string, unknown> = {}) => ({
  id: 'sub1', status: 'active', product_id: 'prod', created_at: iso(0), modified_at: iso(1), current_period_start: iso(0), current_period_end: inDays(28), cancel_at_period_end: false, ends_at: null, past_due_at: null,
  customer_id: 'cus1', customer: { id: 'cus1', external_id: 'user-a', email: 'a@example.com' }, metadata: {}, ...o,
});
const sub = (type: string, o: Record<string, unknown> = {}) => ({ type: 'subscription.' + type, data: state(o) });
const order = (type: 'paid' | 'refunded', o: Record<string, unknown> = {}) => ({
  type: 'order.' + type,
  data: { id: 'ord1', status: type, paid: true, product_id: 'prod', subscription_id: 'sub1', created_at: iso(1), modified_at: iso(2), billing_reason: 'subscription_create', customer: { external_id: 'user-a' }, subscription: state(), ...o },
});

describe('checkout', () => {
  function polar(reply: unknown = { url: 'https://sandbox.polar.sh/checkout/x' }, status = 201) {
    const calls: { url: string; init: RequestInit; body: Record<string, any> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status });
    });
    return calls;
  }
  it('makes a session for the signed-in account and goes to it', async () => {
    const t = setup();
    const calls = polar();
    const r = await t.as('user-a', '/api/billing/checkout?external_customer_id=user-b&products=other', { cookie: 'dm_vid=visitor-123; dm_sid=session-123', ip: '203.0.113.9' });
    expect([r.status, r.headers.get('location')]).toEqual([302, 'https://sandbox.polar.sh/checkout/x']);
    expect(calls[0].url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer polar_oat_secret', 'polar-version': POLAR_VERSION });
    expect(calls[0].body).toEqual({
      products: ['prod'], external_customer_id: 'user-a', customer_email: 'a@example.com', customer_name: 'Ann', customer_ip_address: '203.0.113.9',
      metadata: { dm_visitor_id: 'visitor-123', dm_session_id: 'session-123' }, success_url: 'https://dm.test/billing?paid=1&checkout_id={CHECKOUT_ID}', return_url: 'https://dm.test/billing',
    });
  });
  it('uses the live API unless told otherwise, and leaves out odd visitor cookies', async () => {
    const t = setup({ POLAR_ENVIRONMENT: undefined });
    const calls = polar({ url: 'https://polar.sh/checkout/x' });
    await t.as('user-a', '/api/billing/checkout', { cookie: 'dm_vid=<script>; dm_sid=x' });
    expect(calls[0].url).toBe('https://api.polar.sh/v1/checkouts/');
    expect(calls[0].body.metadata).toEqual({});
  });
  it.each([
    ['an error', { detail: 'polar_oat_secret leaked' }, 422], ['a redirect', '', 302], ['not JSON', '<html>', 200], ['no url', {}, 201],
    ['another site', { url: 'https://evil.example/polar.sh' }, 201], ['a lookalike', { url: 'https://evilpolar.sh/' }, 201], ['http', { url: 'http://polar.sh/' }, 201], ['a script', { url: 'javascript:alert(1)' }, 201],
  ])('goes back to Billing on %s, showing nothing of it', async (_n, reply, status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup();
    polar(reply, status);
    for (const what of ['checkout', 'portal']) {
      const r = await t.as('user-a', '/api/billing/' + what);
      expect([r.status, r.headers.get('location'), await r.text()]).toEqual([302, '/billing?error=' + what, '']);
    }
  });
  it('needs a signed-in account, a full setup and hosted mode; a paid account has nothing to buy', async () => {
    const t = setup();
    const calls = polar();
    expect((await t.call('/api/billing/checkout')).status).toBe(401);
    expect((await t.call('/api/billing/portal')).status).toBe(401);
    for (const o of [{ POLAR_ACCESS_TOKEN: undefined }, { POLAR_PRODUCT_ID: undefined }]) expect((await setup(o).as('user-a', '/api/billing/checkout')).status).toBe(503);
    t.db.raw.exec(`UPDATE users SET plan_status = 'active', plan_until = ${Date.now() + DAY}`);
    expect((await t.as('user-a', '/api/billing/checkout')).headers.get('location')).toBe('/billing');
    expect(calls).toHaveLength(0);
  });
  it('limits how often one account can start one', async () => {
    const t = setup();
    t.db.raw.exec("INSERT INTO users (id, email, created_at) VALUES ('user-busy', 'c@example.com', 0)");
    const calls = polar();
    for (let i = 0; i < 14; i++) await t.as('user-busy', '/api/billing/checkout');
    expect(calls.length).toBeLessThanOrEqual(10);
  });
  it("opens the account's own portal page, also without a paid plan", async () => {
    const t = setup();
    const calls = polar({ customer_portal_url: 'https://sandbox.polar.sh/portal?token=t' });
    t.db.raw.exec("INSERT INTO plan_subscriptions (id, user_id, status, until, updated_at) VALUES ('old', 'user-b', 'expired', 1, 1)");
    const r = await t.as('user-b', '/api/billing/portal?external_customer_id=user-a');
    expect(r.headers.get('location')).toBe('https://sandbox.polar.sh/portal?token=t');
    expect(calls[0]).toMatchObject({ url: 'https://sandbox-api.polar.sh/v1/customer-sessions/', body: { external_customer_id: 'user-b', return_url: 'https://dm.test/billing' } });
  });
});

describe('webhook signatures', () => {
  it('accepts both of Polar\'s signing schemes, and nothing else', async () => {
    const t = setup();
    expect((await t.deliver(sub('active'))).status).toBe(200);
    expect((await t.deliver(sub('active'), { key: Buffer.from(SECRET) })).status).toBe(200);
    expect((await t.deliver(sub('active'), { key: Buffer.from('wrong') })).status).toBe(401);
    expect((await t.deliver(sub('active'), { tamper: true })).status).toBe(401);
    expect((await t.deliver(sub('active'), { at: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect((await t.call('/api/billing/webhook', { method: 'POST', body: JSON.stringify(sub('active')) })).status).toBe(401);
    expect((await setup({ POLAR_WEBHOOK_SECRET: undefined }).deliver(sub('active'))).status).toBe(503);
  });
  it('answers signed nonsense without failing', async () => {
    const t = setup();
    expect((await t.deliver('not json')).status).toBe(400);
    for (const d of ['null', '[]', '{}', '"x"', '{"type":5}', '{"type":"subscription.active"}', '{"type":"subscription.active","data":null}', '{"type":"order.paid","data":{"product_id":"prod"}}', JSON.stringify(sub('active', { modified_at: 'x', created_at: 'y' })), JSON.stringify(sub('active', { current_period_end: null }))]) expect([d, (await t.deliver(d)).status]).toEqual([d, 200]);
    expect((await t.plan()).paid).toBe(false);
  });
});

describe('who a subscription belongs to', () => {
  it('only the account our checkout named, for our product', async () => {
    const t = setup();
    await t.deliver(sub('active', { product_id: 'other' }));
    await t.deliver(sub('active', { customer: { external_id: null, email: 'a@example.com' }, metadata: { user_id: 'user-a' } }));
    await t.deliver(sub('active', { customer: { external_id: 'nobody', email: 'a@example.com' } }));
    expect((await t.plan()).paid).toBe(false);
    expect((await setup({ POLAR_PRODUCT_ID: undefined }).deliver(sub('active'))).status).toBe(200);
    await t.deliver(sub('active'));
    expect(await t.plan()).toMatchObject({ paid: true, plan_status: 'active' });
    expect((await t.plan('user-b')).paid).toBe(false);
  });
  it('a subscription keeps its account', async () => {
    const t = setup();
    await t.deliver(sub('active'));
    await t.deliver(sub('updated', { modified_at: iso(5), customer: { external_id: 'user-b' } }));
    expect([(await t.plan()).paid, (await t.plan('user-b')).paid]).toEqual([true, false]);
  });
  it('one subscription never ends another', async () => {
    const t = setup();
    await t.deliver(sub('active', { id: 'old' }));
    await t.deliver(sub('active', { id: 'new' }));
    await t.deliver(sub('revoked', { id: 'old', status: 'canceled', modified_at: iso(9) }));
    expect(await t.plan()).toMatchObject({ paid: true, plan_status: 'active' });
    await t.deliver(sub('revoked', { id: 'theirs', status: 'canceled', customer: { external_id: 'user-b' } }));
    expect((await t.plan()).paid).toBe(true);
    await t.deliver(sub('revoked', { id: 'new', status: 'canceled', modified_at: iso(9) }));
    expect(await t.plan()).toMatchObject({ paid: false, plan_status: 'expired' });
  });
});

describe('the life of a subscription', () => {
  const near = (a: number | null, b: number) => expect(Math.abs((a ?? 0) - b)).toBeLessThan(120_000);
  it('starts, whichever event comes first', async () => {
    for (const list of [[sub('created'), sub('active'), order('paid')], [order('paid'), sub('updated'), sub('created')]]) {
      const t = setup();
      for (const e of list) await t.deliver(e);
      const p = await t.plan();
      expect(p).toMatchObject({ paid: true, plan_status: 'active' });
      near(p.plan_until, Date.now() + 31 * DAY);
    }
    const t = setup();
    await t.deliver(order('paid'));
    expect((await t.plan()).paid).toBe(true);
  });
  it('an unpaid first checkout is not a plan', async () => {
    const t = setup();
    await t.deliver(sub('created', { status: 'incomplete' }));
    await t.deliver(sub('updated', { status: 'incomplete_expired', modified_at: iso(3) }));
    await t.deliver(order('paid', { subscription: state({ status: 'incomplete' }) }));
    expect(await t.plan()).toMatchObject({ paid: false, plan_status: 'none', plan_until: null });
  });
  it('cancelling keeps the paid time, undoing it renews again, and the end is the end', async () => {
    const t = setup();
    await t.deliver(sub('active'));
    await t.deliver(sub('canceled', { cancel_at_period_end: true, ends_at: inDays(28), modified_at: iso(5) }));
    let p = await t.plan();
    expect(p).toMatchObject({ paid: true, plan_status: 'cancelled' });
    near(p.plan_until, Date.now() + 28 * DAY);
    await t.deliver(sub('uncanceled', { modified_at: iso(6) }));
    expect(await t.plan()).toMatchObject({ paid: true, plan_status: 'active' });
    await t.deliver(sub('canceled', { cancel_at_period_end: true, ends_at: inDays(28), modified_at: iso(7) }));
    await t.deliver(sub('revoked', { status: 'canceled', modified_at: iso(8) }));
    expect(await t.plan()).toMatchObject({ paid: false, plan_status: 'expired' });
    // Polar never reopens an ended subscription, so nothing here does.
    await t.deliver(sub('updated', { modified_at: iso(99) }));
    await t.deliver(order('paid', { id: 'ord9', created_at: iso(99) }));
    expect((await t.plan()).paid).toBe(false);
    await t.deliver(sub('active', { id: 'sub2' }));
    expect((await t.plan()).paid).toBe(true);
  });
  it('a failed renewal gives three days, not the month that was not paid for', async () => {
    const t = setup();
    await t.deliver(sub('active', { current_period_end: iso(10) }));
    await t.deliver(sub('cycled', { current_period_end: inDays(29), modified_at: iso(10) }));
    const failedAt = new Date().toISOString();
    await t.deliver(sub('past_due', { status: 'past_due', past_due_at: failedAt, current_period_end: inDays(29), modified_at: failedAt }));
    let p = await t.plan();
    expect(p).toMatchObject({ paid: true, plan_status: 'past_due' });
    near(p.plan_until, Date.now() + 3 * DAY);
    await t.deliver(sub('past_due', { status: 'past_due', past_due_at: new Date(Date.now() - 4 * DAY).toISOString(), current_period_end: inDays(29), modified_at: new Date(Date.now() + 1000).toISOString() }));
    expect((await t.plan()).paid).toBe(false);
    await t.deliver(sub('updated', { current_period_end: inDays(29), modified_at: new Date(Date.now() + 2000).toISOString() }));
    p = await t.plan();
    expect(p).toMatchObject({ paid: true, plan_status: 'active' });
  });
  it('pausing stops access and resuming restores it', async () => {
    const t = setup();
    await t.deliver(sub('active'));
    await t.deliver(sub('paused', { status: 'paused', modified_at: iso(5) }));
    expect(await t.plan()).toMatchObject({ paid: false, plan_status: 'paused' });
    await t.deliver(sub('resumed', { modified_at: iso(6) }));
    expect(await t.plan()).toMatchObject({ paid: true, plan_status: 'active' });
  });
  it('late and repeated deliveries change nothing', async () => {
    const t = setup();
    await t.deliver(sub('active'));
    await t.deliver(sub('revoked', { status: 'canceled', modified_at: iso(9) }));
    for (const e of [sub('active'), sub('updated', { modified_at: iso(8) }), sub('revoked', { status: 'canceled', modified_at: iso(9) })]) await t.deliver(e);
    expect((await t.plan()).paid).toBe(false);
    // The end arriving before the beginning.
    const u = setup();
    await u.deliver(sub('revoked', { status: 'canceled', modified_at: iso(9) }));
    await u.deliver(sub('active'));
    expect(await u.plan()).toMatchObject({ paid: false, plan_status: 'none' });
    const v = setup();
    await v.deliver(sub('paused', { status: 'paused', modified_at: iso(5) }));
    await v.deliver(sub('active'));
    expect((await v.plan()).paid).toBe(false);
  });
});

describe('refunds', () => {
  const paidUp = async () => {
    const t = setup();
    await t.deliver(sub('active'));
    await t.deliver(order('paid'));
    return t;
  };
  it('a full refund of the newest payment ends the plan; a partial or older one does not', async () => {
    const t = await paidUp();
    await t.deliver(order('refunded', { status: 'partially_refunded' }));
    expect((await t.plan()).paid).toBe(true);
    await t.deliver(order('paid', { id: 'ord2', created_at: iso(50) }));
    await t.deliver(order('refunded'));
    expect((await t.plan()).paid).toBe(true);
    await t.deliver(order('refunded', { id: 'ord2', created_at: iso(50) }));
    expect(await t.plan()).toMatchObject({ paid: false, plan_status: 'refunded' });
  });
  it.each(['paused', 'past_due', 'unpaid'])('stays refunded through %s, resuming and late copies, until a new payment', async (status) => {
    const t = await paidUp();
    await t.deliver(order('refunded'));
    await t.deliver(sub('updated', { status, modified_at: iso(20) }));
    for (const e of [sub('resumed', { modified_at: iso(30) }), sub('updated', { modified_at: iso(31) }), order('paid'), order('paid', { id: 'ord0', created_at: iso(0) })]) await t.deliver(e);
    expect(await t.plan()).toMatchObject({ paid: false, plan_status: 'refunded' });
    await t.deliver(order('paid', { id: 'ord2', created_at: iso(60), subscription: state({ modified_at: iso(60), current_period_end: inDays(20) }) }));
    expect(await t.plan()).toMatchObject({ paid: true, plan_status: 'active' });
  });
  it('a refund that arrives before the payment still counts', async () => {
    const t = setup();
    await t.deliver(order('refunded'));
    await t.deliver(order('paid'));
    await t.deliver(sub('active'));
    expect((await t.plan()).paid).toBe(false);
  });
  it('a newer refund still counts when the plan is already refunded, whatever order things arrive in', async () => {
    const t = await paidUp();
    await t.deliver(order('refunded'));
    await t.deliver(order('refunded', { id: 'ord2', created_at: iso(60) }));
    await t.deliver(order('paid', { id: 'ord2', created_at: iso(60) }));
    expect(await t.plan()).toMatchObject({ paid: false, plan_status: 'refunded' });
    expect(t.db.raw.prepare('SELECT payment_id FROM plan_subscriptions').get()).toEqual({ payment_id: 'ord2' });
    await t.deliver(order('paid', { id: 'ord3', created_at: iso(90) }));
    expect((await t.plan()).paid).toBe(true);
  });
  it('the end of a subscription is kept during a refund, so a late payment cannot reopen it', async () => {
    const t = await paidUp();
    await t.deliver(order('refunded'));
    await t.deliver(sub('revoked', { status: 'canceled', modified_at: iso(90) }));
    await t.deliver(order('paid', { id: 'ord2', created_at: iso(60) }));
    expect((await t.plan()).paid).toBe(false);
    const u = await paidUp();
    await u.deliver(order('refunded'));
    await u.deliver(sub('paused', { status: 'paused', modified_at: iso(90) }));
    await u.deliver(order('paid', { id: 'ord2', created_at: iso(60) }));
    expect((await u.plan()).paid).toBe(false);
  });
  it('someone who pays again gets in, also when the news of the subscription came first', async () => {
    const t = await paidUp();
    await t.deliver(order('refunded'));
    await t.deliver(sub('updated', { modified_at: iso(95), current_period_end: inDays(25) }));
    expect((await t.plan()).paid).toBe(false);
    await t.deliver(order('paid', { id: 'ord2', created_at: iso(60), subscription: state({ modified_at: iso(60) }) }));
    expect(await t.plan()).toMatchObject({ paid: true, plan_status: 'active' });
  });
  it('a delivery that fails leaves nothing half-done, and its retry works', async () => {
    const t = await paidUp();
    const real = t.db.d1.batch.bind(t.db.d1);
    vi.spyOn(t.db.d1, 'batch').mockImplementationOnce(async () => { throw new Error('database is busy'); }).mockImplementation(real as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await t.deliver(order('refunded'))).status).toBe(500);
    expect((await t.plan()).paid).toBe(true);
    await t.deliver(order('refunded'));
    expect((await t.plan()).paid).toBe(false);
    // The account out of step with its subscriptions: any repeat puts it right.
    t.db.raw.exec(`UPDATE users SET plan_status = 'active', plan_until = ${Date.now() + DAY} WHERE id = 'user-a'`);
    await t.deliver(order('refunded'));
    expect((await t.plan()).paid).toBe(false);
  });
  it('every order of delivery ends the same', async () => {
    const events = [sub('active'), order('paid'), order('refunded'), sub('updated', { modified_at: iso(70), current_period_end: inDays(30) }), order('paid', { id: 'ord2', created_at: iso(60), subscription: state({ modified_at: iso(61) }) }), order('refunded', { id: 'ord2', created_at: iso(60) }), sub('revoked', { status: 'canceled', modified_at: iso(80) })];
    const perms = (list: unknown[]): unknown[][] => (list.length < 2 ? [list] : list.flatMap((x, i) => perms([...list.slice(0, i), ...list.slice(i + 1)]).map((r) => [x, ...r])));
    const t = setup();
    const cookie = 'dm_auth=' + (await createSession(t.env, 'u:user-a'));
    const all = perms(events);
    for (let i = 0; i < all.length; i += 17) {
      t.db.raw.exec("DELETE FROM plan_subscriptions; UPDATE users SET plan_status = 'none', plan_until = NULL, plan = NULL");
      for (const e of all[i]) await t.deliver(e);
      const u = ((await (await t.call('/api/auth/me', { headers: { cookie } })).json()) as { user: { paid: boolean } }).user;
      expect([i, u.paid]).toEqual([i, false]);
    }
    // And with the second payment kept and no ending, every order ends paid.
    const kept = perms(events.slice(0, 5));
    for (let i = 0; i < kept.length; i++) {
      t.db.raw.exec("DELETE FROM plan_subscriptions; UPDATE users SET plan_status = 'none', plan_until = NULL, plan = NULL");
      for (const e of kept[i]) await t.deliver(e);
      const u = ((await (await t.call('/api/auth/me', { headers: { cookie } })).json()) as { user: { paid: boolean } }).user;
      expect([i, u.paid]).toEqual([i, true]);
    }
  }, 60_000);
  it('a new payment on a subscription Polar says is over does not reopen it', async () => {
    const t = await paidUp();
    await t.deliver(order('refunded'));
    await t.deliver(order('paid', { id: 'ord2', created_at: iso(60), subscription: state({ status: 'canceled', modified_at: iso(60) }) }));
    expect((await t.plan()).paid).toBe(false);
  });
});

describe('what a plan opens and closes', () => {
  it('a failed checkout neither restarts collection nor shortens a plan given by hand', async () => {
    const t = setup();
    const old = Date.now() - 60 * DAY;
    t.db.raw.exec(`UPDATE users SET plan_status = 'expired', plan_until = ${old} WHERE id = 'user-a'`);
    for (const status of ['incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused']) await t.deliver(sub('updated', { id: 'x-' + status, status }));
    expect((await t.plan()).plan_until).toBe(old);
    const r = await t.call('/api/event', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/129 Safari/537.36' }, body: JSON.stringify({ w: 'siteaaa1', t: 'pageview', u: 'https://a.example.com/', vid: 'visitor01', sid: 'session01' }) });
    expect(r.status).toBe(202);
    // On Free, so it records under Free's limits, not the plan's.
    expect(t.db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    const given = Date.now() + 90 * DAY;
    t.db.raw.exec(`UPDATE users SET plan_status = 'active', plan_until = ${given} WHERE id = 'user-a'`);
    await t.deliver(sub('updated', { id: 'y', status: 'incomplete_expired' }));
    expect((await t.plan()).plan_until).toBe(given);
  });
  it('limits follow the plan at once', async () => {
    const t = setup();
    const limits = async () => {
      const u = ((await (await t.as('user-a', '/api/auth/me')).json()) as { user: Record<string, unknown> }).user;
      return [u.events_limit, u.sites_limit, !!u.pro_limits_until];
    };
    expect(await limits()).toEqual([5_000, 1, false]);
    await t.deliver(sub('active'));
    expect(await limits()).toEqual([50_000, 10, false]);
    // Ended: no more websites, but the month is finished under Pro's event limit.
    await t.deliver(sub('revoked', { status: 'canceled', modified_at: iso(9) }));
    expect(await limits()).toEqual([50_000, 1, true]);
    t.db.raw.exec(`UPDATE users SET plan_until = ${Date.now() - 32 * DAY}`);
    expect(await limits()).toEqual([5_000, 1, false]);
    expect(utcMonth()).toMatch(/^\d{4}-\d\d$/);
  });
});
