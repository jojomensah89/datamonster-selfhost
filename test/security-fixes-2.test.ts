import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpTools } from '../src/agent';
import { pkceChallenge } from '../src/agent/oauth';
import { placementsWithStats, updatePlacement, urlProblem, verifyPlacement, visibleText, type Placement } from '../src/agent/placements';
import { createToken } from '../src/agent/tokens';
import { duePlacements, makeVerifyPlacementsJob } from '../src/cron/verify-placements';
import { createSession, utcMonth } from '../src/worker/auth';
import { cacheSizes, forgetAllSites, getSite, type Env, type Site } from '../src/worker/env';
import app from '../src/worker/index';
import { recordPayment, REMATCH_BATCH, rematchPayments } from '../src/worker/payments';
import { breakdown, funnel, overview, pathMatcher, type Ctx } from '../src/worker/stats';
import { resolveRange } from '../src/worker/lib/time';
import { makeD1 } from './helpers/d1';

const DAY = 86_400_000, HOUR = 3_600_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
afterEach(() => vi.unstubAllGlobals());

function setup(overrides: Partial<Env> = {}) {
  const db = makeD1();
  forgetAllSites();
  const future = Date.now() + 30 * DAY;
  db.raw.exec(
    `INSERT INTO users (id, email, google_sub, created_at, plan_status, plan_until) VALUES ('a', 'a@example.com', 'sub-a', 0, 'active', ${future}), ('b', 'b@example.com', 'sub-b', 0, 'active', ${future}), ('adm', 'admin@example.com', 'sub-c', 0, 'none', NULL), ('old', 'old@example.com', 'sub-d', 0, 'expired', 1);
     INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id, stripe_webhook_secret) VALUES
       ('siteaaa1', 'A1', 'a1.example.com', 'UTC', 'USD', 'k1', 0, 'a', 'whsec_s'), ('sitebbb1', 'B1', 'b1.example.com', 'UTC', 'USD', 'k2', 0, 'b', NULL),
       ('siteadm1', 'Adm', 'adm.example.com', 'UTC', 'USD', 'k3', 0, 'adm', NULL), ('siteold1', 'Old', 'old.example.com', 'UTC', 'USD', 'k4', 0, 'old', NULL);`,
  );
  const env = { DB: db.d1, SESSION_SECRET: 'secret', ADMIN_PASSWORD: 'pw', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', ADMIN_EMAILS: 'admin@example.com', ...overrides } as Env;
  const call = (path: string, init: RequestInit = {}) => app.request('https://dm.test' + path, init, env, { waitUntil() {} } as never);
  const as = async (subject: string, path: string, method = 'GET', json?: unknown) =>
    call(path, { method, headers: { cookie: 'dm_auth=' + (await createSession(env, subject)) }, body: json === undefined ? undefined : JSON.stringify(json) });
  const event = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    call('/api/event', { method: 'POST', headers: { 'user-agent': UA, 'cf-connecting-ip': '203.0.113.5', ...headers }, body: JSON.stringify({ w: 'siteaaa1', t: 'pageview', u: 'https://a1.example.com/', vid: 'visitor01', sid: 'session01', ...body }) });
  const count = (sql: string, ...p: (string | number)[]) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...p) as { n: number }).n);
  const site = async (id = 'siteaaa1') => (await getSite(db.d1, id)) as Site;
  const place = (id: string, siteId: string, o: { created?: number; attempt?: number | null; url?: string } = {}) =>
    db.raw.prepare("INSERT INTO placements (id, site_id, name, listing_url, status, match_source, last_attempt_at, last_checked_at, created_by, created_at) VALUES (?, ?, ?, ?, 'live', ?, ?, ?, 'owner', ?)").run(id, siteId, id, o.url ?? `https://dir.example.org/${id}`, id, o.attempt ?? null, o.attempt ?? null, o.created ?? 0);
  const placement = (id: string) => db.raw.prepare('SELECT * FROM placements WHERE id = ?').get(id) as unknown as Placement;
  return { db, env, call, as, event, count, site, place, placement };
}
const ctx = (db: ReturnType<typeof makeD1>, site: Partial<Site> = { id: 'siteaaa1', currency: 'USD', timezone: 'UTC' }) =>
  ({ db: db.d1, site, range: { from: 0, to: 9e12, granularity: 'day' }, filters: {}, offset: 0 }) as unknown as Ctx;

