import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env, SiteWithOwner } from './env';
import { randomId, signToken, verifyToken } from './lib/crypto';
import { memoryLimiter } from './lib/limits';

/**
 * Two modes:
 *  - self-hosted (default): one owner, password login (ADMIN_PASSWORD), sees every site.
 *  - hosted: set GOOGLE_CLIENT_ID/SECRET (and HOSTED_MODE=true); anyone can sign in with Google and sees only their own sites, on Free until they pay for Pro.
 *    Emails in ADMIN_EMAILS have no limits, never pay and also own the sites created before accounts existed.
 */
export const isHosted = (env: Env) => /^(1|true|yes|on)$/i.test(env.HOSTED_MODE ?? '') || !!(env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET);

/** A half-configured install stays hosted (accounts stay separate), but nobody can sign in until both values are set. */
const googleReady = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  admin: boolean;
  /** On Pro (or the owner). */
  paid: boolean;
  plan_status: string;
  plan_until: number | null;
  /** When the next payment is due, while the plan renews. */
  renews_at: number | null;
  /** A subscription will charge again. True without Pro when its last payment was refunded but it wasn't cancelled. */
  renewing: boolean;
  /** Set when Pro has ended but its event limit runs to the end of the month. */
  pro_limits_until: number | null;
  /** Monthly subscription. */
  plan: string | null;
  events_used: number | null;
  events_limit: number | null;
  hard_limit: number | null;
  sites_used: number | null;
  sites_limit: number | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  plan_status: string;
  plan_until: number | null;
  plan: string | null;
}

const SELF_HOSTED_OWNER: User = {
  id: 'admin',
  email: null,
  name: null,
  avatar: null,
  admin: true,
  paid: true,
  plan_status: 'active',
  plan_until: null,
  renews_at: null,
  renewing: false,
  pro_limits_until: null,
  plan: null,
  events_used: null,
  events_limit: null,
  hard_limit: null,
  sites_used: null,
  sites_limit: null,
};

const DAY_MS = 86_400_000;
/**
 * A few days of slack after a renewal date, so a late renewal webhook never cuts anyone off. Also how long someone keeps
 * Pro after a renewal payment fails, while Polar retries their card.
 */
export const PLAN_SLACK_MS = 3 * DAY_MS;

function positiveInt(raw: string | undefined, fallback: number) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type PlanName = 'pro' | 'free';
/** Free records one website (recordingLimits keeps exactly one), so this isn't a setting. */
const FREE_SITES = 1;

/** Hosted plan limits, overridable via env vars. */
export function planLimits(env: Env, plan: PlanName = 'pro') {
  if (plan === 'free') {
    const eventLimit = positiveInt(env.FREE_EVENT_LIMIT, 5_000);
    // Less than a thirty-first each, so one address can't use up the month on its own.
    const addressDailyLimit = Math.min(positiveInt(env.PLAN_ADDRESS_DAILY_LIMIT, eventLimit), Math.max(1, Math.floor((eventLimit - 1) / 31)));
    return { eventLimit, hardMultiplier: 1, hardEventLimit: eventLimit, siteLimit: FREE_SITES, agentCallsPerDay: 1_000, addressDailyLimit, proxyDailyLimit: Math.max(addressDailyLimit, Math.floor(eventLimit / 5)) };
  }
  const eventLimit = positiveInt(env.PLAN_EVENT_LIMIT, 50_000);
  const multRaw = Number(env.PLAN_EVENT_HARD_MULTIPLIER);
  const hardMultiplier = Number.isFinite(multRaw) && multRaw >= 1 ? multRaw : 3;
  const hardEventLimit = Math.floor(eventLimit * hardMultiplier);
  const siteLimit = positiveInt(env.PLAN_SITE_LIMIT, 10);
  const addressDailyLimit = positiveInt(env.PLAN_ADDRESS_DAILY_LIMIT, Math.max(1, Math.floor(eventLimit * 0.08)));
  // Through the owner's own proxy, every visitor has the proxy's address: a fifth of the month's hard limit a day.
  const proxyDailyLimit = Math.max(addressDailyLimit, Math.floor(hardEventLimit / 5));
  return { eventLimit, hardMultiplier, hardEventLimit, siteLimit, agentCallsPerDay: 20_000, addressDailyLimit, proxyDailyLimit };
}

