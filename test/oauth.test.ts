import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index';
import { pkceChallenge } from '../src/agent/oauth';
import { authenticate } from '../src/agent/tokens';
import { createSession } from '../src/worker/auth';
import { makeD1 } from './helpers/d1';

const SECRET = 'test-session-secret';
const ORIGIN = 'http://localhost';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a'.repeat(20) + '-._~' + 'Z9'.repeat(12);
const now = Date.now();

type Db = ReturnType<typeof makeD1>;

const selfHosted = (db: Db) => ({ DB: db.d1, ADMIN_PASSWORD: 'pw', SESSION_SECRET: SECRET }) as never;
const hosted = (db: Db) =>
  ({ DB: db.d1, ADMIN_PASSWORD: 'pw', SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }) as never;

const adminCookie = async (env: never) => `dm_auth=${await createSession(env, 'admin')}`;
const userCookie = async (env: never, id: string) => `dm_auth=${await createSession(env, `u:${id}`)}`;

function seedSite(db: Db, id: string, ownerId: string | null) {
  db.raw
    .prepare(`INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES (?, ?, ?, 'UTC', 'USD', ?, ?, ?)`)
    .run(id, id, `${id}.example`, 'dmk_' + id, now - 1000, ownerId);
}

async function json(res: Response) {
  return (await res.json()) as any;
}

async function register(env: never, body: unknown = { client_name: 'Claude', redirect_uris: [REDIRECT] }, ip = '1.2.3.4') {
  const res = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }, env);
  return { status: res.status, body: await json(res) };
}

async function authParams(clientId: string, extra: Record<string, string> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'xyz-state',
    scope: 'read',
    resource: `${ORIGIN}/api/agent/mcp`,
    ...extra,
  };
}

async function consentInfo(env: never, cookie: string, params: Record<string, string>) {
  const res = await app.request(`/api/oauth/consent?${new URLSearchParams(params)}`, { headers: { cookie } }, env);
  return { status: res.status, body: await json(res) };
}

async function consentPost(env: never, cookie: string, body: Record<string, unknown>) {
  const res = await app.request('/api/oauth/consent', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
  return { status: res.status, body: await json(res) };
}

/** Signs in, opens the consent screen and clicks Allow: returns the code from the redirect. */
async function allow(env: never, cookie: string, params: Record<string, string>, choice: Record<string, unknown> = {}) {
  const info = await consentInfo(env, cookie, params);
  expect(info.status).toBe(200);
  const r = await consentPost(env, cookie, { ...params, allow: true, csrf: info.body.csrf, ...choice });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const url = new URL(r.body.redirect);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('xyz-state');
  expect(url.searchParams.get('iss')).toBe(ORIGIN);
  return url.searchParams.get('code')!;
}

async function token(env: never, form: Record<string, string>) {
  const res = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }, env);
  return { status: res.status, body: await json(res), headers: res.headers };
}

const exchange = (env: never, clientId: string, code: string, extra: Record<string, string> = {}) =>
  token(env, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...extra });

async function mcp(env: never, bearer: string, method: string, params?: unknown) {
  const res = await app.request(
    '/api/agent/mcp',
    { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) },
    env,
  );
  return { status: res.status, body: res.status === 200 ? await json(res) : null, headers: res.headers };
}

