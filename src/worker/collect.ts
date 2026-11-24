import type { Context } from 'hono';
import { classify } from '../shared/sources';
import { bumpUsage, recordingLimits, utcMonth } from './auth';
import { getSite, type AppEnv, type Site } from './env';
import { isBot, parseUA } from './lib/ua';
import { hmacHex } from './lib/crypto';
import { memoryLimiter } from './lib/limits';
import { creditedSessionSql } from './payments';

const TYPES = new Set(['pageview', 'goal', 'outbound', 'ping', 'identify']);
const MAX_PING_MS = 10 * 60_000;
/** How far a visit's engaged time may run ahead of the clock, for requests that arrive late or out of order. */
const PING_SLACK_MS = 10_000;
// The tracker sends a ping a minute, plus one per page change. Well above that, per visit and per address.
const pingsPerVisit = memoryLimiter(30, 60_000);
const pingsPerAddress = memoryLimiter(600, 60_000);

interface Payload {
  w: string;
  t: string;
  u: string;
  r?: string;
  vid: string;
  sid: string;
  sw?: number;
  n?: string;
  p?: Record<string, unknown>;
  d?: number;
}

const clip = (s: unknown, n = 255): string | null =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null;

const POLAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

export function normalizePath(pathname: string): string {
  let p = pathname || '/';
  try {
    p = decodeURI(p);
  } catch {}
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 500);
}

function stripWww(h: string) {
  return h.replace(/^www\./, '').toLowerCase();
}

/** Is `hostname` the site's domain or one of its subdomains? */
export function belongsTo(hostname: string, domain: string): boolean {
  const h = stripWww(hostname);
  const d = stripWww(domain);
  return h === d || h.endsWith('.' + d);
}

export async function handleEvent(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.body(null, 413);
  let body: Payload;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  if (!body || !isId(body.w) || !TYPES.has(body.t) || !isId(body.vid) || !isId(body.sid)) return c.body(null, 400);

  const ua = c.req.header('user-agent') ?? '';
  if (isBot(ua)) return c.body(null, 202);

  const site = await getSite(c.env.DB, body.w);
  if (!site) return c.body(null, 404);

  let url: URL;
  try {
    url = new URL(body.u);
  } catch {
    return c.body(null, 400);
  }
  // Only accept data for the site's own domain, so nobody can pollute your stats from elsewhere.
  if (!belongsTo(url.hostname, site.domain)) return c.body(null, 403);

  const now = Date.now();
  if (body.t === 'ping') {
    // Visitors of a site that serves the script itself all share the proxy's address.
    const ok = pingsPerVisit(`${site.id}|${body.sid}`, now) && (site.proxy_location || pingsPerAddress(addressOf(c.req.header('cf-connecting-ip')), now));
    if (!ok) return c.body(null, 429);
  }
  let usage: Usage | undefined;
  const limits = await recordingLimits(c.env, site, now);
  if (!limits) return c.body(null, 202);
  if (limits !== 'none' && site.owner_id) {
    if (body.t !== 'ping') {
      const month = utcMonth(now);
      const { hardEventLimit, addressDailyLimit, proxyDailyLimit } = limits;
      const day = new Date(now).toISOString().slice(0, 10);
      const sourceKey = await addressKey(c.env.SESSION_SECRET, day, site.proxy_location ? `${site.owner_id}|proxy` : site.owner_id, c.req.header('cf-connecting-ip'));
      const row = await c.env.DB.prepare(
        `SELECT (SELECT events FROM usage_monthly WHERE owner_id = ? AND month = ?) AS events,
                (SELECT events FROM event_sources WHERE key = ?) AS from_address`,
      )
        .bind(site.owner_id, month, sourceKey)
        .first<{ events: number | null; from_address: number | null }>();
      if ((row?.events ?? 0) >= hardEventLimit) return c.body(null, 202);
      // One address can't use up the owner's month by sending made-up events.
      if ((row?.from_address ?? 0) >= (site.proxy_location ? proxyDailyLimit : addressDailyLimit)) return c.body(null, 429);
      usage = { ownerId: site.owner_id, day, sourceKey };
    }
  }

  await ingest(c.env.DB, site, body, url, ua, geoOf(c, site), now, usage);
  return c.body(null, 202);
}

/** What a stored event counts against: the owner's month, and the sending address's day. */
interface Usage {
  ownerId: string;
  day: string;
  sourceKey: string;
}

/** An IPv6 connection usually owns a whole /64, so that is what counts as one address. */
export function addressOf(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}

