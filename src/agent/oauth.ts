/**
 * OAuth 2.1 for MCP clients (MCP authorization spec 2025-06-18): DataMonster is its own authorization server, so
 * Claude.ai, ChatGPT and other MCP clients connect with "sign in to the dashboard and click Allow".
 *
 *   GET  /.well-known/oauth-protected-resource      RFC 9728 (also at .../api/agent/mcp)
 *   GET  /.well-known/oauth-authorization-server    RFC 8414
 *   POST /oauth/register                            RFC 7591, public clients only
 *   GET  /oauth/authorize                           checks the request, then sends the owner to /oauth/consent
 *   GET  /api/oauth/consent, POST /api/oauth/consent the dashboard's consent screen (signed-in owner, CSRF token)
 *   POST /oauth/token                               authorization_code (PKCE S256) and refresh_token (rotated)
 *   POST /oauth/revoke                              RFC 7009
 *
 * An approved connection is one agent_tokens row (name = the client's name, oauth_client_id set). Its access secret
 * lasts an hour and is replaced on every refresh, so agentAuth, scopes, site limits, the audit log and the Agents page
 * work as for any token. Revoking the row ends the connection: its refresh tokens stop working with it.
 */
import { memoryLimiter } from '../worker/lib/limits';
import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie } from 'hono/cookie';
import type { AppEnv, Env } from '../worker/env';
import { isHosted, requireUser } from '../worker/auth';
import { randomId, signToken, verifyToken } from '../worker/lib/crypto';
import { cleanScopes, createToken, ownerIdFor, REFRESH_TTL_MS, sha256Hex, TOKEN_PREFIX, tokenSiteAccess, type Scope, tokensUsedUp } from './tokens';

export const ACCESS_TTL_MS = 60 * 60_000;
export const CODE_TTL_MS = 60_000;
const CSRF_TTL_MS = 30 * 60_000;
const REFRESH_PREFIX = 'dmr_';
/** Each Allow stores a code, so an account has a few a minute. */
const allowsPerAccount = memoryLimiter(10, 60_000);
const RETURN_COOKIE = 'dm_oauth_return';
const MAX_REDIRECT_URIS = 10;
const MAX_REGISTRATIONS_PER_IP_HOUR = 20;
const MAX_REGISTRATIONS_HOUR = 500;

type Json = Record<string, unknown>;
type Params = Record<string, unknown>;