/** Calendar month key in UTC, e.g. '2026-11'. */
export function utcMonth(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

export const AUTH_COOKIE = 'dm_auth';
const AUTH_DAYS = 30;
const OAUTH_COOKIE = 'dm_oauth';

export const adminEmails = (env: Env) =>
  (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function isAdminEmail(env: Env, email: string | null | undefined) {
  return !!email && adminEmails(env).includes(email.toLowerCase());
}

/** Pro lasts to its paid-through date. */
export const planActive = (until: number | null | undefined, now = Date.now()) => !!until && until > now;

/**
 * The plan whose limits recording follows. Someone whose Pro ends keeps its limits to the end of that month (UTC): they
 * may already be past Free's, and would otherwise stop being counted the moment they cancel.
 */
export const recordingPlan = (until: number | null | undefined, now = Date.now()): PlanName =>
  planActive(until, now) || (until && utcMonth(until) === utcMonth(now)) ? 'pro' : 'free';

/** The limits a site records under, 'none' when it has none, or null when Free has paused it. */
export async function recordingLimits(env: Env, site: SiteWithOwner, now = Date.now()): Promise<ReturnType<typeof planLimits> | 'none' | null> {
  if (!isHosted(env) || !site.owner_id || isAdminEmail(env, site.owner_email)) return 'none';
  const plan = recordingPlan(site.owner_plan_until, now);
  const limits = planLimits(env, plan);
  if (plan === 'free' && (site.owner_sites ?? 1) > limits.siteLimit) {
    const kept = site.owner_free_site ?? (await pickFreeSite(env.DB, site.owner_id, now));
    if (kept !== site.id) return null;
  }
  return limits;
}

/** An account with more websites than Free records keeps its busiest of the last 30 days. Chosen once, so it doesn't move about. */
export async function pickFreeSite(db: D1Database, ownerId: string, now = Date.now()): Promise<string | null> {
  const since = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10);
  await db
    .prepare(
      `UPDATE users SET free_site_id = (
         SELECT s.id FROM sites s LEFT JOIN usage_daily d ON d.owner_id = s.owner_id AND d.site_id = s.id AND d.day >= ?
         WHERE s.owner_id = users.id GROUP BY s.id ORDER BY COALESCE(SUM(d.events), 0) DESC, s.created_at, s.id LIMIT 1)
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM sites k WHERE k.id = users.free_site_id AND k.owner_id = users.id)`,
    )
    .bind(since, ownerId)
    .run();
  return (await db.prepare('SELECT free_site_id FROM users WHERE id = ?').bind(ownerId).first<{ free_site_id: string | null }>())?.free_site_id ?? null;
}

/** Counts one stored event toward the owner's month and the website's day. */
export function bumpUsage(db: D1Database, ownerId: string, siteId: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare('INSERT INTO usage_monthly (owner_id, month, events) VALUES (?, ?, 1) ON CONFLICT(owner_id, month) DO UPDATE SET events = events + 1').bind(ownerId, utcMonth(now)),
    db.prepare('INSERT INTO usage_daily (owner_id, day, site_id, events) VALUES (?, ?, ?, 1) ON CONFLICT(owner_id, day, site_id) DO UPDATE SET events = events + 1').bind(ownerId, new Date(now).toISOString().slice(0, 10), siteId),
  ];
}

/**
 * May this site record one more payment? Payments don't count toward the event limit (losing one would be worse than
 * losing a visit), but they have the same size of allowance of their own, so a free account can't write without end.
 */
export async function takePayment(env: Env, site: SiteWithOwner, now = Date.now()): Promise<boolean> {
  const limits = await recordingLimits(env, site, now);
  if (limits === 'none') return true;
  if (!limits) return false;
  const key = `${utcMonth(now)}/payments`;
  const row = await env.DB.prepare('SELECT events FROM usage_monthly WHERE owner_id = ? AND month = ?').bind(site.owner_id, key).first<{ events: number }>();
  if ((row?.events ?? 0) >= limits.hardEventLimit) return false;
  await env.DB.prepare('INSERT INTO usage_monthly (owner_id, month, events) VALUES (?, ?, 1) ON CONFLICT(owner_id, month) DO UPDATE SET events = events + 1').bind(site.owner_id, key).run();
  return true;
}