/** A keyed hash that changes every day and per owner (the month is the owner's, across all their sites), so it can't be turned back into an address or followed over time. */
const addressKey = (secret: string, day: string, ownerId: string, ip: string | undefined) => hmacHex(secret, `event-source|${day}|${ownerId}|${addressOf(ip)}`);

export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

/** City-level coordinates, rounded to 2 decimals (~1 km) so no precise location is ever stored. */
function coord(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 100) / 100 : null;
}

/**
 * Visitor location. When the script is proxied through your own domain (to dodge ad blockers), Cloudflare sees the
 * proxy's location, so an owner who does that can turn on the proxy's geo headers (Vercel sets these). Anyone can send
 * them, so they are ignored otherwise.
 */
function geoOf(c: Context<AppEnv>, site: Site): Geo {
  const h = (n: string) => {
    const v = c.req.header(n);
    try {
      return v ? decodeURIComponent(v) : null;
    } catch {
      return v ?? null;
    }
  };
  const country = site.proxy_location ? h('x-vercel-ip-country') : null;
  if (country && /^[A-Za-z0-9]{2}$/.test(country)) {
    return {
      country: country.toUpperCase(),
      region: clip(h('x-vercel-ip-country-region'), 100),
      city: clip(h('x-vercel-ip-city'), 100),
      lat: coord(h('x-vercel-ip-latitude'), 90),
      lon: coord(h('x-vercel-ip-longitude'), 180),
    };
  }
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;
  return {
    country: (cf?.country as string) ?? null,
    region: (cf?.region as string) ?? null,
    city: (cf?.city as string) ?? null,
    lat: coord(cf?.latitude, 90),
    lon: coord(cf?.longitude, 180),
  };
}

export async function ingest(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  ua: string,
  geo: Geo,
  now: number,
  usage?: Usage,
) {
  const path = normalizePath(url.pathname);
  const { t, vid, sid } = body;

  if (t === 'ping') {
    const ms = Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(body.d) || 0)));
    // Engaged time can't be longer than the visit itself.
    await db
      .prepare('UPDATE sessions SET duration = MAX(duration, MIN(duration + ?, ? - started_at)), last_seen_at = ? WHERE site_id = ? AND id = ?')
      .bind(ms, now + PING_SLACK_MS, now, site.id, sid)
      .run();
    return;
  }

  if (t === 'identify') {
    const p = body.p ?? {};
    const stmts = [
      db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, vid, now),
      db
        .prepare(
          'UPDATE visitors SET user_id = COALESCE(?, user_id), email = COALESCE(?, email), name = COALESCE(?, name) WHERE site_id = ? AND id = ?',
        )
        .bind(clip(p.user_id, 128), clip(p.email, 200)?.toLowerCase() ?? null, clip(p.name, 128), site.id, vid),
    ];
    if (usage) stmts.push(...countEvent(db, usage, site.id, now));
    await db.batch(stmts);
    return;
  }

  const existing = await db
    .prepare('SELECT 1 FROM sessions WHERE site_id = ? AND id = ?')
    .bind(site.id, sid)
    .first();

  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(...newSession(db, site, body, url, path, ua, geo, now));
  }

  if (t === 'pageview') {
    if (existing) {
      stmts.push(
        db
          .prepare('UPDATE sessions SET pageviews = pageviews + 1, exit_page = ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
          .bind(path, now, site.id, sid),
      );
    }
    stmts.push(insertEvent(db, site.id, sid, vid, now, 'pageview', null, path, null));
    stmts.push(...claimPayment(db, site.id, vid, url, now));
  } else if (t === 'goal') {
    const name = clip(body.n, 64);
    if (!name) return;
    const props = body.p && typeof body.p === 'object' ? JSON.stringify(body.p).slice(0, 1000) : null;
    stmts.push(
      db.prepare('UPDATE sessions SET goals = goals + 1, last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'goal', name, path, props),
    );
  } else if (t === 'outbound') {
    const target = clip(body.n, 500);
    if (!target) return;
    stmts.push(
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'outbound', target, path, null),
    );
  }
  if (usage) stmts.push(...countEvent(db, usage, site.id, now));
  await db.batch(stmts);
}

function countEvent(db: D1Database, u: Usage, siteId: string, now: number) {
  return [
    ...bumpUsage(db, u.ownerId, siteId, now),
    db.prepare('INSERT INTO event_sources (key, day, events) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET events = events + 1').bind(u.sourceKey, u.day),
  ];
}

