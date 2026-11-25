import { readCards, storeCards } from '../shared/dashboardCards';
import { DIRECTORIES_LIST, DIRECTORIES_SITE } from '../agent/directories';
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { handleEvent } from './collect';
import { forgetOwnerSites, forgetSite, type AppEnv, type Site } from './env';
import { clearSession, currentUser, googleCallback, googleStart, isHosted, planLimits, requireUser, setSession, siteAccessSql } from './auth';
import { account, billingWebhook, checkout, planInfo, portal, receipt, renewal, usage } from './billing';
import { passwordsMatch, randomId } from './lib/crypto';
import { limitBody } from './lib/limits';
import { handleDodoWebhook, handleGoalApi, handlePaymentApi, handleStripeWebhook, learnDodoProducts, rematchPayments } from './payments';
import { mountAgent, mountOAuth } from '../agent';
import { mountProviders } from '../providers';
import { scheduled } from '../cron';
import { sharePage } from './share';
import { breakdown, customers, funnel, makeCtx, overview, realtime, sparklines, visitorProfile, visitors, type FunnelStep } from './stats';

import { mountOnline, widgetSettings } from './online';
const app = new Hono<AppEnv>();
mountOnline(app);
const MAX_FAILURES = 10;
const MAX_FUNNELS = 100;
const LOCKOUT_MS = 15 * 60_000;
/** Addresses locked out, and until when, so refusing them again touches nothing. Per isolate; D1 stays the authority. */
const lockedOut = new Map<string, number>();

// Basic hardening for everything the Worker answers (API and app pages). Static files get the same
// headers from public/_headers. The tracking script and endpoint stay embeddable on customers' sites.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (c.req.path.startsWith('/api/')) {
    // Stats, settings and secrets must never sit in a shared or browser cache.
    if (c.req.path !== '/api/event' && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  } else {
    // The dashboard can't be framed by another site (clickjacking).
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  }
});

// ---------- public: tracking, webhooks, server-side API

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
app.use('*', limitBody);
app.post('/api/event', handleEvent);
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/webhooks/stripe/:siteId', handleStripeWebhook);
app.post('/api/v1/payments', handlePaymentApi);
app.post('/api/v1/goals', handleGoalApi);

// DataMonster: OAuth 2.1 for MCP clients (src/agent/oauth.ts). Before the login routes: it also brings a hosted owner back to the consent screen after Google sign-in.
mountOAuth(app);

// ---------- login

app.post('/api/auth/login', async (c) => {
  if (isHosted(c.env)) return c.json({ error: 'Use "Continue with Google".' }, 400);
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (see README).' }, 500);
  }
  // Lock an IP out after too many wrong passwords, so a public dashboard can't be brute-forced.
  // The attempt is recorded and counted in one atomic batch BEFORE the password is checked: checking first
  // and recording afterwards would let a burst of parallel guesses all slip under the limit.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();
  const refuse = () => c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  if ((lockedOut.get(ip) ?? 0) > now) return refuse();
  // An address already over the limit adds nothing, so a flood can't grow the table (or keep itself locked out forever).
  const [, , attempts] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS),
    c.env.DB.prepare(
      'INSERT INTO login_failures (ip, ts) SELECT ?, ? WHERE (SELECT COUNT(*) FROM login_failures WHERE ip = ? AND ts > ?) <= ?',
    ).bind(ip, now, ip, now - LOCKOUT_MS, MAX_FAILURES),
    c.env.DB.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM login_failures WHERE ip = ? AND ts > ?').bind(ip, now - LOCKOUT_MS),
  ]);
  const seen = attempts.results[0] as { n: number; first: number } | undefined;
  if ((seen?.n ?? 0) > MAX_FAILURES) {
    if (lockedOut.size >= 5000) lockedOut.clear();
    // Until the oldest attempt runs out: from then on D1 would allow one again.
    lockedOut.set(ip, seen!.first + LOCKOUT_MS);
    return refuse();
  }
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!password || !passwordsMatch(password, c.env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: 'Wrong password' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  await setSession(c, 'admin');
  return c.json({ ok: true });
});

