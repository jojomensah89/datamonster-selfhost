import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { app } from '../src/worker/index';
import {
  addPlacement,
  checkListing,
  checkTransition,
  cleanListingUrl,
  cleanMatchDomain,
  mentionsSite,
  placementsWithStats,
  TRANSITIONS,
  updatePlacement,
  USER_AGENT,
  verifyPlacement,
  type Placement,
} from '../src/agent/placements';
import { ctxFrom } from '../src/agent/tools';
import { createToken } from '../src/agent/tokens';
import { duePlacements, makeVerifyPlacementsJob, RECHECK_MS } from '../src/cron/verify-placements';
import { jobs, runJobs, scheduled } from '../src/cron';
import { createSession } from '../src/worker/auth';
import { makeD1 } from './helpers/d1';

const SECRET = 'test-session-secret';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();

type Db = ReturnType<typeof makeD1>;
type Res = { status: number; body: any };
type FetchCall = { url: string; init: RequestInit };

const SITE = { id: 'site1', name: 'TidyForm', domain: 'tidyform.app', timezone: 'UTC', currency: 'USD', api_key: 'k', dodo_webhook_secret: null, created_at: now - 60 * DAY };

function seedSite(db: Db, id: string, ownerId: string | null, domain: string, name = domain) {
  db.raw.prepare(
    `INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES (?, ?, ?, 'UTC', 'USD', ?, ?, ?)`,
  ).run(id, name, domain, 'dmk_' + id, now - 60 * DAY, ownerId);
}

let visit = 0;
/** One session (and a payment when revenue > 0), `daysAgo` days back. */
function seedVisit(db: Db, site: string, s: { source?: string | null; domain?: string | null; ref?: string | null; revenue?: number; daysAgo?: number; visitor?: string; kind?: string }) {
  const n = ++visit;
  const sid = `${site}-s${n}`, vid = s.visitor ?? `${site}-v${n}`, ts = now - (s.daysAgo ?? 2) * DAY + n * 1000;
  db.raw.prepare(`INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)`).run(site, vid, ts);
  db.raw.prepare(
    `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, source, referrer_domain, channel, ref) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'Referral', ?)`,
  ).run(site, sid, vid, ts, ts + 60_000, s.source ?? null, s.domain ?? null, s.ref ?? null);
  if (s.revenue) {
    db.raw.prepare(
      `INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, session_id, matched_by, kind) VALUES (?, ?, 'api', ?, ?, 'USD', ?, ?, 'metadata', ?)`,
    ).run(`${site}-p${n}`, site, ts + 30_000, s.revenue, vid, sid, s.kind ?? 'payment');
  }
}

const selfHosted = (db: Db) => ({ DB: db.d1, ADMIN_PASSWORD: 'pw', SESSION_SECRET: SECRET }) as never;
const hosted = (db: Db) =>
  ({ DB: db.d1, ADMIN_PASSWORD: 'pw', SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }) as never;