/**
 * Dodo sends buyers back to your return URL with ?payment_id=pay_... and Stripe with ?session_id=cs_...
 * (when the success URL has {CHECKOUT_SESSION_ID}). Seeing that on a pageview tells us exactly which
 * visitor made the payment, even when the checkout had no metadata.
 */
function claimPayment(db: D1Database, siteId: string, vid: string, url: URL, now: number): D1PreparedStatement[] {
  const q = url.searchParams;
  // Polar's success URL (`?checkout_id={CHECKOUT_ID}`) carries the checkout session UUID, which its order webhook reports as checkout_id.
  let paymentId = q.get('payment_id') ?? q.get('subscription_id') ?? q.get('session_id');
  if (paymentId) {
    if (!/^(pay|sub)_[\w-]{4,64}$|^cs_(test|live)_\w{4,200}$/.test(paymentId)) return [];
  } else {
    const polarId = q.get('checkout_id');
    if (!polarId || !POLAR_ID.test(polarId)) return [];
    paymentId = polarId.toLowerCase();
  }
  return [
    db
      .prepare('INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
      .bind(siteId, paymentId, vid, now),
    // The webhook usually arrives first; link that payment now if nothing else already did.
    db
      .prepare(
        `UPDATE payments SET visitor_id = ?, matched_by = 'return_page',
           session_id = (${creditedSessionSql()})
         WHERE site_id = ? AND ? IN (id, subscription_id, checkout_id) AND visitor_id IS NULL`,
      )
      .bind(vid, siteId, vid, now + 60_000, siteId, paymentId),
    db
      .prepare(
        `UPDATE visitors SET email = COALESCE(email, (SELECT email FROM payments WHERE site_id = ? AND ? IN (id, subscription_id, checkout_id) LIMIT 1)),
           name = COALESCE(name, (SELECT name FROM payments WHERE site_id = ? AND ? IN (id, subscription_id, checkout_id) LIMIT 1))
         WHERE site_id = ? AND id = ?`,
      )
      .bind(siteId, paymentId, siteId, paymentId, siteId, vid),
  ];
}

function insertEvent(
  db: D1Database,
  siteId: string,
  sid: string,
  vid: string,
  ts: number,
  type: string,
  name: string | null,
  path: string,
  props: string | null,
) {
  return db
    .prepare('INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(siteId, sid, vid, ts, type, name, path, props);
}

function newSession(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  path: string,
  ua: string,
  geo: Geo,
  now: number,
): D1PreparedStatement[] {
  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  if (body.r) {
    try {
      const r = new URL(body.r);
      // Navigation between your own pages/subdomains is not a referral.
      if (/^https?:$/.test(r.protocol) && !belongsTo(r.hostname, site.domain)) {
        referrerDomain = stripWww(r.hostname);
        referrer = (r.hostname + normalizePath(r.pathname)).slice(0, 500);
      }
    } catch {
      // android-app://com.google.android.gm and friends
      const m = /^android-app:\/\/([\w.]+)/.exec(body.r);
      if (m) referrerDomain = m[1];
    }
  }
  const q = url.searchParams;
  const utm = {
    source: clip(q.get('utm_source'), 100),
    medium: clip(q.get('utm_medium'), 100),
    campaign: clip(q.get('utm_campaign'), 200),
    term: clip(q.get('utm_term'), 200),
    content: clip(q.get('utm_content'), 200),
  };
  const ref = clip(q.get('ref') ?? q.get('via'), 100);
  const { source, channel } = classify({ referrerDomain, utmSource: utm.source, utmMedium: utm.medium, ref });
  const { browser, os, device } = parseUA(ua, Number(body.sw) || undefined);
  const pageviews = body.t === 'pageview' ? 1 : 0;

  return [
    db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, body.vid, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page,
          referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
          country, region, city, browser, os, device, lat, lon)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        site.id,
        body.sid,
        body.vid,
        now,
        now,
        stripWww(url.hostname),
        path,
        path,
        referrer,
        referrerDomain?.slice(0, 253) ?? null,
        clip(source, 253),
        channel,
        utm.source,
        utm.medium,
        utm.campaign,
        utm.term,
        utm.content,
        ref,
        geo.country,
        geo.region,
        geo.city,
        browser,
        os,
        device,
        geo.lat,
        geo.lon,
      ),
    // Separate statement so concurrent first events (pageview + goal racing) never double count.
    ...(pageviews
      ? [db.prepare('UPDATE sessions SET pageviews = pageviews + 1 WHERE site_id = ? AND id = ?').bind(site.id, body.sid)]
      : []),
  ];
}