app.get('/api/auth/google', googleStart);
app.get('/api/auth/google/callback', googleCallback);

app.post('/api/auth/logout', async (c) => {
  await clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c);
  return c.json({ loggedIn: !!user, hosted: isHosted(c.env), supportEmail: c.env.SUPPORT_EMAIL || null, user });
});

// ---------- billing (hosted mode)

app.get('/api/public/plan', async (c) => c.json(await planInfo(c.env)));
app.post('/api/billing/webhook', billingWebhook);
app.get('/api/billing/checkout', requireUser, checkout);
app.get('/api/billing/portal', requireUser, portal);
app.get('/api/billing/usage', requireUser, usage);
app.get('/api/billing/account', requireUser, account);
app.get('/api/billing/receipts/:id', requireUser, receipt);
app.post('/api/billing/cancel', requireUser, renewal(false));
app.post('/api/billing/resume', requireUser, renewal(true));

// ---------- dashboard API (login required)

app.use('/api/sites', requireUser);
app.use('/api/sites/*', requireUser);

const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const site = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`)
    .bind(c.req.param('id'), ...access.params)
    .first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

app.get('/api/sites/:id/widget', widgetSettings);
app.put('/api/sites/:id/widget', widgetSettings);

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const mask = (secret: string | null | undefined) => (secret ? '••••••••' : null);
// lemonsqueezy_webhook_secret is a retired column (migration 1009); never return it.
const publicSite = ({ lemonsqueezy_webhook_secret: _retired, ...s }: Site & { polar_webhook_secret?: string | null; lemonsqueezy_webhook_secret?: string | null }) => ({ ...s, dashboard_cards: readCards(s.dashboard_cards), polar_webhook_secret: mask(s.polar_webhook_secret), dodo_webhook_secret: mask(s.dodo_webhook_secret), stripe_webhook_secret: mask(s.stripe_webhook_secret) });

app.get('/api/sites', async (c) => {
  const now = Date.now();
  const access = siteAccessSql(c.env, c.get('user'));
  const [sites, stats] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT s.* FROM sites s WHERE ${access.sql} ORDER BY s.created_at`).bind(...access.params),
    c.env.DB.prepare(
      `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN last_seen_at > ? THEN visitor_id END) AS online
       FROM sessions WHERE started_at > ? AND site_id IN (SELECT s.id FROM sites s WHERE ${access.sql}) GROUP BY site_id`,
    ).bind(now - 5 * 60_000, now - 86_400_000, ...access.params),
  ]);
  const by = new Map((stats.results as any[]).map((r) => [r.site_id, r]));
  return c.json(
    (sites.results as unknown as Site[]).map((s) => ({
      ...publicSite(s),
      visitors24h: by.get(s.id)?.visitors ?? 0,
      online: by.get(s.id)?.online ?? 0,
    })),
  );
});

// Every site's totals and sparkline for the all-websites view.
app.use('/api/sites-overview', requireUser);
app.get('/api/sites-overview', async (c) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const rows = await c.env.DB.prepare(`SELECT s.id FROM sites s WHERE ${access.sql}`).bind(...access.params).all<{ id: string }>();
  return c.json(await sparklines(c.env.DB, rows.results.map((r) => r.id), c.req.query('period') ?? '30d'));
});