describe('listing checks: a crafted page cannot stall them', () => {
  it('reads hostile pages of 1 MB in well under a second', () => {
    for (const unit of ['<svg', '<svg ', '<script>', '<', '<a <', '&amp', '</svg', '<template><svg>', '<!--']) {
      const started = performance.now();
      visibleText(unit.repeat(Math.floor(1_000_000 / unit.length)));
      expect([unit, performance.now() - started < 1500]).toEqual([unit, true]);
    }
  });
  it('still gives the same text for ordinary pages', () => {
    expect(visibleText('<style>a{}</style><p>Hello&nbsp;<b>there</b></p><script>var x="<p>no</p>"</script> friend <svg><text>no</text></svg ><svgfoo>yes</svgfoo>')).toBe('Hello there friend yes');
    expect(visibleText('one <SCRIPT src=x>two</SCRIPT> three <svg> unclosed text stays')).toBe('one three unclosed text stays');
  });
  it('records the attempt before fetching, so a stopped check goes to the back', async () => {
    const { env, db, place, site, placement } = setup();
    place('p', 'siteaaa1');
    const now = 100 * DAY;
    let seen: unknown;
    const fetch = (async () => { seen = placement('p').last_attempt_at; throw new Error('worker stopped'); }) as never;
    await verifyPlacement(db.d1, await site(), placement('p'), { now, fetch });
    expect(seen).toBe(now);
    expect((await duePlacements(env, now + 30 * HOUR)).map((d) => d.placement.id)).toEqual(['p']);
  });
  it('two checks at once fetch once', async () => {
    const { db, place, site, placement } = setup();
    place('p', 'siteaaa1');
    const fetch = vi.fn(async () => new Response('a1.example.com', { headers: { 'content-type': 'text/html' } }));
    const s = await site(), p = placement('p');
    const r = await Promise.all([1, 2, 3].map(() => verifyPlacement(db.d1, s, p, { now: 100 * DAY, fetch: fetch as never })));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.filter((x) => x.checked)).toHaveLength(1);
    expect(r[0].placement).not.toHaveProperty('last_attempt_at');
  });
});

describe('listing checks: owners take turns', () => {
  it('one owner with many launches leaves room for the rest; admins and ownerless sites count, lapsed ones do not', async () => {
    const { env, place, db } = setup();
    db.raw.exec("INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES ('sitenone', 'N', 'n.example.com', 'UTC', 'USD', 'k9', 0)");
    for (let i = 0; i < 20; i++) place('a' + String(i).padStart(2, '0'), 'siteaaa1', { created: i });
    place('b1', 'sitebbb1', { created: 5000 });
    place('m1', 'siteadm1', { created: 5001 });
    place('n1', 'sitenone', { created: 5002 });
    place('o1', 'siteold1', { created: 1 });
    const ids = (await duePlacements(env, 100 * DAY)).map((d) => d.placement.id);
    expect(ids).toHaveLength(8);
    expect(ids.slice(0, 4).sort()).toEqual(['a00', 'b1', 'm1', 'n1']);
    expect(ids).not.toContain('o1');
  });
  it('editing a URL does not move a launch up the queue or skip the wait', async () => {
    const { env, db, place, site, placement } = setup();
    const now = 100 * DAY;
    place('waiting', 'siteaaa1', { attempt: now - 30 * HOUR });
    place('edited', 'siteaaa1', { attempt: now - 10_000 });
    await updatePlacement(db.d1, await site(), 'edited', { listing_url: 'https://dir.example.org/new' }, now);
    expect(placement('edited').last_checked_at).toBeNull();
    expect((await duePlacements(env, now)).map((d) => d.placement.id)).toEqual(['waiting', 'edited']);
    expect((await verifyPlacement(db.d1, await site(), placement('edited'), { now, fetch: (async () => { throw new Error('fetched'); }) as never })).checked).toBe(false);
  });
  it('a new launch does not jump ahead of overdue ones', async () => {
    const { env, place } = setup();
    const now = 100 * DAY;
    place('overdue', 'siteaaa1', { attempt: now - 30 * HOUR });
    place('fresh', 'siteaaa1', { created: now });
    expect((await duePlacements(env, now)).map((d) => d.placement.id)).toEqual(['overdue', 'fresh']);
  });
  it('the job still works through everything', async () => {
    const { env, place, count } = setup();
    for (let i = 0; i < 20; i++) place('a' + i, i % 2 ? 'siteaaa1' : 'sitebbb1');
    const job = makeVerifyPlacementsJob({ pauseMs: 0, fetch: (async () => new Response('x', { headers: { 'content-type': 'text/html' } })) as never });
    for (let h = 0; h < 3; h++) await job(env, 100 * DAY + h * HOUR);
    expect(count('placements WHERE last_checked_at IS NOT NULL')).toBe(20);
  });
});

describe('listing checks: hosts that point inside', () => {
  it.each(['http://metadata.goog/', 'https://localhost.localdomain/', 'https://127.0.0.1.nip.io/', 'https://10-0-0-1.sslip.io/', 'https://app.localtest.me/', 'https://x.svc/', 'https://a.lvh.me/', 'https://kubernetes.default.svc.cluster.local/'])('refuses %s', (u) => expect(urlProblem(new URL(u))).toBeTruthy());
  it.each(['https://www.producthunt.com/posts/x', 'https://news.ycombinator.com/item?id=1', 'https://my-app.workers.dev/', 'https://google.com/', 'https://alternativeto.net/'])('allows %s', (u) => expect(urlProblem(new URL(u))).toBeNull());
});

