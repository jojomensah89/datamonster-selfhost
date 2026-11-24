import { describe, expect, it } from 'vitest';
import { createSession, utcMonth } from '../src/worker/auth';
import { planInfo } from '../src/worker/billing';
import { forgetAllSites, type Env } from '../src/worker/env';
import app from '../src/worker/index';
import { makeD1 } from './helpers/d1';

const DAY = 86_400_000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function setup(overrides: Partial<Env> = {}, hosted = true) {
  const db = makeD1();
  forgetAllSites();
  const future = Date.now() + 30 * DAY;
  db.raw.exec(
    `INSERT INTO users (id, email, created_at, plan_status, plan_until) VALUES
       ('u1', 'user@example.com', 0, 'active', ${future}),
       ('adm', 'admin@example.com', 0, 'none', NULL);
     INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES
       ('site_u1a', 'U1 A', 'a.example.com', 'UTC', 'USD', 'k1', 0, 'u1'),
       ('site_u1b', 'U1 B', 'b.example.com', 'UTC', 'USD', 'k2', 0, 'u1'),
       ('site_adm', 'Admin', 'adm.example.com', 'UTC', 'USD', 'k3', 0, 'adm'),
       ('site_nil', 'Orphan', 'nil.example.com', 'UTC', 'USD', 'k4', 0, NULL);`,
  );
  const env = {
    DB: db.d1,
    SESSION_SECRET: 'secret',
    ADMIN_PASSWORD: 'pw',
    ...(hosted ? { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', ADMIN_EMAILS: 'admin@example.com' } : {}),
    ...overrides,
  } as Env;

  const request = async (path: string, init: RequestInit = {}, subject = hosted ? 'u:u1' : 'admin') =>
    app.request(
      'https://dm.test' + path,
      {
        ...init,
        headers: {
          cookie: 'dm_auth=' + (await createSession(env, subject)),
          ...init.headers,
        },
      },
      env,
      { waitUntil() {} } as any,
    );

  const sendEvent = (body: Record<string, unknown>, ua = BROWSER_UA) =>
    app.request(
      'https://dm.test/api/event',
      { method: 'POST', headers: { 'user-agent': ua }, body: JSON.stringify(body) },
      env,
      { waitUntil() {} } as any,
    );

  return { db, env, request, sendEvent };
}

describe('hosted usage limits', () => {
  it('increments monthly count across sites for ingested events and excludes ping and bots', async () => {
    const { db, sendEvent } = setup();
    const month = utcMonth();

    // pageview, goal, outbound on site_u1a + identify on site_u1b => 4 counted events
    expect((await sendEvent({ w: 'site_u1a', t: 'pageview', vid: 'visitor1', sid: 'session1', u: 'https://a.example.com/' })).status).toBe(202);
    expect((await sendEvent({ w: 'site_u1a', t: 'goal', n: 'signup', vid: 'visitor1', sid: 'session1', u: 'https://a.example.com/' })).status).toBe(202);
    expect((await sendEvent({ w: 'site_u1a', t: 'outbound', n: 'https://out.test', vid: 'visitor1', sid: 'session1', u: 'https://a.example.com/' })).status).toBe(202);
    expect((await sendEvent({ w: 'site_u1b', t: 'identify', vid: 'visitor2', sid: 'session2', u: 'https://b.example.com/', p: { email: 'hi@example.com' } })).status).toBe(202);

    // ping, bot, and empty-name goal must NOT count
    expect((await sendEvent({ w: 'site_u1a', t: 'ping', d: 5000, vid: 'visitor1', sid: 'session1', u: 'https://a.example.com/' })).status).toBe(202);
    expect((await sendEvent({ w: 'site_u1a', t: 'pageview', vid: 'visitor3', sid: 'session3', u: 'https://a.example.com/' }, BOT_UA)).status).toBe(202);
    expect((await sendEvent({ w: 'site_u1a', t: 'goal', vid: 'visitor1', sid: 'session1', u: 'https://a.example.com/' })).status).toBe(202);

    expect(db.raw.prepare('SELECT events FROM usage_monthly WHERE owner_id = ? AND month = ?').get('u1', month)).toEqual({ events: 4 });
    expect(db.raw.prepare("SELECT duration FROM sessions WHERE site_id = 'site_u1a' AND id = 'session1'").get()).toEqual({ duration: 5000 });
  });

  it('stores through the soft cap (1x..3x) and drops above the hard ceiling', async () => {
    const { db, sendEvent } = setup({ PLAN_EVENT_LIMIT: '2', PLAN_EVENT_HARD_MULTIPLIER: '3', PLAN_ADDRESS_DAILY_LIMIT: '100' });
    const month = utcMonth();

    // Limit = 2, hard ceiling = 6. Send 8 pageviews: first 6 stored (including 3..6 in soft overage), 7..8 dropped.
    for (let i = 1; i <= 8; i++) {
      const r = await sendEvent({
        w: 'site_u1a',
        t: 'pageview',
        vid: `visitor_${i}`,
        sid: `session_${i}`,
        u: `https://a.example.com/p${i}`,
      });
      expect(r.status).toBe(202);
    }

    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = 'site_u1a'").get()).toEqual({ n: 6 });
    expect(db.raw.prepare('SELECT events FROM usage_monthly WHERE owner_id = ? AND month = ?').get('u1', month)).toEqual({ events: 6 });
  });

  it('keeps admin and self-hosted accounts completely unlimited', async () => {
    // Hosted admin
    const hosted = setup({ PLAN_EVENT_LIMIT: '1', PLAN_EVENT_HARD_MULTIPLIER: '1', PLAN_SITE_LIMIT: '1' }, true);
    for (let i = 1; i <= 4; i++) {
      const r = await hosted.sendEvent({ w: 'site_adm', t: 'pageview', vid: `visitor_${i}`, sid: `session_${i}`, u: 'https://adm.example.com/' });
      expect(r.status).toBe(202);
    }
    expect(hosted.db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = 'site_adm'").get()).toEqual({ n: 4 });
    expect(hosted.db.raw.prepare("SELECT * FROM usage_monthly WHERE owner_id = 'adm'").get()).toBeUndefined();
    const admSite = await hosted.request('/api/sites', { method: 'POST', body: JSON.stringify({ domain: 'adm2.example.com' }) }, 'u:adm');
    expect(admSite.status).toBe(200);
    const admMe = await (await hosted.request('/api/auth/me', {}, 'u:adm')).json() as any;
    expect(admMe.user).toMatchObject({ admin: true, events_limit: null, hard_limit: null, sites_limit: null });

    // Self-hosted
    const self = setup({ PLAN_EVENT_LIMIT: '1', PLAN_EVENT_HARD_MULTIPLIER: '1', PLAN_SITE_LIMIT: '1' }, false);
    for (let i = 1; i <= 4; i++) {
      const r = await self.sendEvent({ w: 'site_u1a', t: 'pageview', vid: `visitor_${i}`, sid: `session_${i}`, u: 'https://a.example.com/' });
      expect(r.status).toBe(202);
    }
    expect(self.db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = 'site_u1a'").get()).toEqual({ n: 4 });
    expect(self.db.raw.prepare('SELECT COUNT(*) AS n FROM usage_monthly').get()).toEqual({ n: 0 });
    const selfSite = await self.request('/api/sites', { method: 'POST', body: JSON.stringify({ domain: 'self.example.com' }) });
    expect(selfSite.status).toBe(200);
    const selfMe = await (await self.request('/api/auth/me')).json() as any;
    expect(selfMe.user).toMatchObject({ events_limit: null, hard_limit: null, sites_limit: null });
  });

  it('exposes monthly usage and limits in /api/auth/me for hosted non-admin users', async () => {
    const { sendEvent, request } = setup({ PLAN_EVENT_LIMIT: '50000', PLAN_EVENT_HARD_MULTIPLIER: '3', PLAN_SITE_LIMIT: '10', SUPPORT_EMAIL: 'help@datamonster.dev' });
    await sendEvent({ w: 'site_u1a', t: 'pageview', vid: 'visitor1', sid: 'session1', u: 'https://a.example.com/' });
    await sendEvent({ w: 'site_u1b', t: 'pageview', vid: 'visitor2', sid: 'session2', u: 'https://b.example.com/' });

    const me = await (await request('/api/auth/me')).json() as any;
    expect(me.supportEmail).toBe('help@datamonster.dev');
    expect(me.user).toMatchObject({
      events_used: 2,
      events_limit: 50_000,
      hard_limit: 150_000,
      sites_used: 2,
      sites_limit: 10,
    });
  });

  it('enforces the per-account site cap with 402 and exact limit message', async () => {
    const { request } = setup({ PLAN_SITE_LIMIT: '3' });
    // u1 already starts with 2 sites (site_u1a, site_u1b)
    const ok = await request('/api/sites', { method: 'POST', body: JSON.stringify({ domain: 'c.example.com' }) });
    expect(ok.status).toBe(200);
    const created = (await ok.json()) as { id: string };

    // 4th site must fail with 402
    const blocked = await request('/api/sites', { method: 'POST', body: JSON.stringify({ domain: 'd.example.com' }) });
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({
      error: 'Your plan includes 3 websites. Remove one or email support to add more.',
    });

    // Removing one lets the user add another
    expect((await request(`/api/sites/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await request('/api/sites', { method: 'POST', body: JSON.stringify({ domain: 'd.example.com' }) })).status).toBe(200);
  });

  it('defaults the site cap to 10', async () => {
    const { db, request } = setup();
    // u1 has 2 sites; seed 8 more to hit 10
    for (let i = 3; i <= 10; i++) {
      db.raw
        .prepare("INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES (?, ?, ?, 'UTC', 'USD', ?, 0, 'u1')")
        .run(`site_u1_${i}`, `S${i}`, `s${i}.example.com`, `key_${i}`);
    }
    const blocked = await request('/api/sites', { method: 'POST', body: JSON.stringify({ domain: 's11.example.com' }) });
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({
      error: 'Your plan includes 10 websites. Remove one or email support to add more.',
    });
  });

  it('exposes both plans in planInfo, and a deploy link only for a GitHub repository', async () => {
    const { env } = setup();
    expect(await planInfo(env)).toMatchObject({ eventLimit: 50_000, siteLimit: 10, free: { eventLimit: 5_000, siteLimit: 1 }, deployUrl: null });
    expect(await planInfo({ ...env, PLAN_EVENT_LIMIT: '100000', PLAN_SITE_LIMIT: '25', FREE_EVENT_LIMIT: '900' })).toMatchObject({ eventLimit: 100_000, siteLimit: 25, free: { eventLimit: 900, siteLimit: 1 } });
    expect((await planInfo({ ...env, DEPLOY_REPO_URL: 'https://github.com/me/dm' })).deployUrl).toBe('https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fme%2Fdm');
    for (const bad of ['javascript:alert(1)', 'https://evil.test/me/dm', 'https://github.com/me/dm/x']) expect((await planInfo({ ...env, DEPLOY_REPO_URL: bad })).deployUrl).toBeNull();
  });
});
