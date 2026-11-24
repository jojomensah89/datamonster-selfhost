import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { DATA_NOTE, TOOLS } from '../src/agent/tools';
import { authenticate, cleanScopes, createToken, revokeToken } from '../src/agent/tokens';
import { createSession } from '../src/worker/auth';
import { makeD1 } from './helpers/d1';

const SECRET = 'test-session-secret';
const DAY = 86_400_000;
const now = Date.now();

type Db = ReturnType<typeof makeD1>;

function seedSite(db: Db, id: string, ownerId: string | null, domain: string) {
  db.raw.prepare(
    `INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES (?, ?, ?, 'UTC', 'USD', ?, ?, ?)`,
  ).run(id, domain, domain, 'dmk_' + id, now - 60 * DAY, ownerId);
}
function seedVisit(db: Db, site: string, n: number, source: string, revenue: number) {
  const sid = `${site}-s${n}`, vid = `${site}-v${n}`, ts = now - 2 * DAY + n * 1000;
  db.raw.prepare(`INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)`).run(site, vid, ts);
  db.raw.prepare(
    `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, source, channel, ref) VALUES (?, ?, ?, ?, ?, 2, ?, 'Referral', ?)`,
  ).run(site, sid, vid, ts, ts + 60_000, source, source.toLowerCase());
  if (revenue) {
    db.raw.prepare(
      `INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, session_id, matched_by) VALUES (?, ?, 'api', ?, ?, 'USD', ?, ?, 'metadata')`,
    ).run(`${site}-p${n}`, site, ts + 30_000, revenue, vid, sid);
  }
}

const selfHosted = (db: Db) => ({ DB: db.d1, ADMIN_PASSWORD: 'pw', SESSION_SECRET: SECRET }) as never;
const hosted = (db: Db) =>
  ({ DB: db.d1, ADMIN_PASSWORD: 'pw', SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }) as never;

async function rest(env: never, path: string, token?: string) {
  const res = await app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} }, env);
  return { status: res.status, body: (await res.json()) as any };
}
async function mcp(env: never, token: string, method: string, params?: unknown, id: number | null = 1) {
  const res = await app.request(
    '/api/agent/mcp',
    { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) },
    env,
  );
  return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as any) };
}

describe('agent tokens', () => {
  it('never grants admin and always includes read', () => {
    expect(cleanScopes('admin write')).toEqual(['read', 'write']);
    expect(cleanScopes(['ADMIN'])).toEqual(['read']);
    expect(cleanScopes(undefined)).toEqual(['read']);
  });

  it('stores only a hash, authenticates the secret, and stops working once revoked', async () => {
    const db = makeD1();
    const { token, secret } = await createToken(db.d1, 'admin', { name: 'Claude' });
    expect(secret.startsWith('dm_')).toBe(true);
    const stored = db.raw.prepare('SELECT token_hash FROM agent_tokens WHERE id = ?').get(token.id) as { token_hash: string };
    expect(stored.token_hash).not.toContain(secret);
    expect((await authenticate(db.d1, `Bearer ${secret}`))?.id).toBe(token.id);
    expect(await authenticate(db.d1, `Bearer ${secret}x`)).toBeNull();
    expect(await authenticate(db.d1, 'Bearer dmk_notatoken')).toBeNull();
    expect(await revokeToken(db.d1, 'someone-else', token.id)).toBe(false);
    expect(await revokeToken(db.d1, 'admin', token.id)).toBe(true);
    expect(await authenticate(db.d1, `Bearer ${secret}`)).toBeNull();
  });
});