describe('server-side goals follow the plan', () => {
  const goal = (t: ReturnType<typeof setup>, key = 'k1') => t.call('/api/v1/goals', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify({ visitor_id: 'v1', name: 'signup' }) });
  const visit = (t: ReturnType<typeof setup>, site: string) => t.db.raw.exec(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel, exit_page) VALUES ('${site}', 's1', 'v1', 1, 1, 'X', 'Direct', '/')`);
  it('counts toward the month and stops at the hard limit', async () => {
    const t = setup({ PLAN_EVENT_LIMIT: '2', PLAN_EVENT_HARD_MULTIPLIER: '1' });
    visit(t, 'siteaaa1');
    expect([(await goal(t)).status, (await goal(t)).status, (await goal(t)).status]).toEqual([200, 200, 429]);
    expect(t.db.raw.prepare('SELECT events FROM usage_monthly WHERE owner_id = ? AND month = ?').get('a', utcMonth())).toEqual({ events: 2 });
    expect(t.count("events WHERE type = 'goal'")).toBe(2);
  });
  it('follows Free after the plan has ended; admins and single-owner installs have no limit', async () => {
    const t = setup({ PLAN_EVENT_LIMIT: '1', PLAN_EVENT_HARD_MULTIPLIER: '1', FREE_EVENT_LIMIT: '2' });
    for (const s of ['siteold1', 'siteadm1']) visit(t, s);
    expect([(await goal(t, 'k4')).status, (await goal(t, 'k4')).status, (await goal(t, 'k4')).status]).toEqual([200, 200, 429]);
    expect([(await goal(t, 'k3')).status, (await goal(t, 'k3')).status]).toEqual([200, 200]);
    const self = setup({ PLAN_EVENT_LIMIT: '1', PLAN_EVENT_HARD_MULTIPLIER: '1', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
    visit(self, 'siteold1');
    expect([(await goal(self, 'k4')).status, (await goal(self, 'k4')).status]).toEqual([200, 200]);
  });
});

describe('made-up site ids', () => {
  it('are never kept without end, do not push out real sites, and bad shapes are not looked up', async () => {
    const { db } = setup();
    expect((await getSite(db.d1, 'siteaaa1'))?.id).toBe('siteaaa1');
    const prepare = vi.spyOn(db.d1, 'prepare');
    for (const bad of ['', 'x'.repeat(65), 'a/b', "a'b"]) expect(await getSite(db.d1, bad)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    for (let i = 0; i < 2500; i++) await getSite(db.d1, 'made-up-' + i);
    expect(cacheSizes().missing).toBeLessThanOrEqual(2000);
    prepare.mockClear();
    await getSite(db.d1, 'siteaaa1');
    await getSite(db.d1, 'made-up-2499');
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('the public online count', () => {
  const writes = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([q]) => /^\s*(INSERT|DELETE|UPDATE)/i.test(String(q))).length;
  it('writes nothing for missing or switched-off sites, nor once an address is over the limit', async () => {
    const { db, call } = setup();
    const get = (id: string) => call('/api/public/online/' + id, { headers: { 'cf-connecting-ip': '198.51.100.77' } });
    const spy = vi.spyOn(db.d1, 'prepare');
    for (const id of ['siteaaa1', 'nothere', 'x'.repeat(200)]) expect((await get(id)).status).toBe(404);
    expect(writes(spy)).toBe(0);
    db.raw.exec("UPDATE sites SET widget_enabled = 1 WHERE id = 'siteaaa1'");
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await get('siteaaa1')).status;
    expect(last).toBe(429);
    spy.mockClear();
    expect((await get('siteaaa1')).status).toBe(429);
    expect(writes(spy)).toBe(0);
  });
});

describe('funnel wildcards', () => {
  it('match like before, and stay fast with many of them', () => {
    const cases: [string, string, boolean][] = [['/blog/*', '/blog/x/y', true], ['/blog/*', '/blog', false], ['*/thanks', '/a/thanks', true], ['/a*b*c', '/a1b2c', true], ['/a*b*c', '/acb', false], ['/a*a', '/a', false], ['*', '/x', true], ['/p?x[1]', '/p?x[1]', true], ['/a**b', '/axb', true], ['/ab*ba', '/aba', false]];
    for (const [p, s, want] of cases) expect([p, s, pathMatcher(p)(s)]).toEqual([p, s, want]);
    const started = performance.now();
    const m = pathMatcher('/' + 'a*'.repeat(99) + 'b');
    for (let i = 0; i < 2000; i++) m('/' + 'a'.repeat(499));
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it('the whole funnel counts the right visitors for short, long and odd patterns', async () => {
    const { db } = setup();
    const add = (v: string, ts: number, path: string) => db.raw.prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, path) VALUES ('siteaaa1', ?, ?, ?, 'pageview', ?)").run(v, v, ts, path);
    const long = '/docs/' + 'section/'.repeat(8);
    add('v1', 1, '/blog/one'); add('v1', 2, long + 'end'); add('v2', 1, '/blog/two'); add('v2', 2, '/other'); add('v3', 1, '/q[1]?');
    const run = async (...values: string[]) => (await funnel(ctx(db), values.map((value) => ({ type: 'page' as const, value })))).map((s) => s.visitors);
    expect(await run('/blog/*', long + '*')).toEqual([2, 1]);
    expect(await run('/q[1]?', '*')).toEqual([1, 0]);
    expect(await run('*/one', '*end')).toEqual([1, 1]);
  });
});

describe('heavy requests', () => {
  it('rematch works in small steps and reaches every payment', async () => {
    const { db, as, site } = setup();
    for (let i = 0; i < 45; i++) db.raw.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, email) VALUES (?, 'siteaaa1', 'api', ?, 100, 'USD', ?)").run('p' + i, 1000 + Math.floor(i / 10), i === 44 ? 'known@example.com' : null);
    db.raw.exec("INSERT INTO visitors (site_id, id, first_seen, email) VALUES ('siteaaa1', 'v', 0, 'known@example.com')");
    const first = await rematchPayments(db.d1, await site());
    expect(first).toMatchObject({ checked: REMATCH_BATCH, matched: 0 });
    let after: string | null = null, checked = 0, matched = 0, calls = 0;
    do {
      const r = (await (await as('u:a', '/api/sites/siteaaa1/rematch', 'POST', { after })).json()) as { checked: number; matched: number; next: string | null };
      [after, checked, matched, calls] = [r.next, checked + r.checked, matched + r.matched, calls + 1];
    } while (after && calls < 10);
    expect({ checked, matched, calls }).toEqual({ checked: 45, matched: 1, calls: 3 });
    for (const bad of ["' OR 1=1", 'x|y', '', 5]) expect((await as('u:a', '/api/sites/siteaaa1/rematch', 'POST', { after: bad })).status).toBe(200);
  });
  it('the launches list takes a fixed number of queries and the same figures', async () => {
    const { db, site } = setup();
    for (let i = 0; i < 60; i++) db.raw.prepare("INSERT INTO placements (id, site_id, name, status, match_source, match_domain, match_ref, created_by, created_at) VALUES (?, 'siteaaa1', ?, 'live', ?, ?, ?, 'owner', 0)").run('p' + i, 'P' + i, i === 0 ? 'product hunt' : null, i === 1 ? 'ycombinator.com' : null, i > 1 ? 'ref' + i : null);
    const sess = (id: string, v: string, source: string, dom: string | null, ref: string | null) => db.raw.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel, referrer_domain, ref) VALUES ('siteaaa1', ?, ?, 10, 10, ?, 'Referral', ?, ?)").run(id, v, source, dom, ref);
    sess('s1', 'v1', 'Product Hunt', 'producthunt.com', null); sess('s2', 'v1', 'PRODUCT HUNT', 'producthunt.com', 'ref5'); sess('s3', 'v2', 'Hacker News', 'news.ycombinator.com', null); sess('s4', 'v3', 'X', 'notycombinator.com', 'ref5');
    db.raw.exec("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES ('x1', 'siteaaa1', 'api', 20, 500, 'payment', 'USD', 'v1', 's2'), ('x2', 'siteaaa1', 'api', 21, -200, 'refund', 'USD', 'v1', 's2'), ('x3', 'siteaaa1', 'api', 22, 900, 'payment', 'EUR', 'v1', 's2')");
    const s = await site();
    const spy = vi.spyOn(db.d1, 'prepare');
    const rows = await placementsWithStats(ctx(db, s));
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    const by = new Map(rows.map((r) => [r.id, [r.visitors, r.customers, r.revenue]]));
    expect([by.get('p0'), by.get('p1'), by.get('p5'), by.get('p6')]).toEqual([[1, 1, 300], [1, 0, 0], [2, 1, 300], [0, 0, 0]]);
  });
  it('breakdowns never return more rows than asked, and keep the right revenue', async () => {
    const { db } = setup();
    for (let i = 0; i < 30; i++) {
      db.raw.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES ('siteaaa1', ?, ?, ?, 10, ?, 'Referral')").run('s' + i, 'v' + i, i < 20 ? 10 : 9_000_000_000_001, 'src' + i);
      db.raw.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, session_id) VALUES (?, 'siteaaa1', 'api', 20, ?, 'USD', ?, ?)").run('p' + i, 100 + i, 'v' + i, 's' + i);
      db.raw.prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path) VALUES ('siteaaa1', ?, ?, 10, 'goal', ?, '/')").run('s' + i, 'v' + i, 'goal' + i);
      db.raw.prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, path) VALUES ('siteaaa1', ?, ?, 10, 'pageview', ?)").run('s' + i, 'v' + i, '/p' + i);
    }
    for (const dim of ['source', 'goal', 'page']) {
      const rows = await breakdown(ctx(db), dim, 5);
      expect(rows).toHaveLength(5);
      for (const r of rows) expect([dim, r.label, r.revenue]).toEqual([dim, r.label, 100 + Number(/\d+$/.exec(r.label!)![0])]);
    }
    // Made money without a visit in the range: still listed when there is room.
    expect((await breakdown(ctx(db), 'source', 100)).filter((r) => !r.visitors)).toHaveLength(10);
    expect(await breakdown(ctx(db), 'source', Number.NaN)).toHaveLength(30);
    await expect(breakdown(ctx(db), 'toString')).rejects.toThrow(/unknown dimension/);
  });
});

describe('write tools say what reaches outside', () => {
  it('marks listing and public sharing tools open-world, and nothing else', async () => {
    const { db } = setup();
    const { token } = await createToken(db.d1, 'a', { name: 't', scopes: 'read write' });
    const open = mcpTools(token).filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort();
    expect(open).toEqual(['add_placement', 'enable_online_widget', 'update_placement', 'verify_placement']);
    expect((await createToken(db.d1, 'a', { name: 't' })).token.scopes).toEqual(['read']);
  });
});

describe('visitor location headers', () => {
  const fake = { 'x-vercel-ip-country': 'de', 'x-vercel-ip-country-region': 'R'.repeat(5000), 'x-vercel-ip-city': 'C'.repeat(5000), 'x-vercel-ip-latitude': '52.5' };
  const row = (t: ReturnType<typeof setup>, id: string) => t.db.raw.prepare('SELECT country, region, city, lat FROM sessions WHERE id = ?').get(id) as { country: string; region: string; city: string; lat: number };
  it('are ignored unless the owner turned them on, then kept short', async () => {
    const t = setup();
    await t.event({ sid: 'session01' }, fake);
    expect(row(t, 'session01')).toEqual({ country: null, region: null, city: null, lat: null });
    const r = await t.as('u:a', '/api/sites/siteaaa1', 'PATCH', { proxy_location: true });
    expect(await r.json()).toMatchObject({ proxy_location: 1 });
    expect((await t.as('u:b', '/api/sites/siteaaa1', 'PATCH', { proxy_location: false })).status).toBe(404);
    await t.event({ sid: 'session02' }, fake);
    expect(row(t, 'session02')).toEqual({ country: 'DE', region: 'R'.repeat(100), city: 'C'.repeat(100), lat: 52.5 });
    await t.event({ sid: 'session03' }, { ...fake, 'x-vercel-ip-country': 'Germany <b>' });
    expect(row(t, 'session03').country).toBeNull();
    await t.as('u:a', '/api/sites/siteaaa1', 'PATCH', { name: 'Renamed' });
    expect(t.db.raw.prepare("SELECT proxy_location FROM sites WHERE id = 'siteaaa1'").get()).toEqual({ proxy_location: 1 });
  });
});

describe('a deleted site stays empty', () => {
  it('drops everything a request already under way tries to store', async () => {
    const t = setup();
    const site = await t.site(); // cached, as another isolate would have it
    for (const x of ['events', 'sessions', 'visitors']) expect(t.count(x)).toBe(0);
    t.db.raw.exec("DELETE FROM sites WHERE id = 'siteaaa1'");
    expect((await t.event({})).status).toBe(202);
    await t.event({ t: 'identify', p: { email: 'x@example.com' } });
    await t.event({ u: 'https://a1.example.com/thanks?payment_id=pay_12345' });
    await recordPayment(t.db.d1, site, { id: 'x', provider: 'api', ts: 1, amount: 1, kind: 'payment', currency: 'USD', visitorId: 'v', email: 'e@example.com' });
    for (const x of ['events', 'sessions', 'visitors', 'payments', 'payment_claims']) expect([x, t.count(x)]).toEqual([x, 0]);
  });
});

describe('an authorization code', () => {
  const VERIFIER = 'v'.repeat(50);
  async function issue(t: ReturnType<typeof setup>) {
    const reg = async (n: string) => ((await (await t.call('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: n, redirect_uris: ['https://c.example/cb'] }) })).json()) as { client_id: string }).client_id;
    const client = await reg('real'), other = await reg('other');
    const code = 'code' + Math.random();
    t.db.raw.prepare("INSERT INTO oauth_codes (code_hash, client_id, owner_id, redirect_uri, code_challenge, scopes, created_at, expires_at) VALUES (?, ?, 'a', 'https://c.example/cb', ?, 'read', 0, ?)").run(createHash('sha256').update(code).digest('hex'), client, await pkceChallenge(VERIFIER), Date.now() + 60_000);
    const exchange = async (o: Record<string, string> = {}) => {
      const r = await t.call('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: 'https://c.example/cb', code_verifier: VERIFIER, ...o }) });
      return { status: r.status, body: (await r.json()) as { access_token: string } };
    };
    const live = async (token: string) => (await t.call('/api/agent/v1/list_sites', { headers: { authorization: `Bearer ${token}` } })).status;
    const wrong: Record<string, string>[] = [{ client_id: other }, { redirect_uri: 'https://c.example/other' }, { code_verifier: 'w'.repeat(50) }, { code_verifier: '' }, { resource: 'https://evil.example/' }];
    return { exchange, live, wrong };
  }
  it('is not used up, and its connection not ended, by someone without the verifier', async () => {
    const { exchange, live, wrong } = await issue(setup());
    for (const w of wrong) expect((await exchange(w)).status).toBe(400);
    const ok = await exchange();
    expect(ok.status).toBe(200);
    for (const w of wrong) expect((await exchange(w)).status).toBe(400);
    expect(await live(ok.body.access_token)).toBe(200);
  });
  it('presented twice with its verifier still ends the connection', async () => {
    const { exchange, live } = await issue(setup());
    const ok = await exchange();
    expect((await exchange()).status).toBe(400);
    expect(await live(ok.body.access_token)).toBe(401);
  });
});

describe('Stripe refunds out of order', () => {
  it('keep the larger total', async () => {
    const { db, call } = setup();
    db.raw.exec("INSERT INTO payments (id, site_id, provider, ts, amount, currency) VALUES ('siteaaa1:pi_1', 'siteaaa1', 'stripe', 1, 1000, 'USD')");
    const refund = (amount: number) => {
      const body = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: amount, currency: 'usd' } } }), t = Math.floor(Date.now() / 1000);
      return call('/api/webhooks/stripe/siteaaa1', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_s').update(`${t}.${body}`).digest('hex')}` }, body });
    };
    const now = () => (db.raw.prepare("SELECT amount FROM payments WHERE kind = 'refund'").get() as { amount: number }).amount;
    await refund(300);
    expect(now()).toBe(-300);
    await refund(1000);
    expect(now()).toBe(-1000);
    await refund(300);
    expect(now()).toBe(-1000);
  });
});