describe('discovery', () => {
  it('publishes protected resource and authorization server metadata', async () => {
    const env = selfHosted(makeD1());
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/agent/mcp']) {
      const res = await app.request(path, {}, env);
      expect(res.status, path).toBe(200);
      const b = await json(res);
      expect(b.resource).toBe(`${ORIGIN}/api/agent/mcp`);
      expect(b.authorization_servers).toEqual([ORIGIN]);
    }
    const res = await app.request('/.well-known/oauth-authorization-server', {}, env);
    const m = await json(res);
    expect(m.issuer).toBe(ORIGIN);
    expect(m.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.scopes_supported).toEqual(['read', 'write']);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('points an unauthenticated MCP call at the resource metadata', async () => {
    const env = selfHosted(makeD1());
    const r = await mcp(env, 'nothing', 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`Bearer realm="datamonster", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and stores its name and redirect URIs', async () => {
    const db = makeD1();
    const r = await register(selfHosted(db), { client_name: '  Claude\u0000 ', redirect_uris: [REDIRECT, 'http://localhost:33418/callback', 'http://127.0.0.1/cb'] });
    expect(r.status).toBe(201);
    expect(r.body.client_id).toMatch(/^dmc_/);
    expect(r.body.client_name).toBe('Claude');
    expect(r.body.token_endpoint_auth_method).toBe('none');
    expect(r.body.client_secret).toBeUndefined();
    const row = db.raw.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?').get(r.body.client_id) as { name: string; redirect_uris: string };
    expect(row.name).toBe('Claude');
    expect(JSON.parse(row.redirect_uris)).toHaveLength(3);
  });

  it('rejects bad metadata', async () => {
    const env = selfHosted(makeD1());
    const bad = [
      {},
      { redirect_uris: [] },
      { redirect_uris: 'https://a.example/cb' },
      { redirect_uris: ['http://evil.example/cb'] },
      { redirect_uris: ['https://a.example/cb#frag'] },
      { redirect_uris: ['javascript:alert(1)'] },
      { redirect_uris: ['https://user:pw@a.example/cb'] },
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) },
      { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
    ];
    for (const body of bad) expect((await register(env, body)).status, JSON.stringify(body)).toBe(400);
    const notJson = await app.request('/oauth/register', { method: 'POST', body: 'x' }, env);
    expect(notJson.status).toBe(400);
  });

  it('caps registrations per address', async () => {
    const env = selfHosted(makeD1());
    for (let i = 0; i < 20; i++) expect((await register(env, undefined, '9.9.9.9')).status).toBe(201);
    const r = await register(env, undefined, '9.9.9.9');
    expect(r.status).toBe(429);
    expect((await register(env, undefined, '8.8.8.8')).status).toBe(201);
  });
});

describe('authorization code flow (self-hosted)', () => {
  let db: Db, env: never, clientId: string, cookie: string;
  beforeEach(async () => {
    db = makeD1();
    env = selfHosted(db);
    seedSite(db, 'site1', null);
    seedSite(db, 'site2', null);
    clientId = (await register(env)).body.client_id;
    cookie = await adminCookie(env);
  });

  it('authorize sends the owner to the consent screen with the request', async () => {
    const params = await authParams(clientId);
    const res = await app.request(`/oauth/authorize?${new URLSearchParams(params)}`, {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, ORIGIN);
    expect(loc.pathname).toBe('/oauth/consent');
    expect(Object.fromEntries(loc.searchParams)).toEqual(params);
  });

  it('authorize refuses unknown clients and unregistered redirects without redirecting', async () => {
    let res = await app.request(`/oauth/authorize?${new URLSearchParams(await authParams('dmc_nope'))}`, {}, env);
    expect(res.status).toBe(400);
    res = await app.request(`/oauth/authorize?${new URLSearchParams(await authParams(clientId, { redirect_uri: 'https://evil.example/cb' }))}`, {}, env);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('authorize sends protocol errors back to the client', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge: '' }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ];
    for (const [extra, error] of cases) {
      const res = await app.request(`/oauth/authorize?${new URLSearchParams(await authParams(clientId, extra))}`, {}, env);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBe(error);
      expect(loc.searchParams.get('state')).toBe('xyz-state');
    }
  });

  it('issues a working read token with PKCE, and the token respects its scope', async () => {
    const params = await authParams(clientId);
    const code = await allow(env, cookie, params);
    const r = await exchange(env, clientId, code);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body.token_type).toBe('Bearer');
    expect(r.body.access_token).toMatch(/^dm_/);
    expect(r.body.refresh_token).toMatch(/^dmr_/);
    expect(r.body.expires_in).toBe(3600);
    expect(r.body.scope).toBe('read');

    const list = await mcp(env, r.body.access_token, 'tools/list');
    expect(list.status).toBe(200);
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('list_sites');
    expect(names).not.toContain('create_link');
    const write = await mcp(env, r.body.access_token, 'tools/call', { name: 'create_link', arguments: { site_id: 'site1', ref: 'x' } });
    expect(write.body.result.isError).toBe(true);
    expect(write.body.result.content[0].text).toMatch(/write scope/);

    // Stored as an agent token named after the client, with only hashes of the secrets.
    const row = db.raw.prepare('SELECT * FROM agent_tokens').get() as Record<string, unknown>;
    expect(row.name).toBe('Claude');
    expect(row.oauth_client_id).toBe(clientId);
    expect(row.token_hash).not.toBe(r.body.access_token);
    const codes = db.raw.prepare('SELECT code_hash FROM oauth_codes').all() as { code_hash: string }[];
    expect(codes.map((c) => c.code_hash)).not.toContain(code);
    const refresh = db.raw.prepare('SELECT token_hash FROM oauth_refresh_tokens').all() as { token_hash: string }[];
    expect(refresh.map((c) => c.token_hash)).not.toContain(r.body.refresh_token);
  });

  it('grants write only when asked and kept, and limits sites when the owner picks them', async () => {
    const params = await authParams(clientId, { scope: 'read write admin' });
    const info = await consentInfo(env, cookie, params);
    expect(info.body.scopes).toEqual(['read', 'write']);
    expect(info.body.scope_note).toContain('all current and future sites');
    const implicit = await exchange(env, clientId, await allow(env, cookie, params, { site_ids: null }));
    expect(implicit.body.scope).toBe('read');
    expect(info.body.client).toEqual({ id: clientId, name: 'Claude', redirect_host: 'claude.ai' });

    const code = await allow(env, cookie, params, { site_ids: ['site2'], scopes: ['read', 'write'] });
    const r = await exchange(env, clientId, code);
    expect(r.body.scope).toBe('read write');
    const sites = await mcp(env, r.body.access_token, 'tools/call', { name: 'list_sites', arguments: {} });
    expect(sites.body.result.structuredContent.sites.map((s: { id: string }) => s.id)).toEqual(['site2']);
    const write = await mcp(env, r.body.access_token, 'tools/call', { name: 'create_link', arguments: { site_id: 'site1', ref: 'x' } });
    expect(write.body.result.isError).toBe(true);
    expect(write.body.result.content[0].text).toBe('site not found');

    // The owner can untick write.
    const code2 = await allow(env, cookie, params, { scopes: ['read'] });
    expect((await exchange(env, clientId, code2)).body.scope).toBe('read');
  });

  it('rejects a wrong verifier, a wrong redirect, another client and an expired code', async () => {
    const params = await authParams(clientId);
    const other = (await register(env, { client_name: 'Other', redirect_uris: [REDIRECT] })).body.client_id;

    let code = await allow(env, cookie, params);
    let r = await exchange(env, clientId, code, { code_verifier: 'b'.repeat(43) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_grant');

    code = await allow(env, cookie, params);
    r = await exchange(env, clientId, code, { redirect_uri: 'https://claude.ai/other' });
    expect(r.body.error).toBe('invalid_grant');

    code = await allow(env, cookie, params);
    r = await exchange(env, other, code);
    expect(r.body.error).toBe('invalid_grant');

    code = await allow(env, cookie, params);
    db.raw.prepare('UPDATE oauth_codes SET expires_at = ?').run(Date.now() - 1);
    r = await exchange(env, clientId, code);
    expect(r.body.error).toBe('invalid_grant');
    expect(r.body.error_description).toMatch(/expired/);

    r = await exchange(env, clientId, 'not-a-code');
    expect(r.body.error).toBe('invalid_grant');
    r = await exchange(env, 'dmc_unknown', 'x');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_client');
    r = await token(env, { grant_type: 'password', client_id: clientId });
    expect(r.body.error).toBe('unsupported_grant_type');
  });

  it('a code works once; presenting it again revokes what it issued', async () => {
    const code = await allow(env, cookie, await authParams(clientId));
    const first = await exchange(env, clientId, code);
    expect(first.status).toBe(200);
    expect((await mcp(env, first.body.access_token, 'ping')).status).toBe(200);
    const again = await exchange(env, clientId, code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
    expect((await mcp(env, first.body.access_token, 'ping')).status).toBe(401);
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId })).body.error).toBe('invalid_grant');
  });

  it('rotates refresh tokens and revokes the connection when a used one comes back', async () => {
    const first = await exchange(env, clientId, await allow(env, cookie, await authParams(clientId)));
    const second = await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(second.body.access_token).not.toBe(first.body.access_token);
    expect((await mcp(env, second.body.access_token, 'ping')).status).toBe(200);
    // The old access secret is replaced, and still one connection for the Agents page.
    expect((await mcp(env, first.body.access_token, 'ping')).status).toBe(401);
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM agent_tokens').get() as { n: number }).n).toBe(1);

    // Another client can't use it.
    const other = (await register(env, { client_name: 'Other', redirect_uris: [REDIRECT] })).body.client_id;
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: other })).body.error).toBe('invalid_grant');

    const retry = await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(second.body);
    db.raw.prepare('UPDATE oauth_refresh_tokens SET used_at = ? WHERE used_at IS NOT NULL').run(Date.now() - 31000);
    // Outside the retry window the whole family ends.
    const reuse = await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await mcp(env, second.body.access_token, 'ping')).status).toBe(401);
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: clientId })).body.error).toBe('invalid_grant');
  });

  it('a refresh cannot widen the scope', async () => {
    const first = await exchange(env, clientId, await allow(env, cookie, await authParams(clientId)));
    const r = await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId, scope: 'read write' });
    expect(r.body.error).toBe('invalid_scope');
  });

  it('rejects an expired access token, and a refresh brings the connection back', async () => {
    const first = await exchange(env, clientId, await allow(env, cookie, await authParams(clientId)));
    db.raw.prepare('UPDATE agent_tokens SET expires_at = ?').run(Date.now() - 1);
    expect((await mcp(env, first.body.access_token, 'ping')).status).toBe(401);
    expect(await authenticate(db.d1, `Bearer ${first.body.access_token}`)).toBeNull();
    const next = await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId });
    expect((await mcp(env, next.body.access_token, 'ping')).status).toBe(200);
  });

  it('shows the connection on the Agents page and revoking it ends the refresh family', async () => {
    const first = await exchange(env, clientId, await allow(env, cookie, await authParams(clientId)));
    const list = (await json(await app.request('/api/agent-tokens', { headers: { cookie } }, env))) as { id: string; name: string; oauth_client_id: string }[];
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Claude');
    expect(list[0].oauth_client_id).toBe(clientId);
    expect((await app.request(`/api/agent-tokens/${list[0].id}`, { method: 'DELETE', headers: { cookie } }, env)).status).toBe(200);
    expect((await mcp(env, first.body.access_token, 'ping')).status).toBe(401);
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: clientId })).body.error).toBe('invalid_grant');
  });

  it('the revocation endpoint ends the connection', async () => {
    const first = await exchange(env, clientId, await allow(env, cookie, await authParams(clientId)));
    const res = await app.request('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${first.body.refresh_token}&client_id=${clientId}` }, env);
    expect(res.status).toBe(200);
    expect((await mcp(env, first.body.access_token, 'ping')).status).toBe(401);
  });

  it('consent needs a signed-in owner and a valid CSRF token', async () => {
    const params = await authParams(clientId);
    expect((await consentInfo(env, '', params)).status).toBe(401);
    expect((await consentPost(env, '', { ...params, allow: true })).status).toBe(401);

    const info = await consentInfo(env, cookie, params);
    expect((await consentPost(env, cookie, { ...params, allow: true })).status).toBe(403);
    expect((await consentPost(env, cookie, { ...params, allow: true, csrf: info.body.csrf + 'x' })).status).toBe(403);
    // A token for another client doesn't carry over.
    const other = (await register(env, { client_name: 'Other', redirect_uris: [REDIRECT] })).body.client_id;
    expect((await consentPost(env, cookie, { ...(await authParams(other)), allow: true, csrf: info.body.csrf })).status).toBe(403);
    // A form post (what a cross-site page could send) is refused outright.
    const form = await app.request(
      '/api/oauth/consent',
      { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, allow: 'true', csrf: info.body.csrf }).toString() },
      env,
    );
    expect(form.status).toBe(415);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 });
  });

  it('deny returns access_denied to the client', async () => {
    const params = await authParams(clientId);
    const info = await consentInfo(env, cookie, params);
    const r = await consentPost(env, cookie, { ...params, allow: false, csrf: info.body.csrf });
    expect(r.status).toBe(200);
    const url = new URL(r.body.redirect);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz-state');
    expect(url.searchParams.get('code')).toBeNull();
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 });
  });

  it('serves the consent screen as an app page', async () => {
    const assets = { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) };
    const res = await app.request('/oauth/consent?client_id=x', {}, { ...(env as object), ASSETS: assets } as never);
    expect(res.status).toBe(200);
  });
});

