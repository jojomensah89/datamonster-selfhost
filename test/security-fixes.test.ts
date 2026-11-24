import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error jsdom ships no types
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToken } from '../src/agent/tokens';
import { snapshotText, type Realtime } from '../src/dashboard/lib/realtime';
import { createSession, utcMonth } from '../src/worker/auth';
import { forgetAllSites, type Env, type Site } from '../src/worker/env';
import app from '../src/worker/index';
import { realtime } from '../src/worker/stats';
import { makeD1 } from './helpers/d1';

const DAY = 86_400_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
const DODO = 'whsec_' + Buffer.from('dodo-secret').toString('base64');
const STRIPE = 'whsec_stripe';

afterEach(() => vi.unstubAllGlobals());

/** Two customers: `a` with sites a1 and a2, `b` with site b1. */
function setup(overrides: Partial<Env> = {}) {
  const db = makeD1();
  forgetAllSites();
  const future = Date.now() + 30 * DAY;
  db.raw.exec(
    `INSERT INTO users (id, email, google_sub, created_at, plan_status, plan_until) VALUES
       ('a', 'a@example.com', 'sub-a', 0, 'active', ${future}), ('b', 'b@example.com', 'sub-b', 0, 'active', ${future});
     INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id, dodo_webhook_secret, stripe_webhook_secret) VALUES
       ('siteaaa1', 'A1', 'a1.example.com', 'UTC', 'USD', 'k1', 0, 'a', '${DODO}', '${STRIPE}'),
       ('siteaaa2', 'A2', 'a2.example.com', 'UTC', 'USD', 'k2', 0, 'a', '${DODO}', NULL),
       ('sitebbb1', 'B1', 'b1.example.com', 'UTC', 'USD', 'k3', 0, 'b', '${DODO}', '${STRIPE}'),
       ('sitebbb2', 'B2', 'b2.example.com', 'UTC', 'USD', 'k4', 0, 'b', '${DODO}', NULL);`,
  );
  const env = {
    DB: db.d1, SESSION_SECRET: 'secret', ADMIN_PASSWORD: 'pw', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec',
    POLAR_PRODUCT_ID: 'prod', POLAR_ACCESS_TOKEN: 'token', ...overrides,
  } as Env;
  const call = (path: string, init: RequestInit = {}) => app.request('https://dm.test' + path, init, env, { waitUntil() {} } as never);
  const as = async (subject: string, path: string, method = 'GET', json?: unknown) =>
    call(path, { method, headers: { cookie: 'dm_auth=' + (await createSession(env, subject)) }, body: json === undefined ? undefined : JSON.stringify(json) });
  const event = (body: Record<string, unknown>, ip = '203.0.113.5') =>
    call('/api/event', { method: 'POST', headers: { 'user-agent': UA, 'cf-connecting-ip': ip }, body: JSON.stringify(body) });
  const standard = (path: string, secret: string, data: unknown) => {
    const body = JSON.stringify(data), ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`evt.${ts}.${body}`).digest('base64');
    return call(path, { method: 'POST', headers: { 'webhook-id': 'evt', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body });
  };
  const stripe = (site: string, data: unknown) => {
    const body = JSON.stringify(data), t = Math.floor(Date.now() / 1000);
    return call('/api/webhooks/stripe/' + site, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', STRIPE).update(`${t}.${body}`).digest('hex')}` }, body });
  };
  const count = (sql: string, ...p: (string | number)[]) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...p) as { n: number }).n);
  return { db, env, call, as, event, dodo: (site: string, d: unknown) => standard('/api/webhooks/dodo/' + site, DODO, d), stripe, count };
}