describe('second audit', () => {
  it('a site that serves the script itself keeps its visitors; others keep the small limit', async () => {
    const t = setup({ PLAN_ADDRESS_DAILY_LIMIT: '2', PLAN_EVENT_LIMIT: '10', PLAN_EVENT_HARD_MULTIPLIER: '3' });
    const send = async (n: number) => (await t.event({ vid: 'visitor' + n + 'x', sid: 'session' + n })).status;
    expect([await send(1), await send(2), await send(3)]).toEqual([202, 202, 429]);
    await t.as('u:a', '/api/sites/siteaaa1', 'PATCH', { proxy_location: true });
    const out: number[] = [];
    for (let i = 4; i < 12; i++) out.push(await send(i));
    expect(out).toEqual([202, 202, 202, 202, 202, 202, 429, 429]);
  });
  it('a later Stripe refund takes the credit the payment has got since', async () => {
    const t = setup();
    const now = Date.now();
    t.db.raw.exec(`INSERT INTO payments (id, site_id, provider, ts, amount, currency, email) VALUES ('siteaaa1:pi_1', 'siteaaa1', 'stripe', ${now}, 1000, 'USD', 'x@example.com');
      INSERT INTO placements (id, site_id, name, status, match_source, created_by, created_at) VALUES ('p', 'siteaaa1', 'PH', 'live', 'PH', 'owner', 0)`);
    const refund = (n: number) => { const body = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch', payment_intent: 'pi_1', amount_refunded: n, currency: 'usd' } } }), s = Math.floor(Date.now() / 1000); return t.call('/api/webhooks/stripe/siteaaa1', { method: 'POST', body, headers: { 'stripe-signature': `t=${s},v1=${createHmac('sha256', 'whsec_s').update(`${s}.${body}`).digest('hex')}` } }); };
    await refund(300);
    t.db.raw.exec(`INSERT INTO visitors (site_id, id, first_seen, email) VALUES ('siteaaa1', 'v', 0, 'x@example.com'); INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES ('siteaaa1', 's', 'v', ${now - 1000}, ${now}, 'PH', 'Referral')`);
    await rematchPayments(t.db.d1, await t.site());
    await refund(1000);
    expect((await placementsWithStats(ctx(t.db)))[0].revenue).toBe(0);
    await refund(300);
    expect((await placementsWithStats(ctx(t.db)))[0].revenue).toBe(0);
  });
  it('a breakdown always keeps the top earners', async () => {
    const { db } = setup();
    let n = 0;
    const add = (src: string | null, visitors: number, amount: number) => {
      for (let i = 0; i < visitors; i++, n++) {
        db.raw.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel, ref) VALUES ('siteaaa1', ?, ?, 10, 10, 'X', 'R', ?)").run('s' + n, 'v' + n, src);
        if (!i) db.raw.prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, session_id) VALUES (?, 'siteaaa1', 'api', 20, ?, 'USD', ?, ?)").run('p' + n, amount, 'v' + n, 's' + n);
      }
    };
    for (let i = 0; i < 6; i++) add('src' + i, 9 - i, 100 + i);
    add('whale', 1, 1_000_000); add('second', 1, 900_000); add(null, 1, 1);
    const rows = await breakdown(ctx(db), 'ref', 5);
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(['whale', 'second', 'src0']));
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.label === null)).toBe(false);
  });
});