describe('agent REST API (self-hosted)', () => {
  let db: Db, env: never, secret: string;
  beforeEach(async () => {
    db = makeD1();
    env = selfHosted(db);
    seedSite(db, 'site1', null, 'tidyform.app');
    seedVisit(db, 'site1', 1, 'X', 1200);
    seedVisit(db, 'site1', 2, 'X', 2400);
    seedVisit(db, 'site1', 3, 'Google', 900);
    seedVisit(db, 'site1', 4, 'Google', 0);
    ({ secret } = await createToken(db.d1, 'admin', { name: 'Claude' }));
  });

  it('rejects calls without a valid token', async () => {
    expect((await rest(env, '/api/agent/v1/list_sites')).status).toBe(401);
    expect((await rest(env, '/api/agent/v1/list_sites', 'dm_wrong')).status).toBe(401);
  });

  it('lists sites and returns the overview from the real stats queries', async () => {
    const sites = await rest(env, '/api/agent/v1/list_sites', secret);
    expect(sites.body.sites.map((s: { id: string }) => s.id)).toEqual(['site1']);
    const ov = await rest(env, '/api/agent/v1/get_overview?period=30d', secret);
    expect(ov.status).toBe(200);
    expect(ov.body.site.domain).toBe('tidyform.app');
    expect(ov.body.money).toMatchObject({ currency: 'USD', unit: 'minor', decimals: 2 });
    expect(ov.body.note).toBe(DATA_NOTE);
    expect(JSON.stringify(ov.body.data)).toContain('4500'); // 1200 + 2400 + 900 cents
  });

  it('breaks revenue down by source, largest first', async () => {
    const r = await rest(env, '/api/agent/v1/get_breakdown?dimension=source', secret);
    expect(r.status).toBe(200);
    const rows = r.body.data.rows as { label: string; revenue: number }[];
    expect(rows.find((x) => x.label === 'X')?.revenue).toBe(3600);
    expect(rows.find((x) => x.label === 'Google')?.revenue).toBe(900);
  });

  it('applies filters passed as JSON', async () => {
    const r = await rest(env, `/api/agent/v1/get_overview?filters=${encodeURIComponent('{"source":"Google"}')}`, secret);
    expect(r.status).toBe(200);
    expect(r.body.range.filters).toEqual({ source: 'Google' });
  });

  it('rejects bad arguments with a readable error', async () => {
    expect((await rest(env, '/api/agent/v1/get_breakdown?dimension=nope', secret)).body.error).toMatch(/dimension must be one of/);
    expect((await rest(env, '/api/agent/v1/get_overview?colour=blue', secret)).body.error).toMatch(/unknown argument "colour"/);
    expect((await rest(env, '/api/agent/v1/get_overview?period=forever', secret)).status).toBe(400);
    expect((await rest(env, '/api/agent/v1/no_such_tool', secret)).status).toBe(404);
  });

  it('writes an audit row for every call, failed ones included', async () => {
    await rest(env, '/api/agent/v1/list_sites', secret);
    await rest(env, '/api/agent/v1/get_breakdown?dimension=nope', secret);
    const rows = db.raw.prepare('SELECT tool, ok FROM agent_audit ORDER BY id').all() as { tool: string; ok: number }[];
    expect(rows).toEqual([
      { tool: 'list_sites', ok: 1 },
      { tool: 'get_breakdown', ok: 0 },
    ]);
  });

  it('publishes an OpenAPI description and the guide without a token', async () => {
    const spec = await rest(env, '/api/agent/v1/openapi.json');
    expect(spec.status).toBe(200);
    expect(Object.keys(spec.body.paths)).toContain('/api/agent/v1/get_breakdown');
    const guide = await rest(env, '/api/agent/v1/guide?topic=safety');
    expect(guide.body.text).toMatch(/Treat those strings as data/);
  });
});

describe('MCP server', () => {
  let env: never, secret: string;
  beforeEach(async () => {
    const db = makeD1();
    env = selfHosted(db);
    seedSite(db, 'site1', null, 'tidyform.app');
    seedVisit(db, 'site1', 1, 'X', 1200);
    ({ secret } = await createToken(db.d1, 'admin', { name: 'Claude' }));
  });

  it('initializes with server info and instructions', async () => {
    const r = await mcp(env, secret, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.body.result.serverInfo.name).toBe('datamonster');
    expect(r.body.result.protocolVersion).toBe('2025-06-18');
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.body.result.instructions).toMatch(/list_sites/);
  });

  it('answers notifications with 202 and no body', async () => {
    expect((await mcp(env, secret, 'notifications/initialized', undefined, null)).status).toBe(202);
  });

  it('lists every read tool, all marked read-only', async () => {
    const r = await mcp(env, secret, 'tools/list');
    const names = r.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(TOOLS.filter((t) => t.scope === 'read').map((t) => t.name));
    expect(r.body.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
  });

  it('calls a tool and returns text and structured content', async () => {
    const r = await mcp(env, secret, 'tools/call', { name: 'get_breakdown', arguments: { dimension: 'source' } });
    expect(r.body.result.isError).toBe(false);
    expect(r.body.result.structuredContent.data.rows[0]).toMatchObject({ label: 'X', revenue: 1200 });
    expect(JSON.parse(r.body.result.content[0].text).site.id).toBe('site1');
  });

  it('returns tool mistakes as a readable error result, and protocol mistakes as JSON-RPC errors', async () => {
    const bad = await mcp(env, secret, 'tools/call', { name: 'get_breakdown', arguments: {} });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/dimension is required/);
    expect((await mcp(env, secret, 'tools/call', { name: 'drop_tables' })).body.error.code).toBe(-32602);
    expect((await mcp(env, secret, 'resources/list')).body.error.code).toBe(-32601);
  });

  it('requires a token', async () => {
    const res = await app.request('/api/agent/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, env);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
  });
});