/** Password sessions are signed with the password too, so changing it ends them. */
const sessionKey = (env: Env, subject: string) => (subject === 'admin' ? `${env.SESSION_SECRET}|${env.ADMIN_PASSWORD}` : env.SESSION_SECRET);

/** Starts a session and returns its cookie value: "<subject>.<session id>.<expires>.<signature>". */
export async function createSession(env: Env, subject: string, now = Date.now(), ttlMs = AUTH_DAYS * DAY_MS): Promise<string> {
  const id = randomId(16);
  const expires = now + ttlMs;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('INSERT INTO auth_sessions (id, subject, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(id, subject, now, expires),
  ]);
  return signToken(sessionKey(env, subject), `${subject}.${id}.${expires}`);
}

/** The signed, unexpired session in the cookie. The caller still checks that its row exists. */
async function cookieSession(c: Context<AppEnv>): Promise<{ subject: string; id: string } | null> {
  if (!c.env.SESSION_SECRET) return null;
  const cookie = getCookie(c, AUTH_COOKIE);
  const subject = cookie?.split('.')[0] ?? '';
  if (!subject) return null;
  const value = await verifyToken(sessionKey(c.env, subject), cookie);
  const parts = value?.split('.') ?? [];
  if (parts.length !== 3 || !(Number(parts[2]) > Date.now())) return null;
  return { subject, id: parts[1] };
}

export async function setSession(c: Context<AppEnv>, subject: string) {
  setCookie(c, AUTH_COOKIE, await createSession(c.env, subject), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: AUTH_DAYS * 86_400,
  });
}

/** Ends the session itself, not just this browser's cookie. */
export async function clearSession(c: Context<AppEnv>) {
  const session = await cookieSession(c);
  deleteCookie(c, AUTH_COOKIE, { path: '/' });
  if (session) await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?').bind(session.id).run();
}