describe('second audit, F to J', () => {
  const self = { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
  const login = (t: ReturnType<typeof setup>, ip: string, password = 'nope') => t.call('/api/auth/login', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: JSON.stringify({ password }) });

  it('blocked logins store nothing more, the right password stays blocked, and the lock ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t = setup(self);
      const codes = (await Promise.all(Array.from({ length: 25 }, () => login(t, '203.0.113.30')))).map((r) => r.status);
      expect(codes.filter((x) => x === 401)).toHaveLength(10);
      expect(codes.filter((x) => x === 429)).toHaveLength(15);
      expect(t.count('login_failures')).toBe(11);
      expect((await login(t, '203.0.113.30', 'pw')).status).toBe(429);
      expect((await login(t, '203.0.113.31', 'pw')).status).toBe(200);
      const spy = vi.spyOn(t.db.d1, 'batch');
      expect((await login(t, '203.0.113.30')).status).toBe(429);
      expect(spy).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
      expect((await login(t, '203.0.113.30', 'pw')).status).toBe(200);
      expect(t.count('login_failures')).toBe(0);
      const plan = t.db.raw.prepare('EXPLAIN QUERY PLAN DELETE FROM login_failures WHERE ts < 0').all() as { detail: string }[];
      expect(plan[0].detail).toContain('login_failures_ts');
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('pings cannot make a visit longer than it was, and are limited', async () => {
    const t = setup();
    const at = (o: object = {}) => t.event({ sid: 'pingsess1', vid: 'pingvisit', ...o }, { 'cf-connecting-ip': '203.0.113.40' });
    const duration = () => (t.db.raw.prepare("SELECT duration FROM sessions WHERE id = 'pingsess1'").get() as { duration: number }).duration;
    await at();
    const out: number[] = [];
    for (let i = 0; i < 40; i++) out.push((await at({ t: 'ping', d: 600_000 })).status);
    expect(out.filter((x) => x === 429).length).toBeGreaterThanOrEqual(10);
    expect(duration()).toBeLessThanOrEqual(13_000);
  });
  it('ordinary pings still add up, and nothing already counted is lost', async () => {
    const t = setup();
    const ping = (sid: string, d: number) => t.event({ t: 'ping', sid, vid: 'pingvisit', d }, { 'cf-connecting-ip': '203.0.113.41' });
    const duration = (id: string) => (t.db.raw.prepare('SELECT duration FROM sessions WHERE id = ?').get(id) as { duration: number }).duration;
    const add = (id: string, started: number, d: number) => t.db.raw.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, duration, source, channel) VALUES ('siteaaa1', ?, 'pingvisit', ?, ?, ?, 'X', 'R')").run(id, started, started, d);
    add('pingsess2', Date.now() - 600_000, 0);
    for (let i = 0; i < 5; i++) await ping('pingsess2', 60_000);
    expect(duration('pingsess2')).toBe(300_000);
    add('pingsess3', Date.now() - 1000, 999_999);
    await ping('pingsess3', 60_000);
    expect(duration('pingsess3')).toBe(999_999);
  });
  it('a site that serves the script itself is not limited by address', async () => {
    const t = setup();
    const send = async (n: number, ip: string) => (await t.event({ t: 'ping', sid: 'proxysess' + n, d: 1000 }, { 'cf-connecting-ip': ip })).status;
    const run = async (ip: string) => { let blocked = 0; for (let i = 0; i < 620; i++) if ((await send(i, ip)) === 429) blocked++; return blocked; };
    expect(await run('203.0.113.42')).toBeGreaterThanOrEqual(20);
    t.db.raw.exec("UPDATE sites SET proxy_location = 1");
    forgetAllSites();
    expect(await run('203.0.113.43')).toBe(0);
  });

  it('a chosen range starts at most ten years back, and normal ones are unchanged', async () => {
    const now = Date.UTC(2026, 10, 24);
    const { db } = setup();
    const range = resolveRange({ period: 'custom', from: '0100-01-01', to: '2026-11-24' }, 'UTC', 0, now);
    const started = performance.now();
    const r = await overview({ db: db.d1, site: { id: 'siteaaa1', currency: 'USD', timezone: 'UTC' }, range, filters: {}, offset: 0 } as unknown as Ctx);
    expect(r.series.length).toBeLessThan(125);
    expect(performance.now() - started).toBeLessThan(500);
    expect(resolveRange({ period: 'custom', from: '2019-03-01', to: '2019-03-31' }, 'UTC', 0, now)).toMatchObject({ from: Date.UTC(2019, 2, 1), to: Date.UTC(2019, 3, 1) });
    const past = resolveRange({ period: 'custom', from: '0100-01-01', to: '0100-02-01' }, 'UTC', 0, now);
    expect(past.to - past.from).toBe(DAY);
  });

  it('bodies over the limit are refused, announced or not; ordinary ones get through either way', async () => {
    const t = setup();
    const send = async (path: string, text: string, how: 'chunked' | 'plain', headers: Record<string, string> = {}) => {
      const bytes = new TextEncoder().encode(text);
      const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000)); c.close(); } });
      const init = { method: 'POST', headers: { ...headers, ...(how === 'plain' ? { 'content-length': String(bytes.length) } : {}) }, body: how === 'plain' ? text : stream, duplex: 'half' };
      return (await t.call(path, init as never)).status;
    };
    const reg = (pad: number) => JSON.stringify({ client_name: 'x', redirect_uris: ['https://c.example/cb'], pad: 'y'.repeat(pad) });
    const ev = (pad: number) => JSON.stringify({ w: 'siteaaa1', t: 'pageview', u: 'https://a1.example.com/', vid: 'visitor01', sid: 'session01', p: { x: 'é'.repeat(pad) } });
    for (const how of ['chunked', 'plain'] as const) {
      expect(await send('/oauth/register', reg(10), how)).toBe(201);
      expect(await send('/oauth/register', reg(200_000), how)).toBe(413);
      expect(await send('/api/event', ev(10), how, { 'user-agent': UA })).toBe(202);
      expect(await send('/api/event', ev(50_000), how, { 'user-agent': UA })).toBe(413);
      for (const path of ['/api/billing/webhook', '/api/webhooks/stripe/siteaaa1', '/api/webhooks/dodo/siteaaa1', '/api/webhooks/polar/siteaaa1']) expect([path, await send(path, 'z'.repeat(1_100_000), how)]).toEqual([path, 413]);
      expect(await send('/api/v1/payments', 'z'.repeat(300_000), how)).toBe(413);
      expect(await send('/api/auth/login', 'z'.repeat(20_000), how)).toBe(413);
    }
    expect(await send('/api/event', 'x'.repeat(1), 'plain', { 'content-length': 'abc' } as never)).toBeGreaterThanOrEqual(400);
    // A form body read from a copy still parses.
    expect(await send('/oauth/token', 'grant_type=authorization_code&client_id=nope', 'chunked', { 'content-type': 'application/x-www-form-urlencoded' })).toBe(401);
  });
  it('signed webhooks sent in pieces still verify', async () => {
    const t = setup();
    t.db.raw.exec("INSERT INTO payments (id, site_id, provider, ts, amount, currency) VALUES ('siteaaa1:pi_9', 'siteaaa1', 'stripe', 1, 1000, 'USD')");
    const body = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch_9', payment_intent: 'pi_9', amount_refunded: 250, currency: 'usd', note: 'é' } } }), s = Math.floor(Date.now() / 1000);
    const stream = new ReadableStream({ start(c) { const b = new TextEncoder().encode(body); for (let i = 0; i < b.length; i += 7) c.enqueue(b.slice(i, i + 7)); c.close(); } });
    expect((await t.call('/api/webhooks/stripe/siteaaa1', { method: 'POST', body: stream, duplex: 'half', headers: { 'stripe-signature': `t=${s},v1=${createHmac('sha256', 'whsec_s').update(`${s}.${body}`).digest('hex')}` } } as never)).status).toBe(200);
    expect(t.count("payments WHERE kind = 'refund' AND amount = -250")).toBe(1);
  });

  it('the online counter reads nothing for repeats it refuses, and only what it needs', async () => {
    const t = setup();
    const get = (id: string, ip = '198.51.100.90') => t.call('/api/public/online/' + id, { headers: { 'cf-connecting-ip': ip } });
    await get('nothere1');
    const spy = vi.spyOn(t.db.d1, 'prepare');
    expect((await get('nothere1')).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    t.db.raw.exec("UPDATE sites SET widget_enabled = 1 WHERE id = 'siteaaa1'");
    for (let i = 0; i < 121; i++) await get('siteaaa1');
    spy.mockClear();
    expect((await get('siteaaa1')).status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
    const now = Date.now();
    for (let i = 0; i < 5; i++) t.db.raw.prepare("INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES ('siteaaa1', ?, ?, ?, ?, 'X', 'R')").run('o' + i, 'o' + i, now - (i < 4 ? 2 * HOUR : 10 * DAY), i < 4 ? now : now - 10 * DAY);
    expect(await (await get('siteaaa1', '198.51.100.91')).json()).toEqual({ online: 4, visitors: null });
    t.db.raw.exec("UPDATE sites SET widget_visitors = 1 WHERE id = 'siteaaa1'");
    expect(await (await get('siteaaa1', '198.51.100.91')).json()).toEqual({ online: 4, visitors: 5 });
    t.db.raw.exec("UPDATE sites SET widget_enabled = 0 WHERE id = 'siteaaa1'");
    expect((await get('siteaaa1', '198.51.100.91')).status).toBe(404);
  });
});

describe('the font download', () => {
  it('is size-capped and checked against known files', () => {
    const src = readFileSync('scripts/fetch-fonts.mjs', 'utf8');
    expect(src).toContain('maxOutputLength');
    expect(src).not.toContain('arrayBuffer()');
    expect(src.match(/[0-9a-f]{64}/g)).toHaveLength(5);
  });
});