app.post('/api/sites', async (c) => {
  const user = c.get('user');
  const plan = user.paid ? 'pro' : 'free';
  const siteLimit = isHosted(c.env) && !user.admin ? planLimits(c.env, plan).siteLimit : null;
  const full = () =>
    c.json(
      {
        error: `${plan === 'pro' ? 'Your plan' : 'Free'} includes ${siteLimit} ${siteLimit === 1 ? 'website' : 'websites'}. ${plan === 'pro' ? 'Remove one or email support to add more' : `Go Pro in Billing for ${planLimits(c.env).siteLimit}`}.`,
      },
      402,
    );
  if (siteLimit !== null) {
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?')
      .bind(user.id)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= siteLimit) return full();
  }
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const domain = cleanDomain(b.domain ?? '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: 'Enter a domain like example.com' }, 400);
  if (b.timezone && !validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
  const tz = b.timezone || 'UTC';
  const site: Site = {
    id: randomId(8),
    name: (b.name || domain).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'USD').toUpperCase().slice(0, 3),
    api_key: 'dmk_' + randomId(16),
    dodo_webhook_secret: null,
    created_at: Date.now(),
  };
  // Counted again by the insert itself, so several requests at once can't all find room.
  const added = await c.env.DB.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, created_at, owner_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR (SELECT COUNT(*) FROM sites WHERE owner_id = ?) < ?',
  )
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, null, site.created_at, isHosted(c.env) ? user.id : null, siteLimit, user.id, siteLimit)
    .run();
  if (!added.meta?.changes) return full();
  if (siteLimit !== null) forgetOwnerSites(user.id);
  return c.json(publicSite(site));
});

app.get('/api/sites/:id', (c) => c.json(publicSite(c.get('site'))));

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Omit<Site, 'dashboard_cards'>> & { dashboard_cards?: unknown }>().catch(() => ({}) as { dashboard_cards?: unknown } & Partial<Omit<Site, 'dashboard_cards'>>);
  const next = { ...site };
  if (b.dashboard_cards !== undefined) {
    if (b.dashboard_cards !== null && !Array.isArray(b.dashboard_cards)) return c.json({ error: 'dashboard_cards must be a list of cards, or null' }, 400);
    next.dashboard_cards = storeCards(b.dashboard_cards);
    // On its own, so moving a card never writes the site's other settings back over a change made meanwhile.
    if (Object.keys(b).length === 1) {
      await c.env.DB.prepare('UPDATE sites SET dashboard_cards = ? WHERE id = ?').bind(next.dashboard_cards, site.id).run();
      forgetSite(site.id);
      return c.json(publicSite(next));
    }
  }
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  if (typeof b.dodo_webhook_secret === 'string' && !b.dodo_webhook_secret.includes('•')) {
    next.dodo_webhook_secret = b.dodo_webhook_secret.trim().slice(0, 500) || null;
  }
  if (typeof b.stripe_webhook_secret === 'string' && !b.stripe_webhook_secret.includes('•')) {
    next.stripe_webhook_secret = b.stripe_webhook_secret.trim().slice(0, 500) || null;
  }
  if (typeof b.dodo_product_ids === 'string') {
    const ids = b.dodo_product_ids.split(/[\s,]+/).filter((x) => /^pdt_[\w-]{1,96}$/.test(x)).slice(0, 200);
    next.dodo_product_ids = ids.join(',') || null;
  }
  if (typeof b.proxy_location === 'boolean' || b.proxy_location === 0 || b.proxy_location === 1) next.proxy_location = b.proxy_location ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?, dodo_webhook_secret = ?, dodo_product_ids = ?, stripe_webhook_secret = ?, proxy_location = ?${b.dashboard_cards !== undefined ? ', dashboard_cards = ?' : ''} WHERE id = ?`,
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.dodo_webhook_secret,
      next.dodo_product_ids ?? null,
      next.stripe_webhook_secret ?? null,
      next.proxy_location ?? 0,
      ...(b.dashboard_cards !== undefined ? [next.dashboard_cards ?? null] : []),
      site.id,
    )
    .run();
  forgetSite(site.id);
  return c.json(publicSite(next));
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'dmk_' + randomId(16);
  await c.env.DB.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  const id = c.get('site').id;
  await c.env.DB.batch(
    // Everything stored for the site, so deleting it really removes its visitors' data.
    ['events', 'sessions', 'visitors', 'payments', 'funnels', 'payment_claims', 'pending_payments', 'dodo_products', 'tracked_links', 'annotations', 'placements', 'agent_audit'].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id),
    ).concat(c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id)),
  );
  forgetSite(id);
  // The owner's other sites may now be allowed to record.
  const owner = c.get('site').owner_id;
  if (owner) forgetOwnerSites(owner);
  return c.json({ ok: true });
});

// ---------- stats

app.get('/api/sites/:id/overview', async (c) => c.json(await overview(makeCtx(c))));

app.get('/api/sites/:id/breakdown', async (c) => {
  try {
    return c.json(await breakdown(makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Dodo payments that couldn't be placed on a site yet, grouped by product.
app.get('/api/sites/:id/pending-payments', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT product_id, COUNT(*) AS count, SUM(json_extract(payload, '$.amount')) AS amount, MAX(json_extract(payload, '$.currency')) AS currency
     FROM pending_payments WHERE site_id = ? GROUP BY product_id ORDER BY MAX(ts) DESC`,
  )
    .bind(c.get('site').id)
    .all();
  return c.json(r.results);
});
app.post('/api/sites/:id/pending-payments', async (c) => {
  const b = await c.req.json<{ product_id?: string }>().catch(() => ({}) as { product_id?: string });
  if (!b.product_id || !/^pdt_[\w-]+$/.test(b.product_id)) return c.json({ error: 'product_id is required' }, 400);
  await learnDodoProducts(c.env.DB, c.get('site'), [b.product_id]);
  return c.json({ ok: true });
});
app.post('/api/sites/:id/rematch', async (c) => {
  const b = await c.req.json<{ after?: unknown }>().catch(() => ({ after: null }));
  return c.json(await rematchPayments(c.env.DB, c.get('site'), typeof b?.after === 'string' ? b.after : null));
});
app.get('/api/sites/:id/realtime', async (c) => c.json(await realtime(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/customers', async (c) => c.json(await customers(makeCtx(c))));
app.get('/api/sites/:id/visitors', async (c) => c.json(await visitors(makeCtx(c))));
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(c.env.DB, c.get('site'), c.req.param('vid'))),
);

app.get('/api/sites/:id/funnels', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
});

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const steps = (b.steps ?? [])
    .filter((s) => (s.type === 'page' || s.type === 'goal' || s.type === 'payment') && (s.type === 'payment' || (typeof s.value === 'string' && s.value.trim())))
    .slice(0, 10)
    .map((s) => ({
      type: s.type,
      value: s.type === 'payment' ? (typeof s.value === 'string' && s.value.trim() ? s.value.trim().slice(0, 200) : 'any') : s.value.trim().slice(0, 200),
    }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const kept = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM funnels WHERE site_id = ?').bind(c.get('site').id).first<{ n: number }>();
  if ((kept?.n ?? 0) >= MAX_FUNNELS) return c.json({ error: `A website can have ${MAX_FUNNELS} funnels. Delete one first.` }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await c.env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', async (c) => {
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtx(c), JSON.parse(f.steps)));
});