describe('1. losing the Google settings never opens every account', () => {
  it.each([
    ['one Google value left', { GOOGLE_CLIENT_SECRET: undefined }],
    ['HOSTED_MODE set, both gone', { HOSTED_MODE: 'true', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }],
  ])('%s: customers stay separate and nobody signs in', async (_n, missing) => {
    const { db, call, as } = setup(missing);
    const { secret } = await createToken(db.d1, 'a', { name: 't', scopes: 'read' });
    const sites = await call('/api/agent/v1/list_sites', { headers: { authorization: `Bearer ${secret}` } });
    expect(((await sites.json()) as { sites: { id: string }[] }).sites.map((s) => s.id)).toEqual(['siteaaa1', 'siteaaa2']);
    expect(((await (await as('u:b', '/api/sites')).json()) as { id: string }[]).map((s) => s.id)).toEqual(['sitebbb1', 'sitebbb2']);
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }) })).status).toBe(400);
    const start = await call('/api/auth/google');
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(/^\/\?login_error=/);
  });

  it('every hosted setting gone: a customer token is refused, the single owner token still works', async () => {
    const { db, call } = setup({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
    const customer = await createToken(db.d1, 'a', { name: 't', scopes: 'read' });
    const owner = await createToken(db.d1, 'admin', { name: 't', scopes: 'read' });
    const list = (s: string) => call('/api/agent/v1/list_sites', { headers: { authorization: `Bearer ${s}` } });
    expect((await list(customer.secret)).status).toBe(401);
    expect(((await (await list(owner.secret)).json()) as { sites: unknown[] }).sites).toHaveLength(4);
  });
});

// 2. One subscription never ends another: test/billing.test.ts.

describe("3. one customer can't touch another's payments", () => {
  const checkout = (vid: string | null, customer: string | null) => ({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_' + vid + customer, mode: 'payment', payment_intent: 'pi_' + vid + customer, payment_status: 'paid', amount_total: 500, currency: 'usd', customer, metadata: vid ? { dm_visitor_id: vid } : {} } },
  });
  it('a visitor or customer id seen on another account does not hide a Stripe payment', async () => {
    const { db, stripe, count } = setup();
    db.raw.exec(`INSERT INTO visitors (site_id, id, first_seen) VALUES ('sitebbb1', 'victim-visitor', 0);
      INSERT INTO payments (id, site_id, provider, ts, amount, currency, customer_id) VALUES ('sitebbb1:x', 'sitebbb1', 'stripe', 1, 1, 'USD', 'cus_victim');`);
    await stripe('siteaaa1', checkout('victim-visitor', null));
    await stripe('siteaaa1', checkout(null, 'cus_victim'));
    expect(count("payments WHERE site_id = 'siteaaa1'")).toBe(2);
  });
  it("the owner's own other site is still told apart", async () => {
    const { db, stripe, count } = setup();
    db.raw.exec("INSERT INTO visitors (site_id, id, first_seen) VALUES ('siteaaa2', 'sibling-visitor', 0)");
    await stripe('siteaaa1', checkout('sibling-visitor', null));
    expect(count("payments WHERE site_id = 'siteaaa1'")).toBe(0);
  });
  const dodoPayment = (id: string, vid?: string) => ({ type: 'payment.succeeded', data: { payment_id: id, total_amount: 900, currency: 'USD', product_cart: [{ product_id: 'pdt_x' }], metadata: vid ? { dm_visitor_id: vid } : {} } });
  it('a visitor id seen on another account does not hide a Dodo payment', async () => {
    const { db, dodo, count } = setup();
    db.raw.exec("INSERT INTO visitors (site_id, id, first_seen) VALUES ('sitebbb1', 'victim-visitor', 0)");
    await dodo('siteaaa1', dodoPayment('pay_hidden', 'victim-visitor'));
    expect(count("pending_payments WHERE site_id = 'siteaaa1'")).toBe(1);
  });
  it("claiming a product does not delete another account's waiting payment", async () => {
    const { dodo, as, count } = setup();
    await dodo('siteaaa1', dodoPayment('pay_same'));
    await dodo('siteaaa2', dodoPayment('pay_same'));
    await dodo('sitebbb1', dodoPayment('pay_same'));
    await as('u:b', '/api/sites/sitebbb1/pending-payments', 'POST', { product_id: 'pdt_x' });
    expect(count("payments WHERE site_id = 'sitebbb1'")).toBe(1);
    expect(count("pending_payments WHERE site_id IN ('siteaaa1', 'siteaaa2')")).toBe(2);
    // The owner's own copies still go when one of their sites claims it.
    await as('u:a', '/api/sites/siteaaa1/pending-payments', 'POST', { product_id: 'pdt_x' });
    expect(count('pending_payments')).toBe(0);
    expect(count("payments WHERE site_id = 'siteaaa1'")).toBe(1);
  });
});