export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  const session = await cookieSession(c);
  if (!session) return null;
  const now = Date.now();
  // Self-hosted password session
  if (session.subject === 'admin') {
    if (isHosted(c.env)) return null;
    const live = await c.env.DB.prepare('SELECT 1 FROM auth_sessions WHERE id = ? AND subject = ? AND expires_at > ?').bind(session.id, 'admin', now).first();
    return live ? SELF_HOSTED_OWNER : null;
  }
  // Hosted Google session: "u:<userId>"
  if (!session.subject.startsWith('u:') || !isHosted(c.env)) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.*,
       COALESCE((SELECT events FROM usage_monthly WHERE owner_id = u.id AND month = ?), 0) AS events_used,
       (SELECT COUNT(*) FROM sites WHERE owner_id = u.id) AS sites_used,
       EXISTS (SELECT 1 FROM plan_subscriptions p WHERE p.user_id = u.id AND p.status IN ('active', 'past_due') AND p.until > ?) AS renewing
     FROM users u JOIN auth_sessions a ON a.id = ? AND a.subject = 'u:' || u.id AND a.expires_at > ?
     WHERE u.id = ?`,
  )
    .bind(utcMonth(), now, session.id, now, session.subject.slice(2))
    .first<UserRow & { events_used: number; sites_used: number; renewing: number }>();
  if (!row) return null;
  const admin = isAdminEmail(c.env, row.email);
  const paid = admin || planActive(row.plan_until, now);
  const plan = recordingPlan(row.plan_until, now);
  const limits = admin ? null : planLimits(c.env, plan);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    admin,
    paid,
    plan_status: row.plan_status,
    plan_until: row.plan_until,
    renews_at: paid && row.plan_status === 'active' && row.plan_until ? row.plan_until - PLAN_SLACK_MS : null,
    renewing: !!row.renewing,
    pro_limits_until: !paid && plan === 'pro' ? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1) : null,
    plan: row.plan,
    events_used: limits ? Number(row.events_used ?? 0) : null,
    events_limit: limits ? limits.eventLimit : null,
    hard_limit: limits ? limits.hardEventLimit : null,
    sites_used: limits ? Number(row.sites_used ?? 0) : null,
    sites_limit: admin ? null : planLimits(c.env, paid ? 'pro' : 'free').siteLimit,
  };
}

// Anyone can sign up, so what one account can make the server do a minute is bounded. A busy dashboard stays far below.
const callsPerAccount = memoryLimiter(600, 60_000);

export const requireUser = async (c: Context<AppEnv>, next: Next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (isHosted(c.env) && !user.admin && !callsPerAccount(user.id)) return c.json({ error: 'Too many requests. Try again in a minute.' }, 429);
  c.set('user', user);
  await next();
};

/** SQL that limits `sites s` to the ones this user may see. */
export function siteAccessSql(env: Env, user: User): { sql: string; params: unknown[] } {
  if (!isHosted(env)) return { sql: '1 = 1', params: [] };
  if (user.admin) return { sql: '(s.owner_id = ? OR s.owner_id IS NULL)', params: [user.id] };
  return { sql: 's.owner_id = ?', params: [user.id] };
}

// ---------- Google sign-in (OAuth 2.0 authorization code flow)

function redirectUri(c: Context<AppEnv>) {
  return `${new URL(c.req.url).origin}/api/auth/google/callback`;
}

export async function googleStart(c: Context<AppEnv>) {
  if (!isHosted(c.env)) return c.text('Google sign-in is not configured', 404);
  if (!googleReady(c.env)) return c.redirect(`/?login_error=${encodeURIComponent('Sign-in is not set up yet. Please try again later.')}`);
  const state = randomId(16) + (c.req.query('plan') === 'pro' ? '.pro' : '');
  setCookie(c, OAUTH_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/api/auth/google',
    maxAge: 600,
  });
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
}

export async function googleCallback(c: Context<AppEnv>) {
  if (!isHosted(c.env)) return c.text('Google sign-in is not configured', 404);
  const fail = (msg: string) => c.redirect(`/?login_error=${encodeURIComponent(msg)}`);
  if (!googleReady(c.env)) return fail('Sign-in is not set up yet. Please try again later.');
  const state = c.req.query('state');
  const expected = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/auth/google' });
  if (!state || !expected || state !== expected) return fail('Sign-in expired, please try again.');
  const code = c.req.query('code');
  if (!code) return fail(c.req.query('error') ?? 'Sign-in was cancelled.');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(c),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return fail('Google sign-in failed.');
  const tokens = await res.json<{ id_token?: string }>();
  if (!tokens.id_token) return fail('Google sign-in failed.');
  // The token came straight from Google over TLS, so its claims can be trusted; still check who it's for.
  const claims = decodeJwtPayload(tokens.id_token);
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.sub || !claims.email || claims.email_verified !== true) {
    return fail('Google sign-in failed.');
  }
  const email = String(claims.email).toLowerCase();
  const now = Date.now();
  // The Google account id is the identity. An email can change hands, so it never opens an existing account.
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(claims.sub).first<{ id: string }>();
  const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').bind(email, existing?.id ?? '').first();
  if (taken) return fail('That email address belongs to another DataMonster account. Sign in with the Google account you first used, or contact support.');
  const id = existing?.id ?? randomId(10);
  const stmts = [
    existing
      ? c.env.DB.prepare('UPDATE users SET google_sub = ?, email = ?, name = ?, avatar = ? WHERE id = ?').bind(
          claims.sub,
          email,
          claims.name ?? null,
          claims.picture ?? null,
          id,
        )
      : c.env.DB.prepare('INSERT INTO users (id, google_sub, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
          id,
          claims.sub,
          email,
          claims.name ?? null,
          claims.picture ?? null,
          now,
        ),
  ];
  // The owner takes over the sites that existed before accounts were turned on.
  if (isAdminEmail(c.env, email)) stmts.push(c.env.DB.prepare('UPDATE sites SET owner_id = ? WHERE owner_id IS NULL').bind(id));
  await c.env.DB.batch(stmts);
  await setSession(c, `u:${id}`);
  // ?signup=1 lets the app record a "signup_completed" goal for brand-new accounts.
  return c.redirect((state.endsWith('.pro') ? '/billing' : '/') + (existing ? '' : '?signup=1'));
}