// DataMonster agent layer: agent API, MCP server, agent tokens and audit log (src/agent).
// Our own list of launch directories gave way to the public one others maintain. Old links still lead somewhere.
app.on('GET', ['/directories', '/directories/', '/directories.md'], (c) => c.redirect(DIRECTORIES_SITE));
app.get('/directories.json', (c) => c.redirect(DIRECTORIES_LIST));
mountAgent(app);
mountProviders(app);

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Static files are served before the Worker runs. What reaches here is the home page (run_worker_first in wrangler.jsonc,
// for its link preview), a client-side route, or a page that doesn't exist.
const PUBLIC_PAGES = /^\/((terms|privacy|refund)\/?)?$/;
const APP_PAGES = /^\/(agents\/?|launches\/?|links\/?|oauth\/consent\/?|billing(\/.*)?|site\/[\w-]+(\/settings)?\/?)$/;

app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  const index = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const { html, headers } = await sharePage(index, c.req.url, PUBLIC_PAGES.test(path) ? path : '/');
  // Signed-in pages are private and unknown paths shouldn't rank: keep both out of search results.
  if (!PUBLIC_PAGES.test(path)) headers.set('X-Robots-Tag', 'noindex');
  const status = PUBLIC_PAGES.test(path) || APP_PAGES.test(path) ? 200 : 404;
  return new Response(html, { status, headers });
});

// DataMonster: the Worker also answers cron triggers (src/cron). `request` keeps app.request working for the tests.
export { app };
export default { fetch: app.fetch, request: app.request, scheduled };