describe('4. Google sign-in goes by the Google account, not the email', () => {
  async function signIn(t: ReturnType<typeof setup>, claims: Record<string, unknown>) {
    const token = `h.${btoa(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'gid', email_verified: true, ...claims }))}.s`;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id_token: token })));
    const res = await t.call('/api/auth/google/callback?state=s&code=c', { headers: { cookie: 'dm_oauth=s' } });
    return { to: res.headers.get('location')!, session: (res.headers.get('set-cookie') ?? '').includes('dm_auth=') };
  }
  it('refuses a different Google account with the same email, and keeps the first one', async () => {
    const t = setup();
    const r = await signIn(t, { sub: 'someone-else', email: 'A@example.com' });
    expect(r.to).toMatch(/^\/\?login_error=/);
    expect(r.session).toBe(false);
    expect(t.db.raw.prepare("SELECT google_sub FROM users WHERE id = 'a'").get()).toEqual({ google_sub: 'sub-a' });
  });
  it.each([undefined, 'false', 'true', 1])('refuses an email Google has not verified (%s)', async (email_verified) => {
    const r = await signIn(setup(), { sub: 'new', email: 'new@example.com', email_verified });
    expect(r).toMatchObject({ session: false });
  });
  it('lets the same Google account in, also after its email changed, but not onto a taken email', async () => {
    const t = setup();
    expect(await signIn(t, { sub: 'sub-a', email: 'a@example.com' })).toMatchObject({ to: '/', session: true });
    expect(await signIn(t, { sub: 'sub-a', email: 'moved@example.com' })).toMatchObject({ to: '/', session: true });
    expect(t.db.raw.prepare("SELECT email FROM users WHERE id = 'a'").get()).toEqual({ email: 'moved@example.com' });
    expect(await signIn(t, { sub: 'sub-a', email: 'b@example.com' })).toMatchObject({ session: false });
    expect(await signIn(t, { sub: 'brand-new', email: 'new@example.com' })).toMatchObject({ to: '/?signup=1', session: true });
  });
});

describe('5. an ended plan is Free', () => {
  it('keeps the dashboard, for their own sites only', async () => {
    const { db, as } = setup();
    db.raw.exec("UPDATE users SET plan_until = 1 WHERE id = 'a'");
    for (const p of ['/api/sites', '/api/sites-overview', '/api/sites/siteaaa1', '/api/sites/siteaaa1/links', '/api/sites/siteaaa1/overview', '/api/agent-audit']) expect([p, (await as('u:a', p)).status]).toEqual([p, 200]);
    for (const p of ['/api/sites/sitebbb1', '/api/sites/sitebbb1/links', '/api/sites/sitebbb1/overview']) expect([p, (await as('u:a', p)).status]).toEqual([p, 404]);
  });
  it('still allows checkout, the billing page, revoking agents and deleting a site; other customers are unaffected', async () => {
    const { db, as, count } = setup();
    db.raw.exec("UPDATE users SET plan_until = 1 WHERE id = 'a'");
    const { token } = await createToken(db.d1, 'a', { name: 't' });
    db.raw.exec("INSERT INTO plan_subscriptions (id, user_id, status, until, updated_at) VALUES ('s', 'a', 'expired', 1, 1)");
    vi.stubGlobal('fetch', async (u: string) => new Response(JSON.stringify(u.includes('customer-sessions') ? { customer_portal_url: 'https://polar.sh/p' } : { url: 'https://polar.sh/c' }), { status: 201 }));
    expect((await as('u:a', '/api/billing/checkout')).headers.get('location')).toBe('https://polar.sh/c');
    expect((await as('u:a', '/api/billing/portal')).headers.get('location')).toBe('https://polar.sh/p');
    expect((await as('u:a', '/api/agent-tokens')).status).toBe(200);
    expect((await as('u:a', '/api/agent-tokens/' + token.id, 'DELETE')).status).toBe(200);
    expect((await as('u:a', '/api/sites/sitebbb1', 'DELETE')).status).toBe(404);
    expect((await as('u:a', '/api/sites/siteaaa1', 'DELETE')).status).toBe(200);
    expect(count("sites WHERE owner_id = 'a'")).toBe(1);
    expect((await as('u:b', '/api/sites/sitebbb1/links')).status).toBe(200);
  });
});