export const mcpResource = (origin: string) => `${origin}/api/agent/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;
const originOf = (c: Context) => new URL(c.req.url).origin;

export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
    resource_name: 'DataMonster',
    resource_documentation: `${origin}/api/agent/v1/guide`,
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read', 'write'],
    authorization_response_iss_parameter_supported: true,
  };
}

// ---------------------------------------------------------------- helpers

function base64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** https anywhere; plain http only back to this machine (native and CLI clients). No fragments, no credentials. */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2000 || raw.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

function noStore(c: Context) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function oauthError(c: Context, status: 400 | 401 | 429, error: string, description: string) {
  noStore(c);
  return c.json({ error, error_description: description }, status);
}

/** Parameters from a form body (the OAuth default) or a JSON body. */
async function bodyParams(c: Context): Promise<Params> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const b = await c.req.json<unknown>().catch(() => null);
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Params) : {};
  }
  const b = await c.req.parseBody().catch(() => ({}));
  const out: Params = {};
  for (const [k, v] of Object.entries(b)) if (typeof v === 'string') out[k] = v;
  return out;
}

interface Client {
  id: string;
  name: string;
  redirect_uris: string[];
}

async function getClient(db: D1Database, id: string | undefined): Promise<Client | null> {
  if (!id || id.length > 100) return null;
  const row = await db.prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?').bind(id).first<{ id: string; name: string; redirect_uris: string }>();
  if (!row) return null;
  let uris: string[] = [];
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {
    /* a broken row has no redirect URIs, so it can never be used */
  }
  return { id: row.id, name: row.name, redirect_uris: Array.isArray(uris) ? uris.map(String) : [] };
}

/** The resource indicator (RFC 8707): the MCP endpoint, or this server as a whole. */
function resourceOk(origin: string, resource: string): boolean {
  const r = resource.replace(/\/+$/, '');
  return r === mcpResource(origin) || r === origin;
}

/** Sites this owner may hand to an agent, the same rules a token's site access follows. */
async function ownerSites(db: D1Database, env: Env, ownerId: string): Promise<{ id: string; name: string; domain: string }[]> {
  const probe = { id: 'probe', owner_id: ownerId, name: '', prefix: '', scopes: ['read' as const], site_ids: null, created_at: 0, last_used_at: null, revoked_at: null };
  const access = await tokenSiteAccess(db, env, probe);
  const res = await db
    .prepare(`SELECT s.id, s.name, s.domain FROM sites s WHERE ${access.sql} ORDER BY s.created_at`)
    .bind(...access.params)
    .all<{ id: string; name: string; domain: string }>();
  return res.results;
}

// ---------------------------------------------------------------- the authorization request

export interface AuthRequest {
  client: Client;
  redirectUri: string;
  /** False when the client left redirect_uri out (allowed when it registered exactly one). */
  redirectUriGiven: boolean;
  codeChallenge: string;
  state: string | null;
  scopes: Scope[];
  resource: string | null;
}

/**
 * Checks an authorization request. Errors that can't be trusted to go back to the client (unknown client, redirect URI
 * that isn't registered) come back without a redirect and are shown to the person instead; the rest go to the client.
 */
export async function checkAuthRequest(
  db: D1Database,
  origin: string,
  p: Params,
): Promise<{ ok: true; req: AuthRequest } | { ok: false; error: string; description: string; redirect?: string }> {
  const client = await getClient(db, str(p.client_id));
  if (!client) return { ok: false, error: 'invalid_client', description: 'This app is not registered with DataMonster. Start the connection again from the app.' };
  const given = str(p.redirect_uri);
  const redirectUri = given ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'The redirect address does not match the one this app registered.' };
  }
  const state = str(p.state) ?? null;
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state !== null) u.searchParams.set('state', state);
    u.searchParams.set('iss', origin);
    return { ok: false as const, error, description, redirect: u.toString() };
  };
  if (state !== null && state.length > 1000) return back('invalid_request', 'state is too long');
  if (str(p.response_type) !== 'code') return back('unsupported_response_type', 'only response_type=code is supported');
  const challenge = str(p.code_challenge);
  if (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back('invalid_request', 'PKCE is required: send code_challenge');
  if (str(p.code_challenge_method) !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
  const resource = str(p.resource) || null;
  if (resource && !resourceOk(origin, resource)) return back('invalid_target', `resource must be ${mcpResource(origin)}`);
  // Only read and write exist. Read is always included; admin or anything unknown is never granted.
  const scopes = cleanScopes(str(p.scope) ?? 'read');
  return { ok: true, req: { client, redirectUri, redirectUriGiven: given !== undefined, codeChallenge: challenge, state, scopes, resource } };
}

function authParams(p: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']) {
    const v = str(p[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- CSRF for the consent POST

/** Bound to the signed-in owner and the client, signed with the session secret, valid for half an hour. */
export async function consentCsrf(env: Env, ownerId: string, clientId: string, now = Date.now()) {
  return signToken(env.SESSION_SECRET, `oauth-consent|${ownerId}|${clientId}|${now + CSRF_TTL_MS}`);
}

async function csrfOk(env: Env, token: unknown, ownerId: string, clientId: string, now = Date.now()) {
  if (typeof token !== 'string' || !env.SESSION_SECRET) return false;
  const value = await verifyToken(env.SESSION_SECRET, token);
  if (!value) return false;
  const [kind, owner, client, exp] = value.split('|');
  return kind === 'oauth-consent' && owner === ownerId && client === clientId && Number(exp) > now;
}

// ---------------------------------------------------------------- tokens

async function issueRefresh(db: D1Database, agentTokenId: string, clientId: string, now: number, secret = REFRESH_PREFIX + randomId(32)) {
  await db
    .prepare('INSERT INTO oauth_refresh_tokens (token_hash, agent_token_id, client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(secret), agentTokenId, clientId, now, now + REFRESH_TTL_MS)
    .run();
  return secret;
}

/** Ends a connection: its access secret and every refresh token it has. */
export async function revokeConnection(db: D1Database, agentTokenId: string, now = Date.now()) {
  await db.batch([
    db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now, agentTokenId),
    db.prepare('UPDATE oauth_refresh_tokens SET used_at = COALESCE(used_at, ?) WHERE agent_token_id = ?').bind(now, agentTokenId),
  ]);
}

function tokenResponse(c: Context, access: string, refresh: string, scopes: Scope[]) {
  noStore(c);
  return c.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(' ') });
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  owner_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  site_ids: string | null;
  resource: string | null;
  expires_at: number;
  used_at: number | null;
  agent_token_id: string | null;
}

async function exchangeCode(c: Context<AppEnv>, p: Params, clientId: string, now: number) {
  const db = c.env.DB;
  const code = str(p.code);
  if (!code) return oauthError(c, 400, 'invalid_request', 'code is required');
  const hash = await sha256Hex(code);
  const row = await db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(hash).first<CodeRow>();
  if (!row) return oauthError(c, 400, 'invalid_grant', 'unknown authorization code');
  // Everything is checked before the code is used up, so someone who only saw the code can neither spend it nor end the
  // connection it made.
  if (row.client_id !== clientId) return oauthError(c, 400, 'invalid_grant', 'code was issued to another client');
  const redirect = str(p.redirect_uri);
  if (redirect !== undefined ? redirect !== row.redirect_uri : !(await singleRedirect(db, clientId, row.redirect_uri))) {
    return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
  }
  const verifier = str(p.code_verifier);
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(c, 400, 'invalid_grant', 'code_verifier is missing or malformed');
  if (!sameString(await pkceChallenge(verifier), row.code_challenge)) return oauthError(c, 400, 'invalid_grant', 'code_verifier does not match');
  const resource = str(p.resource);
  if (resource && !resourceOk(originOf(c), resource)) return oauthError(c, 400, 'invalid_target', `resource must be ${mcpResource(originOf(c))}`);

  const client = await getClient(db, clientId);
  if (!client) return oauthError(c, 401, 'invalid_client', 'unknown client');
  // Single use. A code presented twice, with its verifier, was probably stolen: the connection it created is revoked.
  const claimed = await db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').bind(now, hash).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const used = await db.prepare('SELECT agent_token_id FROM oauth_codes WHERE code_hash = ?').bind(hash).first<{ agent_token_id: string | null }>();
    if (used?.agent_token_id) await revokeConnection(db, used.agent_token_id, now);
    return oauthError(c, 400, 'invalid_grant', 'authorization code already used');
  }
  if (row.expires_at <= now) return oauthError(c, 400, 'invalid_grant', 'authorization code expired');
  const { token, secret } = await createToken(
    db,
    row.owner_id,
    { name: client.name, scopes: row.scopes, siteIds: row.site_ids ? row.site_ids.split(',') : null, expiresAt: now + ACCESS_TTL_MS, oauthClientId: client.id },
    now,
  );
  await db.prepare('UPDATE oauth_codes SET agent_token_id = ? WHERE code_hash = ?').bind(token.id, hash).run();
  const refresh = await issueRefresh(db, token.id, client.id, now);
  return tokenResponse(c, secret, refresh, token.scopes);
}

async function singleRedirect(db: D1Database, clientId: string, uri: string) {
  const client = await getClient(db, clientId);
  return !!client && client.redirect_uris.length === 1 && client.redirect_uris[0] === uri;
}

interface RefreshRow {
  successor_hash: string | null;
  token_hash: string;
  agent_token_id: string;
  client_id: string;
  expires_at: number;
  used_at: number | null;
  scopes: string;
  token_revoked: number | null;
}

async function refreshGrant(c: Context<AppEnv>, p: Params, clientId: string, now: number) {
  const db = c.env.DB;
  const refresh = str(p.refresh_token);
  if (!refresh) return oauthError(c, 400, 'invalid_request', 'refresh_token is required');
  const hash = await sha256Hex(refresh);
  const row = await db
    .prepare(
      'SELECT r.*, t.scopes AS scopes, t.revoked_at AS token_revoked FROM oauth_refresh_tokens r JOIN agent_tokens t ON t.id = r.agent_token_id WHERE r.token_hash = ?',
    )
    .bind(hash)
    .first<RefreshRow>();
  if (!row || row.client_id !== clientId) return oauthError(c, 400, 'invalid_grant', 'unknown refresh token');
  if (row.token_revoked) return oauthError(c, 400, 'invalid_grant', 'this connection was revoked');
  const secret = TOKEN_PREFIX + await sha256Hex(await signToken(c.env.SESSION_SECRET, `access:${refresh}`));
  const nextSecret = REFRESH_PREFIX + await sha256Hex(await signToken(c.env.SESSION_SECRET, `refresh:${refresh}`));
  if (row.used_at && now - row.used_at <= 30_000 && row.successor_hash === await sha256Hex(nextSecret)) {
    const current = await db.prepare('SELECT token_hash FROM agent_tokens WHERE id = ?').bind(row.agent_token_id).first<{ token_hash: string }>();
    if (current?.token_hash === await sha256Hex(secret)) return tokenResponse(c, secret, nextSecret, cleanScopes(row.scopes));
  }
  if (row.expires_at <= now) return oauthError(c, 400, 'invalid_grant', 'refresh token expired');
  const granted = cleanScopes(row.scopes);
  const asked = str(p.scope);
  if (asked && asked.split(/\s+/).filter(Boolean).some((s) => !(granted as string[]).includes(s))) {
    return oauthError(c, 400, 'invalid_scope', 'a refresh cannot add scopes the owner did not grant');
  }
  if (row.used_at !== null) {
    await revokeConnection(db, row.agent_token_id, now);
    return oauthError(c, 400, 'invalid_grant', 'refresh token already used; the connection has been revoked');
  }
  // D1 batches are transactional: concurrent retries see the complete successor pair or no rotation.
  const nextHash = await sha256Hex(nextSecret);
  const rotated = await db.batch([
    db.prepare(`INSERT INTO oauth_refresh_tokens (token_hash, agent_token_id, client_id, created_at, expires_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE token_hash = ? AND used_at IS NULL)`)
      .bind(nextHash, row.agent_token_id, clientId, now, now + REFRESH_TTL_MS, hash),
    db.prepare(`UPDATE agent_tokens SET token_hash = ?, prefix = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE token_hash = ? AND used_at IS NULL)`)
      .bind(await sha256Hex(secret), secret.slice(0, 10), now + ACCESS_TTL_MS, row.agent_token_id, hash),
    db.prepare('UPDATE oauth_refresh_tokens SET used_at = ?, successor_hash = ? WHERE token_hash = ? AND used_at IS NULL')
      .bind(now, nextHash, hash),
  ]);
  if ((rotated[2].meta?.changes ?? 0) !== 1) return refreshGrant(c, p, clientId, now);
  if ((rotated[1].meta?.changes ?? 0) !== 1) return oauthError(c, 400, 'invalid_grant', 'this connection was revoked');
  return tokenResponse(c, secret, nextSecret, granted);
}

/** client_id from the body, or from HTTP Basic for clients that send it there anyway (any secret is ignored). */
function clientIdFrom(c: Context, p: Params): string | undefined {
  const id = str(p.client_id);
  if (id) return id;
  const m = /^Basic\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m) return undefined;
  try {
    return decodeURIComponent(atob(m[1]).split(':')[0] ?? '') || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- routes

export function mountOAuth(app: Hono<AppEnv>) {
  const open = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'], maxAge: 86400 });
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*', '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/*', '/oauth/token', '/oauth/register', '/oauth/revoke']) {
    app.use(p, open);
  }

  // Discovery. The path-suffixed forms are what RFC 9728 and RFC 8414 clients try first.
  const prm = (c: Context<AppEnv>) => c.json(protectedResourceMetadata(originOf(c)));
  const asm = (c: Context<AppEnv>) => c.json(authorizationServerMetadata(originOf(c)));
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/api/agent/mcp', prm);
  app.get('/.well-known/oauth-authorization-server', asm);
  app.get('/.well-known/oauth-authorization-server/api/agent/mcp', asm);

  // Dynamic client registration. Public clients only; nothing secret is issued.
  app.post('/oauth/register', async (c) => {
    const b = await c.req.json<Json>().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return oauthError(c, 400, 'invalid_client_metadata', 'send the client metadata as a JSON object');
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uris is required');
    if (uris.length > MAX_REDIRECT_URIS) return oauthError(c, 400, 'invalid_redirect_uri', `at most ${MAX_REDIRECT_URIS} redirect_uris`);
    const bad = uris.find((u) => !validRedirectUri(u));
    if (bad !== undefined) return oauthError(c, 400, 'invalid_redirect_uri', 'redirect URIs must be https, or http://localhost or http://127.0.0.1, without a fragment');
    const grants = Array.isArray(b.grant_types) ? b.grant_types.map(String) : ['authorization_code'];
    if (!grants.includes('authorization_code')) return oauthError(c, 400, 'invalid_client_metadata', 'grant_types must include authorization_code');
    if (Array.isArray(b.response_types) && !b.response_types.map(String).includes('code')) {
      return oauthError(c, 400, 'invalid_client_metadata', 'response_types must include code');
    }
    const rawName = typeof b.client_name === 'string' ? b.client_name : '';
    // Shown on the consent screen: printable text only, short.
    const name = rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'MCP client';

    const now = Date.now();
    const ip = await sha256Hex(c.req.header('cf-connecting-ip') ?? 'unknown');
    const [mine, all] = await c.env.DB.batch([
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE created_ip = ? AND created_at > ?').bind(ip, now - 3_600_000),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE created_at > ?').bind(now - 3_600_000),
    ]);
    const count = (r: D1Result) => (r.results[0] as { n: number } | undefined)?.n ?? 0;
    if (count(mine) >= MAX_REGISTRATIONS_PER_IP_HOUR || count(all) >= MAX_REGISTRATIONS_HOUR) {
      return oauthError(c, 429, 'temporarily_unavailable', 'too many client registrations, try again later');
    }
    const id = 'dmc_' + randomId(16);
    const unique = [...new Set(uris as string[])];
    await c.env.DB.batch([
      // Registrations that never led to a connection are dropped after a day.
      c.env.DB.prepare(
        'DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT oauth_client_id FROM agent_tokens WHERE oauth_client_id IS NOT NULL)',
      ).bind(now - 86_400_000),
      c.env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now - 86_400_000),
      c.env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at, created_ip) VALUES (?, ?, ?, ?, ?)').bind(id, name, JSON.stringify(unique), now, ip),
    ]);
    noStore(c);
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: name,
        redirect_uris: unique,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    );
  });

  // The authorization endpoint checks the request, then hands it to the dashboard's consent screen, which signs the
  // owner in first if needed.
  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    const checked = await checkAuthRequest(c.env.DB, originOf(c), q);
    if (!checked.ok) {
      if (checked.redirect) return c.redirect(checked.redirect, 302);
      noStore(c);
      return c.text(`DataMonster could not start this connection: ${checked.description}`, 400);
    }
    return c.redirect(`/oauth/consent?${new URLSearchParams(authParams(q))}`, 302);
  });

  // Hosted sign-in goes through Google and lands on "/"; this brings the owner back to the consent screen instead.
  app.get('/oauth/login', (c) => {
    const back = c.req.query('return') ?? '';
    if (!/^\/oauth\/consent\?[^\\]*$/.test(back)) return c.redirect('/', 302);
    if (!isHosted(c.env)) return c.redirect(back, 302);
    const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
    c.header('Set-Cookie', `${RETURN_COOKIE}=${encodeURIComponent(back)}; Path=/api/auth/google; Max-Age=600; HttpOnly; SameSite=Lax${secure}`);
    return c.redirect('/api/auth/google', 302);
  });
  app.use('/api/auth/google/callback', async (c, next) => {
    const raw = getCookie(c, RETURN_COOKIE);
    await next();
    if (!raw) return;
    c.res.headers.append('Set-Cookie', `${RETURN_COOKIE}=; Path=/api/auth/google; Max-Age=0; HttpOnly; SameSite=Lax`);
    const back = raw; // getCookie has already decoded it
    const loc = c.res.headers.get('location');
    // Only a successful sign-in (redirect to the app's home) is sent on, and only to the consent screen.
    if (c.res.status === 302 && /^\/(billing)?(\?signup=1)?$/.test(loc ?? '') && /^\/oauth\/consent\?[^\\]*$/.test(back)) c.res.headers.set('Location', back);
  });

  // The consent screen's data, for the signed-in owner.
  app.use('/api/oauth/*', requireUser);
  app.get('/api/oauth/consent', async (c) => {
    const checked = await checkAuthRequest(c.env.DB, originOf(c), c.req.query());
    if (!checked.ok) return c.json({ error: checked.description, redirect: checked.redirect ?? null }, 400);
    const { req } = checked;
    const ownerId = ownerIdFor(c.env, c.get('user').id);
    return c.json({
      client: { id: req.client.id, name: req.client.name, redirect_host: new URL(req.redirectUri).host },
      scopes: req.scopes,
      scope_note: "Omitting site_ids or sending null grants access to all current and future sites. Write access requires explicit consent.",
      sites: await ownerSites(c.env.DB, c.env, ownerId),
      account: c.get('user').email,
      csrf: await consentCsrf(c.env, ownerId, req.client.id),
    });
  });

  // Allow or Deny. JSON only (a cross-site form can't send it) and a CSRF token bound to this owner and client.
  app.post('/api/oauth/consent', async (c) => {
    if (!(c.req.header('content-type') ?? '').includes('application/json')) return c.json({ error: 'send JSON' }, 415);
    const b = await c.req.json<Json>().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return c.json({ error: 'body must be a JSON object' }, 400);
    const origin = originOf(c);
    const checked = await checkAuthRequest(c.env.DB, origin, b);
    if (!checked.ok) return c.json({ error: checked.description, redirect: checked.redirect ?? null }, 400);
    const { req } = checked;
    const ownerId = ownerIdFor(c.env, c.get('user').id);
    if (!(await csrfOk(c.env, b.csrf, ownerId, req.client.id))) return c.json({ error: 'This page expired. Reload it and try again.' }, 403);

    const back = new URL(req.redirectUri);
    if (req.state !== null) back.searchParams.set('state', req.state);
    back.searchParams.set('iss', origin);
    if (b.allow !== true) {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', 'The owner declined the connection.');
      return c.json({ redirect: back.toString() });
    }

    if ((ownerId !== 'admin' && !allowsPerAccount(ownerId)) || (await tokensUsedUp(c.env.DB, ownerId))) return c.json({ error: 'That is enough new connections for now. Try again tomorrow.' }, 429);
    // Only what was asked for, narrowed by the owner's choices. Read is always part of it.
    const chosen = Array.isArray(b.scopes) ? b.scopes.map(String) : [];
    const scopes = req.scopes.filter((s) => s === 'read' || chosen.includes(s));
    let siteIds: string[] | null = null;
    if (b.site_ids !== null && b.site_ids !== undefined) {
      if (!Array.isArray(b.site_ids) || !b.site_ids.length) return c.json({ error: 'Pick at least one site, or allow every site.' }, 400);
      const own = new Set((await ownerSites(c.env.DB, c.env, ownerId)).map((s) => s.id));
      siteIds = [...new Set(b.site_ids.map(String))];
      if (siteIds.some((id) => !own.has(id))) return c.json({ error: 'You can only grant access to your own sites.' }, 400);
    }

    const code = randomId(32);
    const now = Date.now();
    await c.env.DB.prepare(
      'INSERT INTO oauth_codes (code_hash, client_id, owner_id, redirect_uri, code_challenge, scopes, site_ids, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(await sha256Hex(code), req.client.id, ownerId, req.redirectUri, req.codeChallenge, scopes.join(' '), siteIds?.join(',') ?? null, req.resource, now, now + CODE_TTL_MS)
      .run();
    back.searchParams.set('code', code);
    return c.json({ redirect: back.toString() });
  });

  app.post('/oauth/token', async (c) => {
    const p = await bodyParams(c);
    const clientId = clientIdFrom(c, p);
    if (!clientId || !(await getClient(c.env.DB, clientId))) return oauthError(c, 401, 'invalid_client', 'unknown client_id');
    const now = Date.now();
    const grant = str(p.grant_type);
    if (grant === 'authorization_code') return exchangeCode(c, p, clientId, now);
    if (grant === 'refresh_token') return refreshGrant(c, p, clientId, now);
    return oauthError(c, 400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  });

  // RFC 7009. Revoking either the access token or a refresh token ends the whole connection. Always 200.
  app.post('/oauth/revoke', async (c) => {
    const p = await bodyParams(c);
    const token = str(p.token);
    const clientId = clientIdFrom(c, p);
    noStore(c);
    if (!token) return oauthError(c, 400, 'invalid_request', 'token is required');
    const hash = await sha256Hex(token);
    const db = c.env.DB;
    const row = token.startsWith(REFRESH_PREFIX)
      ? await db.prepare('SELECT agent_token_id AS id, client_id FROM oauth_refresh_tokens WHERE token_hash = ?').bind(hash).first<{ id: string; client_id: string }>()
      : await db
          .prepare('SELECT id, oauth_client_id AS client_id FROM agent_tokens WHERE token_hash = ? AND oauth_client_id IS NOT NULL')
          .bind(hash)
          .first<{ id: string; client_id: string }>();
    if (row && (!clientId || clientId === row.client_id)) await revokeConnection(db, row.id);
    return c.body(null, 200);
  });
}

/** For tests and the MCP 401: the header that points a client at the discovery document. */
export function wwwAuthenticate(origin: string) {
  return `Bearer realm="datamonster", resource_metadata="${resourceMetadataUrl(origin)}"`;
}