async function call(env: never, method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const post = (env: never, token: string, tool: string, body: unknown) => call(env, 'POST', `/api/agent/v1/${tool}`, { token, body });
const get = (env: never, token: string, pathAndQuery: string) => call(env, 'GET', `/api/agent/v1/${pathAndQuery}`, { token });
async function mcp(env: never, token: string, method: string, params?: unknown) {
  return (await call(env, 'POST', '/api/agent/mcp', { token, body: { jsonrpc: '2.0', id: 1, method, params } })).body;
}
const count = (db: Db, table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const row = (db: Db, id: string) => db.raw.prepare('SELECT * FROM placements WHERE id = ?').get(id) as unknown as Placement;

/** A fake fetch: answers by URL from `routes`, records every call. Never touches the network. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = routes[url];
    if (!r) throw new TypeError(`unexpected fetch ${url}`);
    return r();
  }) as typeof fetch;
  return { fn, calls };
}
const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
const LONG = '<p>' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20) + '</p>';

// ---------------------------------------------------------------- validation

describe('listing URL and match rule validation', () => {
  it('accepts public http(s) listing URLs and drops the fragment', () => {
    expect(cleanListingUrl('https://www.producthunt.com/posts/tidyform#comments')).toBe('https://www.producthunt.com/posts/tidyform');
    expect(cleanListingUrl('betalist.com/startups/tidyform')).toBe('https://betalist.com/startups/tidyform');
    expect(cleanListingUrl('http://news.ycombinator.com/item?id=1')).toBe('http://news.ycombinator.com/item?id=1');
  });

  it('refuses anything the Worker should not fetch (SSRF)', () => {
    for (const bad of [
      'ftp://example.org/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'http://localhost/',
      'http://localhost./',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://127.1/',
      'http://0x7f.0.0.1/',
      'http://2130706433/',
      'http://10.0.0.5/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'https://user:pw@producthunt.com/',
      'https://producthunt.com:8443/',
      'http://metadata.google.internal/',
      'http://printer.local/',
      'http://router.lan/',
      'http://intranet/',
      'https://exa mple.com/',
      'https://producthunt.com/\\evil',
      '',
      'https://x.com/' + 'a'.repeat(600),
    ]) {
      expect(() => cleanListingUrl(bad), bad).toThrow();
    }
  });

  it('cleans referrer-domain rules', () => {
    expect(cleanMatchDomain('https://www.ProductHunt.com/posts/x')).toBe('producthunt.com');
    expect(cleanMatchDomain('news.ycombinator.com')).toBe('news.ycombinator.com');
    for (const bad of ['localhost', '127.0.0.1', 'pro%duct.com', '', 'a_b.com']) expect(() => cleanMatchDomain(bad), bad).toThrow();
  });

  it('recognises the site by domain anywhere or by name as a word in the text', () => {
    expect(mentionsSite('<a href="https://tidyform.app/?ref=ph">Visit</a>', SITE)).toBe(true);
    expect(mentionsSite('<h1>TidyForm</h1><p>Forms that tidy themselves</p>', SITE)).toBe(true);
    expect(mentionsSite('<h1>TidyFormatter</h1>', SITE)).toBe(false);
    expect(mentionsSite('<script>var x="TidyForm"</script><p>Other product</p>', SITE)).toBe(false);
  });
});

// ---------------------------------------------------------------- match rule and revenue

describe('match rule revenue math', () => {
  let db: Db;
  beforeEach(() => {
    db = makeD1();
    seedSite(db, 'site1', null, 'tidyform.app', 'TidyForm');
  });

  it('counts a session once when it matches several rules, and only payments credited to matching sessions', async () => {
    seedVisit(db, 'site1', { source: 'Product Hunt', domain: 'producthunt.com', ref: 'ph-launch', revenue: 1000 }); // all three rules
    seedVisit(db, 'site1', { source: 'Product Hunt', domain: 'producthunt.com', revenue: 2500 });
    seedVisit(db, 'site1', { source: 'Google', domain: 'google.com', ref: 'ph-launch', revenue: 400 }); // ref only
    seedVisit(db, 'site1', { source: 'Product Hunt', domain: 'api.producthunt.com' }); // subdomain, no payment
    seedVisit(db, 'site1', { source: 'X', domain: 'x.com', revenue: 9900 }); // not this launch
    seedVisit(db, 'site1', { source: 'Product Hunt', domain: 'producthunt.com', revenue: 700, daysAgo: 400 }); // outside 90d
    seedVisit(db, 'site1', { source: 'Product Hunt', domain: 'producthunt.com', revenue: -1000, kind: 'refund' }); // refund

    const site = SITE as never;
    await addPlacement(db.d1, site, { name: 'Product Hunt', match_domain: 'producthunt.com', match_ref: 'ph-launch' }, 'owner', now);
    await addPlacement(db.d1, site, { name: 'PH by source', match_source: 'product hunt' }, 'owner', now);
    await addPlacement(db.d1, site, { name: 'Hacker News' }, 'owner', now); // default rule: source = name

    const ctx = ctxFrom(db.d1, site, { period: '90d' }, now);
    const rows = await placementsWithStats(ctx);
    const by = (n: string) => rows.find((r) => r.name === n)!;
    // 5 matching sessions in range: visits 1, 2, 3, 4 and the refund's session.
    expect(by('Product Hunt')).toMatchObject({ visitors: 5, customers: 3, revenue: 1000 + 2500 + 400 - 1000 });
    // Source only (case-insensitive): visits 1, 2, 4 and the refund session; visit 3 came from Google.
    expect(by('PH by source')).toMatchObject({ visitors: 4, customers: 2, revenue: 1000 + 2500 - 1000 });
    expect(by('Hacker News')).toMatchObject({ visitors: 0, customers: 0, revenue: 0, match_source: 'Hacker News' });

    // Same numbers as the dashboard's source breakdown for a single source rule.
    const all = await placementsWithStats(ctxFrom(db.d1, site, { period: 'all' }, now));
    const { breakdown } = await import('../src/worker/stats');
    const ph = (await breakdown(ctxFrom(db.d1, site, { period: 'all' }, now), 'source')).find((r) => r.label === 'Product Hunt')!;
    expect(all.find((r) => r.name === 'PH by source')).toMatchObject({ visitors: ph.visitors, revenue: ph.revenue });
  });

  it('a launch needs a rule; clearing the last one is refused', async () => {
    const { placement } = await addPlacement(db.d1, SITE as never, { name: 'BetaList', match_ref: 'betalist' }, 'owner', now);
    expect(placement.match_source).toBeNull();
    await expect(updatePlacement(db.d1, SITE as never, placement.id, { match_ref: '' }, now)).rejects.toThrow(/at least one/);
    const ok = await updatePlacement(db.d1, SITE as never, placement.id, { match_ref: '', match_domain: 'betalist.com' }, now);
    expect(ok).toMatchObject({ match_ref: null, match_domain: 'betalist.com' });
  });
});

// ---------------------------------------------------------------- status

describe('status transitions', () => {
  let db: Db;
  const site = SITE as never;
  beforeEach(() => {
    db = makeD1();
    seedSite(db, 'site1', null, 'tidyform.app', 'TidyForm');
  });

  it('defaults to submitted with a listing URL, else draft; the same name returns the existing launch', async () => {
    const a = await addPlacement(db.d1, site, { name: 'Product Hunt', listing_url: 'https://www.producthunt.com/posts/tidyform' }, 'owner', now);
    expect(a).toMatchObject({ created: true, placement: { status: 'submitted', launched_on: null } });
    const b = await addPlacement(db.d1, site, { name: 'BetaList' }, 'owner', now);
    expect(b.placement.status).toBe('draft');
    const again = await addPlacement(db.d1, site, { name: 'product hunt', status: 'live' }, 'tok', now);
    expect(again).toMatchObject({ created: false, placement: { id: a.placement.id, status: 'submitted', created_by: 'owner' } });
    expect(count(db, 'placements')).toBe(2);
    const live = await addPlacement(db.d1, site, { name: 'Uneed', status: 'live' }, 'owner', now);
    expect(live.placement.launched_on).toBe(new Date(now).toISOString().slice(0, 10));
  });

  it('allows only sensible changes by hand, and becoming live sets the launch day', async () => {
    const { placement } = await addPlacement(db.d1, site, { name: 'Product Hunt' }, 'owner', now);
    await expect(updatePlacement(db.d1, site, placement.id, { status: 'removed' }, now)).rejects.toThrow(/draft can't become removed/);
    await expect(updatePlacement(db.d1, site, placement.id, { status: 'bogus' }, now)).rejects.toThrow(/status must be one of/);
    expect((await updatePlacement(db.d1, site, placement.id, { status: 'submitted' }, now)).status).toBe('submitted');
    expect((await updatePlacement(db.d1, site, placement.id, { status: 'in review' }, now)).status).toBe('in_review');
    const live = await updatePlacement(db.d1, site, placement.id, { status: 'live' }, now);
    expect(live).toMatchObject({ status: 'live', launched_on: new Date(now).toISOString().slice(0, 10) });
    await expect(updatePlacement(db.d1, site, placement.id, { status: 'draft' }, now)).rejects.toThrow(/live can't become draft/);
    expect((await updatePlacement(db.d1, site, placement.id, { status: 'removed' }, now)).status).toBe('removed');
    expect((await updatePlacement(db.d1, site, placement.id, { status: 'live', launched_on: '2026-11-01' }, now)).launched_on).toBe('2026-11-01');

    // Every transition in the table works, and every one outside it is refused.
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      for (const to of Object.keys(TRANSITIONS)) {
        const allowed = from === to || (tos as readonly string[]).includes(to);
        if (allowed) expect(() => checkTransition(from as never, to as never)).not.toThrow();
        else expect(() => checkTransition(from as never, to as never), `${from}->${to}`).toThrow();
      }
    }
  });

  it('a successful check makes a launch live; a missing live listing keeps its status and needs attention', async () => {
    const { placement } = await addPlacement(db.d1, site, { name: 'Product Hunt', listing_url: 'https://www.producthunt.com/posts/tidyform', status: 'in_review' }, 'owner', now);
    const ok = fakeFetch({ 'https://www.producthunt.com/posts/tidyform': html(`<h1>TidyForm</h1>${LONG}`) });
    const r1 = await verifyPlacement(db.d1, site, row(db, placement.id), { fetch: ok.fn, now });
    expect(r1).toMatchObject({ checked: true, check: { result: 'ok' }, placement: { status: 'live', needs_attention: false, launched_on: new Date(now).toISOString().slice(0, 10) } });

    // Checked a moment ago: not fetched again.
    const again = await verifyPlacement(db.d1, site, row(db, placement.id), { fetch: ok.fn, now: now + 10_000 });
    expect(again.checked).toBe(false);
    expect(ok.calls).toHaveLength(1);

    const gone = fakeFetch({ 'https://www.producthunt.com/posts/tidyform': html('Not found', 404) });
    const r2 = await verifyPlacement(db.d1, site, row(db, placement.id), { fetch: gone.fn, now: now + HOUR });
    expect(r2.placement).toMatchObject({ status: 'live', last_check_result: 'missing', last_check_detail: 'HTTP 404', needs_attention: true });
    expect(row(db, placement.id)).toMatchObject({ status: 'live', last_check_result: 'missing', last_checked_at: now + HOUR });

    // Errors and unknowns never change the status.
    const down = fakeFetch({ 'https://www.producthunt.com/posts/tidyform': html('busy', 503) });
    const r3 = await verifyPlacement(db.d1, site, row(db, placement.id), { fetch: down.fn, now: now + 2 * HOUR });
    expect(r3.placement).toMatchObject({ status: 'live', last_check_result: 'error', needs_attention: false });

    // A new listing URL clears the old result.
    const moved = await updatePlacement(db.d1, site, placement.id, { listing_url: 'https://www.producthunt.com/products/tidyform' }, now + 3 * HOUR);
    expect(moved).toMatchObject({ last_check_result: null, last_checked_at: null });
  });

  it('refuses to check a launch without a listing URL', async () => {
    const { placement } = await addPlacement(db.d1, site, { name: 'Newsletter' }, 'owner', now);
    const f = fakeFetch({});
    await expect(verifyPlacement(db.d1, site, row(db, placement.id), { fetch: f.fn, now })).rejects.toThrow(/no listing_url/);
    expect(f.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- verification outcomes

describe('checkListing outcomes (injected fetch)', () => {
  const URL0 = 'https://www.producthunt.com/posts/tidyform';

  it('ok when the page names the site, sending a DataMonster user agent, manual redirects and no credentials', async () => {
    const f = fakeFetch({ [URL0]: html(`<a href="https://tidyform.app">tidyform.app</a>${LONG}`) });
    expect(await checkListing(URL0, SITE, { fetch: f.fn })).toMatchObject({ result: 'ok', final_url: URL0 });
    const init = f.calls[0].init;
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeDefined();
    const headers = new Headers(init.headers);
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
  });

  it('missing on 404 and 410', async () => {
    for (const status of [404, 410]) {
      const f = fakeFetch({ [URL0]: html('gone', status) });
      expect(await checkListing(URL0, SITE, { fetch: f.fn })).toMatchObject({ result: 'missing', detail: `HTTP ${status}` });
    }
  });

  it('missing when the listing bounces to the directory home page', async () => {
    const f = fakeFetch({ [URL0]: redirect('/'), 'https://www.producthunt.com/': html(`<h1>Product Hunt</h1>${LONG}`) });
    expect(await checkListing(URL0, SITE, { fetch: f.fn })).toMatchObject({ result: 'missing', final_url: 'https://www.producthunt.com/' });
  });

  it('error on other statuses, network failures, timeouts and redirect loops', async () => {
    for (const status of [403, 429, 500, 503]) {
      const f = fakeFetch({ [URL0]: html('no', status) });
      expect(await checkListing(URL0, SITE, { fetch: f.fn }), String(status)).toMatchObject({ result: 'error', detail: `HTTP ${status}` });
    }
    const broken = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    expect(await checkListing(URL0, SITE, { fetch: broken })).toMatchObject({ result: 'error', detail: 'could not connect' });

    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))))) as unknown as typeof fetch;
    expect(await checkListing(URL0, SITE, { fetch: hang, timeoutMs: 20 })).toMatchObject({ result: 'error', detail: 'timed out' });

    const loop = fakeFetch({ [URL0]: redirect(URL0 + '?a'), [URL0 + '?a']: redirect(URL0) });
    expect(await checkListing(URL0, SITE, { fetch: loop.fn })).toMatchObject({ result: 'error', detail: 'too many redirects' });
    expect(loop.calls.length).toBe(5);
  });

  it('unknown for pages that need JavaScript, do not name the site, or are not HTML (never missing)', async () => {
    const spa = fakeFetch({ [URL0]: html('<html><body><div id="root"></div><script src="/app.js"></script></body></html>') });
    expect(await checkListing(URL0, SITE, { fetch: spa.fn })).toMatchObject({ result: 'unknown', detail: /JavaScript/ });
    const other = fakeFetch({ [URL0]: html(`<h1>Another product</h1>${LONG}`) });
    expect(await checkListing(URL0, SITE, { fetch: other.fn })).toMatchObject({ result: 'unknown', detail: /does not mention tidyform\.app/ });
    const pdf = fakeFetch({ [URL0]: () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }) });
    expect(await checkListing(URL0, SITE, { fetch: pdf.fn })).toMatchObject({ result: 'unknown', detail: 'not an HTML page' });
  });

  it('follows public redirects but refuses one to a private host without fetching it', async () => {
    const pub = fakeFetch({ 'http://producthunt.com/posts/tidyform': redirect(URL0, 301), [URL0]: html(`TidyForm ${LONG}`) });
    expect(await checkListing('http://producthunt.com/posts/tidyform', SITE, { fetch: pub.fn })).toMatchObject({ result: 'ok', final_url: URL0 });

    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8787/api/sites', 'http://[::1]/', 'http://10.0.0.1/', 'file:///etc/passwd', 'http://metadata.google.internal/']) {
      const f = fakeFetch({ [URL0]: redirect(target) });
      const r = await checkListing(URL0, SITE, { fetch: f.fn });
      expect(r.result, target).toBe('error');
      expect(r.detail, target).toMatch(/refused a redirect/);
      expect(f.calls.map((c) => c.url), target).toEqual([URL0]);
    }
  });
});

// ---------------------------------------------------------------- cron

describe('daily check (cron)', () => {
  let db: Db;
  function place(id: string, status: string, opts: { checked?: number | null; url?: string | null; archived?: boolean; site?: string; created?: number } = {}) {
    db.raw.prepare(
      `INSERT INTO placements (id, site_id, name, listing_url, status, match_source, last_checked_at, created_by, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', ?, ?)`,
    ).run(id, opts.site ?? 'site1', id, opts.url === undefined ? `https://dir.example.org/${id}` : opts.url, status, id, opts.checked ?? null, opts.created ?? now, opts.archived ? now : null);
  }
  beforeEach(() => {
    db = makeD1();
    seedSite(db, 'site1', null, 'tidyform.app', 'TidyForm');
  });

  it('picks live and in-review launches with a URL not checked in 20 hours, longest wait first, capped', async () => {
    place('live-never', 'live', { created: now - 5 });
    place('review-old', 'in_review', { checked: now - 30 * HOUR });
    place('live-21h', 'live', { checked: now - 21 * HOUR });
    place('live-19h', 'live', { checked: now - 19 * HOUR });
    place('live-archived', 'live', { archived: true });
    place('live-no-url', 'live', { url: null });
    for (const s of ['draft', 'submitted', 'rejected', 'removed']) place(`st-${s}`, s);
    const env = selfHosted(db);
    expect((await duePlacements(env, now)).map((d) => d.placement.id)).toEqual(['review-old', 'live-21h', 'live-never']);
    expect((await duePlacements(env, now, 2)).map((d) => d.placement.id)).toEqual(['review-old', 'live-21h']);
    expect(RECHECK_MS).toBe(20 * HOUR);
  });

  it('checks the launches of Pro accounts before those on Free', async () => {
    db.raw.prepare(`INSERT INTO users (id, email, created_at, plan_status, plan_until) VALUES ('paid', 'p@example.com', 0, 'active', 9999999999999), ('lapsed', 'l@example.com', 0, 'cancelled', 0)`).run();
    seedSite(db, 'sitePaid', 'paid', 'paid.example.org');
    seedSite(db, 'siteLapsed', 'lapsed', 'lapsed.example.org');
    place('l1', 'live', { site: 'siteLapsed', created: 1 });
    place('p1', 'live', { site: 'sitePaid', created: 2 });
    place('p2', 'live', { site: 'sitePaid', created: 3 });
    expect((await duePlacements(hosted(db), now)).map((d) => d.placement.id)).toEqual(['p1', 'p2', 'l1']);
    expect((await duePlacements(hosted(db), now, 1)).map((d) => d.placement.id)).toEqual(['p1']);
  });

  it('checks them one at a time with a pause, stores results and respects the cap', async () => {
    for (let i = 0; i < 4; i++) place(`l${i}`, 'live', { created: now + i });
    const f = fakeFetch({
      'https://dir.example.org/l0': html(`tidyform.app ${LONG}`),
      'https://dir.example.org/l1': html('gone', 404),
      'https://dir.example.org/l2': html('busy', 500),
      'https://dir.example.org/l3': html('never fetched'),
    });
    let inFlight = 0, maxInFlight = 0;
    const fetchSpy = (async (u: RequestInfo | URL, i?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await f.fn(u, i);
      } finally {
        inFlight--;
      }
    }) as typeof fetch;
    const sleep = vi.fn(async () => {});
    await makeVerifyPlacementsJob({ fetch: fetchSpy, cap: 3, sleep, pauseMs: 5 })(selfHosted(db), now);
    expect(f.calls.map((c) => c.url)).toEqual(['https://dir.example.org/l0', 'https://dir.example.org/l1', 'https://dir.example.org/l2']);
    expect(maxInFlight).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
    expect(['l0', 'l1', 'l2', 'l3'].map((id) => [row(db, id).last_check_result, row(db, id).last_checked_at])).toEqual([
      ['ok', now],
      ['missing', now],
      ['error', now],
      [null, null],
    ]);
    // The next run picks up what is left, not what was just checked.
    const f2 = fakeFetch({ 'https://dir.example.org/l3': html('tidyform.app') });
    await makeVerifyPlacementsJob({ fetch: f2.fn, sleep })(selfHosted(db), now + 60_000);
    expect(f2.calls.map((c) => c.url)).toEqual(['https://dir.example.org/l3']);
  });

  it('runs every job even when one fails, and the worker exports the scheduled handler', async () => {
    const ran: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runJobs({} as never, now, [
      async () => {
        ran.push('a');
        throw new Error('boom');
      },
      async () => {
        ran.push('b');
      },
    ]);
    spy.mockRestore();
    expect(ran).toEqual(['a', 'b']);
    expect(jobs.length).toBeGreaterThan(0);

    const w = worker as unknown as { fetch: unknown; scheduled: unknown; request: unknown };
    expect(typeof w.fetch).toBe('function');
    expect(w.scheduled).toBe(scheduled);
    const waits: Promise<unknown>[] = [];
    // No placements in this DB: the job runs and finishes without fetching anything.
    const g = vi.fn();
    vi.stubGlobal('fetch', g);
    scheduled({ scheduledTime: now, cron: '0 6 * * *', noRetry() {} } as never, selfHosted(db), { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as never);
    await Promise.all(waits);
    vi.unstubAllGlobals();
    expect(waits).toHaveLength(1);
    expect(g).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- tools: scopes

describe('placement tools (self-hosted): scopes and audit', () => {
  let db: Db, env: never, readSecret: string, writeSecret: string, writeTokenId: string;
  beforeEach(async () => {
    db = makeD1();
    env = selfHosted(db);
    seedSite(db, 'site1', null, 'tidyform.app', 'TidyForm');
    ({ secret: readSecret } = await createToken(db.d1, 'admin', { name: 'reader' }));
    const w = await createToken(db.d1, 'admin', { name: 'writer', scopes: ['read', 'write'] });
    writeSecret = w.secret;
    writeTokenId = w.token.id;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a read token lists launches but cannot add, update or check them', async () => {
    const names = (await mcp(env, readSecret, 'tools/list')).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('list_placements');
    for (const w of ['add_placement', 'update_placement', 'verify_placement']) expect(names).not.toContain(w);

    const { placement } = await addPlacement(db.d1, SITE as never, { name: 'Product Hunt', listing_url: 'https://www.producthunt.com/posts/tidyform' }, 'owner');
    const g = vi.fn();
    vi.stubGlobal('fetch', g);
    for (const [tool, args] of [
      ['add_placement', { site_id: 'site1', name: 'BetaList' }],
      ['update_placement', { site_id: 'site1', placement_id: placement.id, status: 'live' }],
      ['verify_placement', { site_id: 'site1', placement_id: placement.id }],
    ] as const) {
      const r = await post(env, readSecret, tool, args);
      expect(r.status, tool).toBe(403);
    }
    expect(g).not.toHaveBeenCalled();
    expect(count(db, 'placements')).toBe(1);
    expect(row(db, placement.id).status).toBe('submitted');
    const audit = db.raw.prepare(`SELECT tool, write, ok FROM agent_audit WHERE tool LIKE '%placement%' ORDER BY id`).all();
    expect(audit).toEqual([
      { tool: 'add_placement', write: 1, ok: 0 },
      { tool: 'update_placement', write: 1, ok: 0 },
      { tool: 'verify_placement', write: 1, ok: 0 },
    ]);

    const list = await get(env, readSecret, 'list_placements?site_id=site1');
    expect(list.status).toBe(200);
    expect(list.body.data.placements).toHaveLength(1);
    expect(list.body.range).toBeDefined();
  });

  it('a write token adds, updates, checks and lists launches; writes are POST only', async () => {
    const add = await post(env, writeSecret, 'add_placement', {
      site_id: 'site1',
      name: 'Product Hunt',
      listing_url: 'https://www.producthunt.com/posts/tidyform',
      match_domain: 'producthunt.com',
      match_ref: 'ph-launch',
    });
    expect(add.status).toBe(200);
    expect(add.body.data).toMatchObject({ created: true, placement: { status: 'submitted', created_by: writeTokenId, match_source: null } });
    const id = add.body.data.placement.id;

    expect((await post(env, writeSecret, 'add_placement', { site_id: 'site1', name: 'Bad', listing_url: 'http://127.0.0.1/' })).status).toBe(400);
    expect((await post(env, writeSecret, 'add_placement', { site_id: 'site1', name: 'Bad', bogus: 1 })).body.error).toMatch(/unknown argument/);
    expect((await get(env, writeSecret, `add_placement?site_id=site1&name=X`)).status).toBe(405);
    expect((await get(env, writeSecret, `verify_placement?site_id=site1&placement_id=${id}`)).status).toBe(405);

    const upd = await post(env, writeSecret, 'update_placement', { site_id: 'site1', placement_id: id, status: 'in_review', notes: 'Scheduled for Tuesday' });
    expect(upd.body.data.placement).toMatchObject({ status: 'in_review', notes: 'Scheduled for Tuesday' });
    expect((await post(env, writeSecret, 'update_placement', { site_id: 'site1', placement_id: id, status: 'removed' })).status).toBe(409);
    expect((await post(env, writeSecret, 'update_placement', { site_id: 'site1', placement_id: 'plc_nope' })).status).toBe(404);
    // Agents never archive.
    expect((await post(env, writeSecret, 'update_placement', { site_id: 'site1', placement_id: id, archived: true })).body.error).toMatch(/unknown argument/);

    const f = fakeFetch({ 'https://www.producthunt.com/posts/tidyform': html(`<h1>TidyForm</h1>${LONG}`) });
    vi.stubGlobal('fetch', f.fn);
    const ver = await post(env, writeSecret, 'verify_placement', { site_id: 'site1', placement_id: id });
    expect(ver.status).toBe(200);
    expect(ver.body.data).toMatchObject({ checked: true, check: { result: 'ok' }, placement: { status: 'live' } });
    expect(f.calls).toHaveLength(1);

    seedVisit(db, 'site1', { source: 'Product Hunt', domain: 'producthunt.com', revenue: 1200 });
    seedVisit(db, 'site1', { source: 'Google', ref: 'ph-launch', revenue: 300 });
    const list = await post(env, writeSecret, 'list_placements', { site_id: 'site1' });
    expect(list.body.data.placements[0]).toMatchObject({ name: 'Product Hunt', status: 'live', visitors: 2, customers: 2, revenue: 1500, last_check_result: 'ok' });
  });
});

// ---------------------------------------------------------------- hosted isolation

describe('placements (hosted): one account never touches another', () => {
  let db: Db, env: never, secretA: string, cookieA: string, cookieB: string, bId: string, aId: string;
  beforeEach(async () => {
    db = makeD1();
    env = hosted(db);
    db.raw.prepare(`INSERT INTO users (id, email, created_at, plan_status, plan_until) VALUES ('userA', 'a@example.com', 0, 'active', 9999999999999), ('userB', 'b@example.com', 0, 'active', 9999999999999)`).run();
    seedSite(db, 'siteA1', 'userA', 'a-one.example.org');
    seedSite(db, 'siteB1', 'userB', 'b-one.example.org');
    seedVisit(db, 'siteB1', { source: 'B Secret Directory', revenue: 99900 });
    ({ secret: secretA } = await createToken(db.d1, 'userA', { name: 'A writer', scopes: 'read write' }));
    cookieA = `dm_auth=${await createSession(env, 'u:userA')}`;
    cookieB = `dm_auth=${await createSession(env, 'u:userB')}`;
    const b = await call(env, 'POST', '/api/sites/siteB1/placements', {
      cookie: cookieB,
      body: { name: 'B Secret Directory', listing_url: 'https://b-dir.example.org/listing', status: 'live' },
    });
    bId = b.body.placement.id;
    const a = await call(env, 'POST', '/api/sites/siteA1/placements', { cookie: cookieA, body: { name: 'A Directory' } });
    aId = a.body.placement.id;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('agent tools answer another account\'s site and launches exactly like missing ones', async () => {
    const g = vi.fn();
    vi.stubGlobal('fetch', g);
    const calls: [string, Record<string, unknown>][] = [
      ['add_placement', { name: 'sneaky' }],
      ['update_placement', { placement_id: bId, status: 'removed' }],
      ['verify_placement', { placement_id: bId }],
      ['list_placements', {}],
    ];
    for (const [tool, args] of calls) {
      for (const site_id of ['siteB1', 'nope']) {
        const r = await post(env, secretA, tool, { ...args, site_id });
        expect(r.status, `${tool} ${site_id}`).toBe(404);
        expect(r.body).toEqual({ error: 'site not found' });
      }
      const m = await mcp(env, secretA, 'tools/call', { name: tool, arguments: { ...args, site_id: 'siteB1' } });
      expect(m.result.isError).toBe(true);
      expect(m.result.content[0].text).toBe('site not found');
    }
    // B's launch through A's own site: not found.
    for (const tool of ['update_placement', 'verify_placement']) {
      const r = await post(env, secretA, tool, { site_id: 'siteA1', placement_id: bId });
      expect(r.status, tool).toBe(404);
      expect(r.body.error).toBe('launch not found');
    }
    const list = await post(env, secretA, 'list_placements', { site_id: 'siteA1', include_archived: true });
    expect(list.body.data.placements.map((p: { id: string }) => p.id)).toEqual([aId]);
    expect(JSON.stringify(list.body)).not.toMatch(/B Secret|b-dir/);

    expect(g).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT site_id, name, status, archived_at, last_checked_at FROM placements WHERE id = ?').get(bId)).toEqual({
      site_id: 'siteB1', name: 'B Secret Directory', status: 'live', archived_at: null, last_checked_at: null,
    });
    expect(count(db, 'placements')).toBe(2);
  });

  it('owner endpoints need a signed-in user', async () => {
    expect((await call(env, 'GET', '/api/sites/siteA1/placements')).status).toBe(401);
    expect((await call(env, 'POST', '/api/sites/siteA1/placements', { body: { name: 'x' } })).status).toBe(401);
    expect((await call(env, 'POST', `/api/sites/siteA1/placements/${aId}/verify`)).status).toBe(401);
  });

  it('owner endpoints create, list, update, archive, restore and check on the owner\'s own site', async () => {
    const created = await call(env, 'POST', '/api/sites/siteA1/placements', {
      cookie: cookieA,
      body: { name: 'Product Hunt', listing_url: 'https://www.producthunt.com/posts/a-one', match_domain: 'producthunt.com' },
    });
    expect(created.status).toBe(201);
    expect(created.body.placement).toMatchObject({ created_by: 'owner', status: 'submitted' });
    const pid = created.body.placement.id;
    expect((await call(env, 'POST', '/api/sites/siteA1/placements', { cookie: cookieA, body: { name: 'PRODUCT HUNT' } })).status).toBe(200);
    expect((await call(env, 'POST', '/api/sites/siteA1/placements', { cookie: cookieA, body: { name: 'Evil', listing_url: 'http://169.254.169.254/' } })).status).toBe(400);
    expect((await call(env, 'POST', '/api/sites/siteA1/placements', { cookie: cookieA, body: [] })).status).toBe(400);

    const patched = await call(env, 'PATCH', `/api/sites/siteA1/placements/${pid}`, { cookie: cookieA, body: { status: 'in_review', launched_on: '2026-11-10' } });
    expect(patched.body.placement).toMatchObject({ status: 'in_review', launched_on: '2026-11-10' });
    expect((await call(env, 'PATCH', `/api/sites/siteA1/placements/${pid}`, { cookie: cookieA, body: { name: 'A Directory' } })).status).toBe(409);
    expect((await call(env, 'PATCH', `/api/sites/siteA1/placements/${pid}`, { cookie: cookieA, body: { launched_on: '2026-02-30' } })).status).toBe(400);

    const f = fakeFetch({ 'https://www.producthunt.com/posts/a-one': html('gone', 404) });
    vi.stubGlobal('fetch', f.fn);
    const ver = await call(env, 'POST', `/api/sites/siteA1/placements/${pid}/verify`, { cookie: cookieA });
    expect(ver.status).toBe(200);
    expect(ver.body).toMatchObject({ checked: true, check: { result: 'missing' }, placement: { status: 'in_review', needs_attention: false } });

    const list = await call(env, 'GET', '/api/sites/siteA1/placements?period=30d', { cookie: cookieA });
    expect(list.body.placements.map((p: { name: string }) => p.name).sort()).toEqual(['A Directory', 'Product Hunt']);
    expect((await call(env, 'DELETE', `/api/sites/siteA1/placements/${pid}`, { cookie: cookieA })).status).toBe(200);
    expect((await call(env, 'DELETE', `/api/sites/siteA1/placements/${pid}`, { cookie: cookieA })).status).toBe(404);
    expect((await call(env, 'GET', '/api/sites/siteA1/placements', { cookie: cookieA })).body.placements.map((p: { id: string }) => p.id)).toEqual([aId]);
    expect((await call(env, 'GET', '/api/sites/siteA1/placements?include_archived=true', { cookie: cookieA })).body.placements).toHaveLength(2);
    expect((await call(env, 'POST', `/api/sites/siteA1/placements/${pid}/verify`, { cookie: cookieA })).status).toBe(400); // archived
    const restored = await call(env, 'PATCH', `/api/sites/siteA1/placements/${pid}`, { cookie: cookieA, body: { archived: false } });
    expect(restored.body.placement.archived_at).toBeNull();
  });

  it('owner endpoints never reach another account\'s site or launches', async () => {
    const g = vi.fn();
    vi.stubGlobal('fetch', g);
    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/sites/siteB1/placements'],
      ['GET', '/api/sites/siteB1/placements?include_archived=true'],
      ['POST', '/api/sites/siteB1/placements', { name: 'sneaky' }],
      ['PATCH', `/api/sites/siteB1/placements/${bId}`, { status: 'removed' }],
      ['DELETE', `/api/sites/siteB1/placements/${bId}`],
      ['POST', `/api/sites/siteB1/placements/${bId}/verify`],
      // B's launch through A's own site.
      ['PATCH', `/api/sites/siteA1/placements/${bId}`, { status: 'removed' }],
      ['DELETE', `/api/sites/siteA1/placements/${bId}`],
      ['POST', `/api/sites/siteA1/placements/${bId}/verify`],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(env, method, path, { cookie: cookieA, body });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/B Secret|b-dir|99900/);
    }
    expect(g).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT site_id, name, status, archived_at FROM placements ORDER BY name').all()).toEqual([
      { site_id: 'siteA1', name: 'A Directory', status: 'draft', archived_at: null },
      { site_id: 'siteB1', name: 'B Secret Directory', status: 'live', archived_at: null },
    ]);
  });
});