describe("6. fake events can't use up the month from one address", () => {
  const hit = (n: number) => ({ w: 'siteaaa1', t: 'identify', vid: 'visitor' + n + 'xx', sid: 'session' + n, u: 'https://a1.example.com/', p: {} });
  it('stops one address at its daily share; others and pings carry on', async () => {
    const { event, count, db } = setup({ PLAN_ADDRESS_DAILY_LIMIT: '3' });
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push((await event(hit(i))).status);
    expect(out).toEqual([202, 202, 202, 429, 429, 429]);
    const used = () => db.raw.prepare('SELECT events FROM usage_monthly WHERE owner_id = ? AND month = ?').get('a', utcMonth());
    expect(used()).toEqual({ events: 3 });
    expect((await event(hit(9), '203.0.113.6')).status).toBe(202);
    expect(used()).toEqual({ events: 4 });
    expect((await event({ ...hit(1), t: 'ping', d: 1000 })).status).toBe(202);
    // The month is shared by the owner's sites, so the limit is too. Another owner's is separate.
    expect((await event({ ...hit(1), w: 'siteaaa2', u: 'https://a2.example.com/' })).status).toBe(429);
    expect((await event({ ...hit(1), w: 'sitebbb1', u: 'https://b1.example.com/' })).status).toBe(202);
    expect(count("event_sources WHERE key LIKE '%203.0%'")).toBe(0);
  });
  it('counts a whole IPv6 /64 as one address', async () => {
    const { event } = setup({ PLAN_ADDRESS_DAILY_LIMIT: '2' });
    expect((await event(hit(1), '2001:db8:1:2::1')).status).toBe(202);
    expect((await event(hit(2), '2001:0db8:0001:0002:aaaa::9')).status).toBe(202);
    expect((await event(hit(3), '2001:db8:1:2:ffff:1:2:3')).status).toBe(429);
    expect((await event(hit(4), '2001:db8:1:3::1')).status).toBe(202);
  });
  it('by default one address cannot reach the hard limit in a month', async () => {
    const { planLimits } = await import('../src/worker/auth');
    const l = planLimits({} as Env);
    expect(l.addressDailyLimit * 31).toBeLessThan(l.hardEventLimit);
  });
  it('drops old counts every hour', async () => {
    const { db, env, count } = setup();
    db.raw.exec("INSERT INTO event_sources (key, day, events) VALUES ('old', '2026-01-01', 5), ('now', '2026-01-02', 5)");
    const { pruneEventSourcesJob } = await import('../src/cron/prune-event-sources');
    await pruneEventSourcesJob(env, Date.UTC(2026, 0, 2, 3));
    expect(count('event_sources')).toBe(1);
  });
});