describe('hosted mode', () => {
  let db: Db, env: never, clientId: string;
  beforeEach(async () => {
    db = makeD1();
    env = hosted(db);
    db.raw.prepare(`INSERT INTO users (id, email, created_at, plan_status, plan_until) VALUES ('userA', 'a@example.com', 0, 'active', 9999999999999), ('userB', 'b@example.com', 0, 'active', 9999999999999)`).run();
    seedSite(db, 'siteA1', 'userA');
    seedSite(db, 'siteA2', 'userA');
    seedSite(db, 'siteB1', 'userB');
    clientId = (await register(env)).body.client_id;
  });

  it('offers and grants only the signed-in user\'s own sites', async () => {
    const cookie = await userCookie(env, 'userA');
    const params = await authParams(clientId);
    const info = await consentInfo(env, cookie, params);
    expect(info.body.sites.map((s: { id: string }) => s.id)).toEqual(['siteA1', 'siteA2']);
    expect(info.body.account).toBe('a@example.com');

    const steal = await consentPost(env, cookie, { ...params, allow: true, csrf: info.body.csrf, site_ids: ['siteB1'] });
    expect(steal.status).toBe(400);
    const mixed = await consentPost(env, cookie, { ...params, allow: true, csrf: info.body.csrf, site_ids: ['siteA1', 'siteB1'] });
    expect(mixed.status).toBe(400);

    const r = await exchange(env, clientId, await allow(env, cookie, params));
    const sites = await mcp(env, r.body.access_token, 'tools/call', { name: 'list_sites', arguments: {} });
    expect(sites.body.result.structuredContent.sites.map((s: { id: string }) => s.id).sort()).toEqual(['siteA1', 'siteA2']);
    const row = db.raw.prepare('SELECT owner_id FROM agent_tokens').get() as { owner_id: string };
    expect(row.owner_id).toBe('userA');
  });

  it('a CSRF token from one user does not work for another', async () => {
    const params = await authParams(clientId);
    const infoA = await consentInfo(env, await userCookie(env, 'userA'), params);
    const r = await consentPost(env, await userCookie(env, 'userB'), { ...params, allow: true, csrf: infoA.body.csrf });
    expect(r.status).toBe(403);
  });

  it('sends a signed-out owner through Google sign-in and back to the consent screen', async () => {
    const back = `/oauth/consent?${new URLSearchParams(await authParams(clientId))}`;
    const res = await app.request(`/oauth/login?return=${encodeURIComponent(back)}`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/api/auth/google');
    expect(res.headers.get('set-cookie')).toMatch(/^dm_oauth_return=.*Path=\/api\/auth\/google.*HttpOnly/);
    // Only the consent screen is an allowed destination.
    const evil = await app.request(`/oauth/login?return=${encodeURIComponent('https://evil.example/')}`, {}, env);
    expect(evil.headers.get('location')).toBe('/');
    // A failed sign-in is not sent on.
    const cb = await app.request('/api/auth/google/callback?state=a', { headers: { cookie: `dm_oauth_return=${encodeURIComponent(back)}` } }, env);
    expect(cb.headers.get('location')).toMatch(/^\/\?login_error=/);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('a successful Google sign-in lands back on the consent screen', async () => {
    const back = `/oauth/consent?${new URLSearchParams(await authParams(clientId))}`;
    db.raw.exec("UPDATE users SET google_sub = 'g-a' WHERE id = 'userA'");
    const claims = { iss: 'https://accounts.google.com', aud: 'id', sub: 'g-a', email: 'a@example.com', email_verified: true };
    const idToken = `x.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.y`;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id_token: idToken }), { headers: { 'content-type': 'application/json' } }));
    const cookie = `dm_oauth=st; dm_oauth_return=${encodeURIComponent(back)}`;
    const cb = await app.request('/api/auth/google/callback?state=st&code=c', { headers: { cookie } }, env);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(back);
    const cookies = cb.headers.getSetCookie().join('\n');
    expect(cookies).toMatch(/dm_auth=/);
    expect(cookies).toMatch(/dm_oauth_return=;/);
  });
});