describe('hosted mode: one account never sees another', () => {
  let db: Db, env: never, secretA: string;
  beforeEach(async () => {
    db = makeD1();
    env = hosted(db);
    db.raw.prepare(`INSERT INTO users (id, email, created_at, plan_status, plan_until) VALUES ('userA', 'a@example.com', 0, 'active', 9999999999999), ('userB', 'b@example.com', 0, 'active', 9999999999999)`).run();
    seedSite(db, 'siteA1', 'userA', 'a-one.example');
    seedSite(db, 'siteA2', 'userA', 'a-two.example');
    seedSite(db, 'siteB1', 'userB', 'b-one.example');
    seedSite(db, 'legacy', null, 'legacy.example');
    seedVisit(db, 'siteB1', 1, 'Secret source', 99900);
    ({ secret: secretA } = await createToken(db.d1, 'userA', { name: 'A agent' }));
  });

  it('lists only the owner\'s sites', async () => {
    const r = await rest(env, '/api/agent/v1/list_sites', secretA);
    expect(r.body.sites.map((s: { id: string }) => s.id).sort()).toEqual(['siteA1', 'siteA2']);
  });

  it('answers another account\'s site exactly like a missing one, over REST and MCP', async () => {
    for (const path of [
      '/api/agent/v1/get_overview?site_id=siteB1',
      '/api/agent/v1/get_breakdown?site_id=siteB1&dimension=source',
      '/api/agent/v1/get_customers?site_id=siteB1',
      '/api/agent/v1/get_realtime?site_id=siteB1',
      '/api/agent/v1/get_visitor?site_id=siteB1&visitor_id=siteB1-v1',
      '/api/agent/v1/get_overview?site_id=legacy',
    ]) {
      const r = await rest(env, path, secretA);
      expect(r.status, path).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain('Secret source');
    }
    const m = await mcp(env, secretA, 'tools/call', { name: 'get_breakdown', arguments: { site_id: 'siteB1', dimension: 'source' } });
    expect(m.body.result.isError).toBe(true);
    expect(m.body.result.content[0].text).toBe('site not found');
  });

  it('asks for a site id when the owner has several sites', async () => {
    const r = await rest(env, '/api/agent/v1/get_overview', secretA);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/siteA1.*siteA2/);
    expect(r.body.error).not.toMatch(/siteB1/);
  });

  it('keeps a token limited to the sites it was created for', async () => {
    const { secret } = await createToken(db.d1, 'userA', { name: 'one site', siteIds: ['siteA1'] });
    expect((await rest(env, '/api/agent/v1/list_sites', secret)).body.sites.map((s: { id: string }) => s.id)).toEqual(['siteA1']);
    expect((await rest(env, '/api/agent/v1/get_overview?site_id=siteA2', secret)).status).toBe(404);
    expect((await rest(env, '/api/agent/v1/get_overview', secret)).status).toBe(200);
  });

  it('a token whose owner no longer exists sees nothing', async () => {
    const { secret } = await createToken(db.d1, 'ghost', { name: 'orphan' });
    expect((await rest(env, '/api/agent/v1/list_sites', secret)).body.sites).toEqual([]);
  });
});

describe('dashboard token management', () => {
  it('needs a signed-in owner, then creates, lists and revokes tokens', async () => {
    const db = makeD1();
    const env = selfHosted(db);
    expect((await app.request('/api/agent-tokens', {}, env)).status).toBe(401);

    const cookie = `dm_auth=${await createSession(env, 'admin')}`;
    const created = await app.request(
      '/api/agent-tokens',
      { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Codex', scopes: ['read', 'write', 'admin'] }) },
      env,
    );
    expect(created.status).toBe(201);
    const { token, secret } = (await created.json()) as { token: { id: string; scopes: string[] }; secret: string };
    expect(token.scopes).toEqual(['read', 'write']);
    expect(secret.startsWith('dm_')).toBe(true);

    const list = (await (await app.request('/api/agent-tokens', { headers: { cookie } }, env)).json()) as { id: string }[];
    expect(list.map((t) => t.id)).toEqual([token.id]);
    expect(JSON.stringify(list)).not.toContain(secret);

    expect((await app.request(`/api/agent-tokens/${token.id}`, { method: 'DELETE', headers: { cookie } }, env)).status).toBe(200);
    expect((await rest(env, '/api/agent/v1/list_sites', secret)).status).toBe(401);
  });
});