describe('7. page HTML cannot redirect the scripts', () => {
  const load = (file: string, html: string) => {
    const dom = new JSDOM(`<!doctype html><body>${html}<datamonster-online site="s"></datamonster-online></body>`, { url: 'https://shop.example/', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const d = window.document;
    // jsdom runs no <script> here, so stand in for the browser: the real getter says which script is running...
    const real = d.createElement('script');
    real.src = `https://dm.test/js/${file}`;
    real.setAttribute('data-website-id', 'siteaaa1');
    Object.defineProperty(window.Document.prototype, 'currentScript', { configurable: true, get: () => real });
    // ...and the named image shadows it on the document, as browsers do.
    Object.defineProperty(d, 'currentScript', { configurable: true, value: d.querySelector('[name=currentScript]') });
    const calls: string[] = [];
    (window as unknown as { fetch: unknown }).fetch = (u: string) => (calls.push(u), Promise.resolve({ ok: false }));
    window.matchMedia ??= (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
    window.Element.prototype.getAnimations ??= (() => []) as never;
    (window.ShadowRoot.prototype as unknown as { getAnimations: unknown }).getAnimations ??= () => [];
    window.eval(readFileSync(`public/js/${file}`, 'utf8'));
    return { scripts: [...d.querySelectorAll('script')].map((s) => s.src), calls };
  };
  const evil = '<img name="currentScript" src="https://evil.example/js/x.js" data-website-id="evilsite" data-api="https://evil.example/api">';
  it('tracker loads the widget from its own address and reports there', () => {
    const { scripts, calls } = load('script.js', evil);
    expect(scripts.filter((s) => s.endsWith('/js/widget.js'))).toEqual(['https://dm.test/js/widget.js']);
    expect(calls).toEqual(['https://dm.test/api/event']);
  });
  it('widget asks its own address', () => {
    const { calls } = load('widget.js', evil);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.startsWith('https://dm.test/'))).toBe(true);
  });
});

describe('8. signing out ends the session', () => {
  const me = async (t: ReturnType<typeof setup>, cookie: string) => ((await (await t.call('/api/auth/me', { headers: { cookie } })).json()) as { loggedIn: boolean }).loggedIn;
  it.each([['u:a', {}], ['admin', { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }]] as const)('a copied %s cookie stops working; other sessions stay', async (subject, o) => {
    const t = setup(o);
    const cookie = 'dm_auth=' + (await createSession(t.env, subject)), other = 'dm_auth=' + (await createSession(t.env, subject));
    expect(await me(t, cookie)).toBe(true);
    await t.call('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(await me(t, cookie)).toBe(false);
    expect(await me(t, other)).toBe(true);
  });
  it('changing the password ends password sessions', async () => {
    const t = setup({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
    const cookie = 'dm_auth=' + (await createSession(t.env, 'admin'));
    expect(await me(t, cookie)).toBe(true);
    t.env.ADMIN_PASSWORD = 'changed';
    expect(await me(t, cookie)).toBe(false);
  });
  it('a real password login works and an expired, edited or old-style cookie does not', async () => {
    const t = setup({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
    const login = await t.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }) });
    expect(await me(t, login.headers.get('set-cookie')!.split(';')[0])).toBe(true);
    expect(await me(t, 'dm_auth=' + (await createSession(t.env, 'admin', Date.now() - 2 * DAY, DAY)))).toBe(false);
    const good = await createSession(t.env, 'admin');
    expect(await me(t, 'dm_auth=' + good.replace(/\.(\d+)\./, (_m, e) => `.${Number(e) + 1}.`))).toBe(false);
    const { signToken } = await import('../src/worker/lib/crypto');
    for (const v of ['admin', `admin.${Date.now() + DAY}`]) expect(await me(t, 'dm_auth=' + (await signToken('secret', v)))).toBe(false);
  });
});

describe('9. Copy snapshot leaves emails out', () => {
  it('wherever a visitor put one, and keeps every entry on one line', async () => {
    const { db } = setup();
    const now = Date.now();
    db.raw.exec(`INSERT INTO visitors (site_id, id, first_seen, email, name) VALUES ('siteaaa1', 'v-1', 0, 'hidden@one.example', NULL), ('siteaaa1', 'v-2', 0, NULL, 'named@two.example');
      INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel, exit_page) VALUES ('siteaaa1', 's1', 'v-1', ${now}, ${now}, 'src@three.example', 'Direct', '/u/path%40four.example/x'), ('siteaaa1', 's2', 'v-2', ${now}, ${now}, 'X', 'Direct', '/');
      INSERT INTO payments (id, site_id, provider, ts, amount, currency, email) VALUES ('siteaaa1:p', 'siteaaa1', 'dodo', ${now}, 500, 'USD', 'buyer@five.example');`);
    db.raw.prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path) VALUES ('siteaaa1', 's1', 'v-1', ?, 'goal', ?, '/')").run(now, 'done\n- 2026 forged entry\u2028more');
    const site = { id: 'siteaaa1', name: 'A1', domain: 'a1.example.com', timezone: 'UTC', currency: 'USD' } as Site;
    const data = (await realtime(db.d1, site, now)) as unknown as Realtime;
    const text = snapshotText(site, data);
    expect(text).not.toMatch(/@|%40/);
    expect(text).not.toMatch(/(one|two|three|four|five)\.example/);
    expect(text.split(/[\n\u2028]/).some((l) => l.startsWith('- 2026 forged'))).toBe(false);
    expect(text).toContain('Unlinked customer paid');
    // The dashboard itself still knows who it is.
    expect(data.feed.map((f) => f.email)).toEqual(expect.arrayContaining(['hidden@one.example', 'buyer@five.example']));
  });
});

describe('10. the activity log always shows what was done', () => {
  async function write(args: Record<string, unknown>, tool = 'enable_online_widget') {
    const { db, call } = setup();
    db.raw.exec("DELETE FROM sites WHERE id = 'siteaaa2'");
    const { secret } = await createToken(db.d1, 'a', { name: 't', scopes: 'read write' });
    const res = await call('/api/agent/v1/' + tool, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(args) });
    return { status: res.status, row: db.raw.prepare('SELECT site_id, args, ok FROM agent_audit').get() as { site_id: string; args: string; ok: number } };
  }
  it('keeps valid JSON, with long values shortened, and names the site that was used', async () => {
    const { status, row } = await write({ text: 'Raised prices', day: '2026-11-01' }, 'add_annotation');
    expect(status).toBe(400); // site_id is required for this tool
    expect(JSON.parse(row.args)).toEqual({ text: 'Raised prices', day: '2026-11-01' });
    const r = await write({ site_id: 'siteaaa1', origin: 'https://dm.test/' + 'x'.repeat(1900), visitors: true });
    expect(r.status).toBe(200);
    expect(r.row).toMatchObject({ site_id: 'siteaaa1', ok: 1 });
    expect(JSON.parse(r.row.args)).toMatchObject({ visitors: true, origin: expect.stringMatching(/^https:\/\/dm\.test\/x+… \(1916 characters\)$/) });
  });
  it.each([{ origin: 'https://dm.test/' + 'x'.repeat(5000) }, { origin: 'x', visitors: Array(9000).fill('y') }])('refuses oversized arguments and still logs readable ones', async (extra) => {
    const { status, row } = await write({ site_id: 'siteaaa1', enabled: true, ...extra });
    expect(status).toBe(400);
    expect(row.ok).toBe(0);
    expect(row.args.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(row.args)).toMatchObject({ enabled: true });
  });
  it('names the only site when a read leaves it out', async () => {
    expect((await write({}, 'get_overview')).row.site_id).toBe('siteaaa1');
  });
});

describe('11. tracking events never move waiting payments', () => {
  it('not by a checkout click, nor by a return page', async () => {
    const { dodo, event, count } = setup();
    const payment = { type: 'payment.succeeded', data: { payment_id: 'pay_waiting', total_amount: 900, currency: 'USD', product_cart: [{ product_id: 'pdt_x' }], metadata: {} } };
    await dodo('siteaaa1', payment);
    await dodo('siteaaa2', payment);
    const base = { w: 'siteaaa2', vid: 'fakevisitor', sid: 'fakesession' };
    await event({ ...base, t: 'outbound', n: 'https://checkout.dodopayments.com/buy/pdt_x', u: 'https://a2.example.com/' });
    await event({ ...base, t: 'pageview', u: 'https://a2.example.com/thanks?payment_id=pay_waiting' });
    expect(count('pending_payments')).toBe(2);
    expect(count('payments')).toBe(0);
    expect(count('dodo_products')).toBe(0);
  });
  it('a signed payment with a visitor still places the product by itself', async () => {
    const { db, dodo, count } = setup();
    db.raw.exec("INSERT INTO visitors (site_id, id, first_seen) VALUES ('siteaaa1', 'realvisitor', 0)");
    const pay = (id: string, vid?: string) => ({ type: 'payment.succeeded', data: { payment_id: id, total_amount: 900, currency: 'USD', product_cart: [{ product_id: 'pdt_x' }], metadata: vid ? { dm_visitor_id: vid } : {} } });
    await dodo('siteaaa1', pay('pay_first'));
    await dodo('siteaaa2', pay('pay_first'));
    await dodo('siteaaa1', pay('pay_second', 'realvisitor'));
    expect(count('pending_payments')).toBe(0);
    expect(count("payments WHERE site_id = 'siteaaa1'")).toBe(2);
  });
});
