import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { TOOLS } from '../src/agent/tools';
import { cleanText, destinationFor, taggedUrl } from '../src/agent/links';
import { createToken } from '../src/agent/tokens';
import { createSession } from '../src/worker/auth';
import { makeD1 } from './helpers/d1';

const SECRET = 'test-session-secret';
const DAY = 86_400_000;
const now = Date.now();
const WRITE_TOOLS = ['enable_online_widget', 'get_online_widget', 'create_link', 'add_annotation', 'add_placement', 'update_placement', 'verify_placement'];

type Db = ReturnType<typeof makeD1>;
type Res = { status: number; body: any };

function seedSite(db: Db, id: string, ownerId: string | null, domain: string) {
  db.raw.prepare(
    `INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES (?, ?, ?, 'UTC', 'USD', ?, ?, ?)`,
  ).run(id, domain, domain, 'dmk_' + id, now - 60 * DAY, ownerId);
}
/** One session from a tagged link (ref may be null), and a payment when revenue > 0. */
function seedVisit(db: Db, site: string, n: number, ref: string | null, revenue: number) {
  const sid = `${site}-s${n}`, vid = `${site}-v${n}`, ts = now - 2 * DAY + n * 1000;
  db.raw.prepare(`INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)`).run(site, vid, ts);
  db.raw.prepare(
    `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, source, channel, ref) VALUES (?, ?, ?, ?, ?, 1, 'X', 'Social', ?)`,
  ).run(site, sid, vid, ts, ts + 60_000, ref);
  if (revenue) {
    db.raw.prepare(
      `INSERT INTO payments (id, site_id, provider, ts, amount, currency, visitor_id, session_id, matched_by) VALUES (?, ?, 'api', ?, ?, 'USD', ?, ?, 'metadata')`,
    ).run(`${site}-p${n}`, site, ts + 30_000, revenue, vid, sid);
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
const auditRows = (db: Db) =>
  db.raw.prepare('SELECT tool, site_id, write, ok FROM agent_audit ORDER BY id').all() as { tool: string; site_id: string | null; write: number; ok: number }[];
const count = (db: Db, table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('link helpers', () => {
  const site = { id: 's', domain: 'tidyform.app' } as never;

  it('keeps destinations on the site\'s own domain', () => {
    expect(destinationFor(site, undefined).toString()).toBe('https://tidyform.app/');
    expect(destinationFor(site, 'pricing').toString()).toBe('https://tidyform.app/pricing');
    expect(destinationFor(site, '/pricing?plan=pro#faq').toString()).toBe('https://tidyform.app/pricing?plan=pro#faq');
    expect(destinationFor(site, 'http://www.tidyform.app/a').toString()).toBe('https://www.tidyform.app/a');
    for (const bad of [
      'https://evil.example/',
      '//evil.example/x',
      'https://tidyform.app.evil.example/',
      'https://user:pw@tidyform.app/',
      'https://tidyform.app:8443/',
      'javascript:alert(1)',
      'data:text/html,hi',
      '/\\evil.example',
      '/pricing?ref=other',
    ]) {
      expect(() => destinationFor(site, bad), bad).toThrow();
    }
  });

  it('adds the ref and keeps the existing query and fragment', () => {
    expect(taggedUrl('https://tidyform.app/', 'ph')).toBe('https://tidyform.app/?ref=ph');
    expect(taggedUrl('https://tidyform.app/p?plan=pro#faq', 'ph')).toBe('https://tidyform.app/p?plan=pro&ref=ph#faq');
  });

  it('strips control and bidi characters and caps the length', () => {
    expect(cleanText('a\u0000b\nc‮d​  e', 100)).toBe('a b c d e');
    expect(cleanText('x'.repeat(300), 200)).toHaveLength(200);
  });
});

describe('write tools (self-hosted)', () => {
  let db: Db, env: never, readSecret: string, writeSecret: string, writeTokenId: string;
  beforeEach(async () => {
    db = makeD1();
    env = selfHosted(db);
    seedSite(db, 'site1', null, 'tidyform.app');
    ({ secret: readSecret } = await createToken(db.d1, 'admin', { name: 'reader' }));
    const w = await createToken(db.d1, 'admin', { name: 'writer', scopes: ['read', 'write'] });
    writeSecret = w.secret;
    writeTokenId = w.token.id;
  });

  it('a read token neither sees nor can call write tools', async () => {
    const list = await mcp(env, readSecret, 'tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    expect(names).toContain('list_links');
    expect(names).toContain('list_annotations');

    const r = await post(env, readSecret, 'create_link', { site_id: 'site1', ref: 'ph-launch' });
    expect(r.status).toBe(403);
    const a = await post(env, readSecret, 'add_annotation', { site_id: 'site1', text: 'Launched' });
    expect(a.status).toBe(403);
    const m = await mcp(env, readSecret, 'tools/call', { name: 'create_link', arguments: { site_id: 'site1', ref: 'ph-launch' } });
    expect(m.result.isError).toBe(true);
    expect(m.result.content[0].text).toMatch(/write scope/);

    expect(count(db, 'tracked_links')).toBe(0);
    expect(count(db, 'annotations')).toBe(0);
    expect(auditRows(db)).toEqual([
      { tool: 'create_link', site_id: 'site1', write: 1, ok: 0 },
      { tool: 'add_annotation', site_id: 'site1', write: 1, ok: 0 },
      { tool: 'create_link', site_id: 'site1', write: 1, ok: 0 },
    ]);
  });

  it('a write token lists write tools as not read-only', async () => {
    const list = await mcp(env, writeSecret, 'tools/list');
    const tools = list.result.tools as { name: string; annotations: Record<string, boolean> }[];
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of tools) {
      expect(t.annotations.readOnlyHint, t.name).toBe(!WRITE_TOOLS.includes(t.name));
      if (WRITE_TOOLS.includes(t.name)) expect(t.annotations.destructiveHint).toBe(false);
    }
  });

  it('creates a tagged link, is idempotent, and refuses the same ref for another page', async () => {
    const r = await post(env, writeSecret, 'create_link', { site_id: 'site1', ref: 'ph-launch', path: '/pricing?plan=pro', label: 'PH post' });
    expect(r.status).toBe(200);
    expect(r.body.data.created).toBe(true);
    expect(r.body.data.url).toBe('https://tidyform.app/pricing?plan=pro&ref=ph-launch');
    expect(r.body.data.link).toMatchObject({ ref: 'ph-launch', label: 'PH post', created_by: writeTokenId, site_id: 'site1' });

    const again = await post(env, writeSecret, 'create_link', { site_id: 'site1', ref: 'ph-launch', path: 'https://tidyform.app/pricing?plan=pro' });
    expect(again.status).toBe(200);
    expect(again.body.data.created).toBe(false);
    expect(again.body.data.link.id).toBe(r.body.data.link.id);

    const clash = await post(env, writeSecret, 'create_link', { site_id: 'site1', ref: 'ph-launch', path: '/blog' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already points to https:\/\/tidyform\.app\/pricing\?plan=pro/);
    expect(count(db, 'tracked_links')).toBe(1);

    const rows = auditRows(db);
    expect(rows.map((x) => [x.tool, x.write, x.ok])).toEqual([
      ['create_link', 1, 1],
      ['create_link', 1, 1],
      ['create_link', 1, 0],
    ]);
  });

  it('validates the ref slug and keeps links on the site\'s domain', async () => {
    for (const ref of ['a', '-ph', 'PH launch', 'ph_launch', 'x'.repeat(50), 'ph/launch']) {
      const r = await post(env, writeSecret, 'create_link', { site_id: 'site1', ref });
      expect(r.status, ref).toBe(400);
    }
    for (const path of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)', 'https://tidyform.app.evil.example/']) {
      const r = await post(env, writeSecret, 'create_link', { site_id: 'site1', ref: 'ok-ref', path });
      expect(r.status, path).toBe(400);
    }
    expect(count(db, 'tracked_links')).toBe(0);
    expect((await post(env, writeSecret, 'create_link', { site_id: 'site1', ref: 'ok-ref', bogus: 1 })).body.error).toMatch(/unknown argument/);
  });

  it('refuses write tools over GET', async () => {
    const r = await get(env, writeSecret, 'create_link?site_id=site1&ref=ph-launch');
    expect(r.status).toBe(405);
    expect(count(db, 'tracked_links')).toBe(0);
  });

  it('list_links reports visitors, customers and revenue per ref from the sessions', async () => {
    seedVisit(db, 'site1', 1, 'ph-launch', 1200);
    seedVisit(db, 'site1', 2, 'ph-launch', 2400);
    seedVisit(db, 'site1', 3, 'ph-launch', 0);
    seedVisit(db, 'site1', 4, 'newsletter', 900);
    seedVisit(db, 'site1', 5, null, 5000);
    await post(env, writeSecret, 'create_link', { site_id: 'site1', ref: 'ph-launch' });
    await post(env, writeSecret, 'create_link', { site_id: 'site1', ref: 'quiet-one', path: '/about' });

    const r = await get(env, readSecret, 'list_links?site_id=site1&period=30d');
    expect(r.status).toBe(200);
    const links = r.body.data.links as { ref: string; visitors: number; customers: number; revenue: number; url: string }[];
    expect(links.find((l) => l.ref === 'ph-launch')).toMatchObject({ visitors: 3, customers: 2, revenue: 3600, url: 'https://tidyform.app/?ref=ph-launch' });
    expect(links.find((l) => l.ref === 'quiet-one')).toMatchObject({ visitors: 0, customers: 0, revenue: 0 });
    expect(links.some((l) => l.ref === 'newsletter')).toBe(false); // not a tracked link

    // Same numbers as the ref breakdown.
    const b = await get(env, readSecret, 'get_breakdown?site_id=site1&dimension=ref');
    const row = (b.body.data.rows as { label: string; revenue: number; visitors: number }[]).find((x) => x.label === 'ph-launch');
    expect(row).toMatchObject({ revenue: 3600, visitors: 3 });
  });

  it('adds annotations, cleaned and capped, once per day and text', async () => {
    const r = await post(env, writeSecret, 'add_annotation', { site_id: 'site1', day: '2026-11-01', text: 'Launched\u0000 on\nProduct Hunt‮' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ created: true, annotation: { day: '2026-11-01', text: 'Launched on Product Hunt', created_by: writeTokenId } });
    const again = await post(env, writeSecret, 'add_annotation', { site_id: 'site1', day: '2026-11-01', text: 'Launched on Product Hunt' });
    expect(again.body.data.created).toBe(false);
    expect(count(db, 'annotations')).toBe(1);

    const long = await post(env, writeSecret, 'add_annotation', { site_id: 'site1', text: 'y'.repeat(1000) });
    expect(long.body.data.annotation.text).toHaveLength(200);
    expect(long.body.data.annotation.day).toBe(new Date().toISOString().slice(0, 10));

    for (const day of ['2026-02-30', '11/01/2026', 'yesterday']) {
      expect((await post(env, writeSecret, 'add_annotation', { site_id: 'site1', day, text: 'x' })).status, day).toBe(400);
    }
    expect((await post(env, writeSecret, 'add_annotation', { site_id: 'site1', text: '\u0000\u0001 ' })).status).toBe(400);
    expect(auditRows(db).filter((x) => x.tool === 'add_annotation').every((x) => x.write === 1)).toBe(true);
  });

  it('lists the annotations inside the period', async () => {
    const today = new Date(now).toISOString().slice(0, 10);
    const old = new Date(now - 100 * DAY).toISOString().slice(0, 10);
    await post(env, writeSecret, 'add_annotation', { site_id: 'site1', day: today, text: 'Raised prices' });
    await post(env, writeSecret, 'add_annotation', { site_id: 'site1', day: old, text: 'Long ago' });
    const r = await get(env, readSecret, 'list_annotations?site_id=site1&period=30d');
    expect(r.status).toBe(200);
    expect(r.body.data.annotations.map((a: { text: string }) => a.text)).toEqual(['Raised prices']);
  });

  it('documents write tools as POST only in the OpenAPI spec', async () => {
    const spec = (await call(env, 'GET', '/api/agent/v1/openapi.json')).body;
    expect(Object.keys(spec.paths['/api/agent/v1/create_link'])).toEqual(['post']);
    expect(spec.paths['/api/agent/v1/create_link'].post.requestBody.content['application/json'].schema.required).toEqual(['site_id', 'ref']);
    expect(Object.keys(spec.paths['/api/agent/v1/list_links']).sort()).toEqual(['get', 'post']);
    expect(new Set(Object.values(spec.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId))).size).toBe(TOOLS.length * 2 - WRITE_TOOLS.length);
  });
});

describe('write tools and owner endpoints (hosted): one account never touches another', () => {
  let db: Db, env: never, secretA: string, cookieA: string, cookieB: string;
  beforeEach(async () => {
    db = makeD1();
    env = hosted(db);
    db.raw.prepare(`INSERT INTO users (id, email, created_at, plan_status, plan_until) VALUES ('userA', 'a@example.com', 0, 'active', 9999999999999), ('userB', 'b@example.com', 0, 'active', 9999999999999)`).run();
    seedSite(db, 'siteA1', 'userA', 'a-one.example');
    seedSite(db, 'siteB1', 'userB', 'b-one.example');
    seedVisit(db, 'siteB1', 1, 'b-secret-ref', 99900);
    ({ secret: secretA } = await createToken(db.d1, 'userA', { name: 'A writer', scopes: 'read write' }));
    cookieA = `dm_auth=${await createSession(env, 'u:userA')}`;
    cookieB = `dm_auth=${await createSession(env, 'u:userB')}`;
  });

  it('agent tools answer another account\'s site exactly like a missing one', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['create_link', { site_id: 'siteB1', ref: 'sneaky' }],
      ['add_annotation', { site_id: 'siteB1', text: 'sneaky' }],
      ['list_links', { site_id: 'siteB1' }],
      ['list_annotations', { site_id: 'siteB1' }],
    ];
    for (const [tool, args] of calls) {
      for (const site_id of ['siteB1', 'nope']) {
        const r = await post(env, secretA, tool, { ...args, site_id });
        expect(r.status, `${tool} ${site_id}`).toBe(404);
        expect(r.body).toEqual({ error: 'site not found' });
      }
      const m = await mcp(env, secretA, 'tools/call', { name: tool, arguments: args });
      expect(m.result.isError).toBe(true);
      expect(m.result.content[0].text).toBe('site not found');
    }
    expect(count(db, 'tracked_links')).toBe(0);
    expect(count(db, 'annotations')).toBe(0);
    // Its own site works.
    expect((await post(env, secretA, 'create_link', { site_id: 'siteA1', ref: 'mine' })).body.data.url).toBe('https://a-one.example/?ref=mine');
    expect(auditRows(db).filter((x) => x.site_id === 'siteB1' && (x.tool === 'create_link' || x.tool === 'add_annotation')).every((x) => x.write === 1 && x.ok === 0)).toBe(true);
  });

  it('owner endpoints need a signed-in user', async () => {
    expect((await call(env, 'GET', '/api/sites/siteA1/links')).status).toBe(401);
    expect((await call(env, 'POST', '/api/sites/siteA1/annotations', { body: { text: 'x' } })).status).toBe(401);
  });

  it('owner endpoints create, list, archive and delete on the owner\'s own site', async () => {
    const created = await call(env, 'POST', '/api/sites/siteA1/links', { cookie: cookieA, body: { ref: 'tweet-1', path: '/pricing', label: 'Tweet' } });
    expect(created.status).toBe(201);
    expect(created.body.link).toMatchObject({ ref: 'tweet-1', created_by: 'owner', url: 'https://a-one.example/pricing?ref=tweet-1' });
    expect((await call(env, 'POST', '/api/sites/siteA1/links', { cookie: cookieA, body: { ref: 'tweet-1', path: '/pricing' } })).status).toBe(200);
    expect((await call(env, 'POST', '/api/sites/siteA1/links', { cookie: cookieA, body: { ref: 'tweet-1', path: '/' } })).status).toBe(409);
    expect((await call(env, 'POST', '/api/sites/siteA1/links', { cookie: cookieA, body: { ref: 'evil', path: 'https://evil.example/' } })).status).toBe(400);

    const list = await call(env, 'GET', '/api/sites/siteA1/links?period=30d', { cookie: cookieA });
    expect(list.body.links.map((l: { ref: string }) => l.ref)).toEqual(['tweet-1']);
    expect((await call(env, 'DELETE', `/api/sites/siteA1/links/${created.body.link.id}`, { cookie: cookieA })).status).toBe(200);
    expect((await call(env, 'GET', '/api/sites/siteA1/links', { cookie: cookieA })).body.links).toEqual([]);
    expect((await call(env, 'GET', '/api/sites/siteA1/links?include_archived=true', { cookie: cookieA })).body.links).toHaveLength(1);

    const ann = await call(env, 'POST', '/api/sites/siteA1/annotations', { cookie: cookieA, body: { text: 'Launch day' } });
    expect(ann.status).toBe(201);
    expect(ann.body.annotation.created_by).toBe('owner');
    expect((await call(env, 'GET', '/api/sites/siteA1/annotations', { cookie: cookieA })).body.annotations).toHaveLength(1);
    expect((await call(env, 'DELETE', `/api/sites/siteA1/annotations/${ann.body.annotation.id}`, { cookie: cookieA })).status).toBe(200);
    expect((await call(env, 'GET', '/api/sites/siteA1/annotations', { cookie: cookieA })).body.annotations).toEqual([]);
  });

  it('owner endpoints never reach another account\'s site, links or annotations', async () => {
    const bLink = (await call(env, 'POST', '/api/sites/siteB1/links', { cookie: cookieB, body: { ref: 'b-link' } })).body.link;
    const bAnn = (await call(env, 'POST', '/api/sites/siteB1/annotations', { cookie: cookieB, body: { text: 'B secret note' } })).body.annotation;
    expect(bLink?.id && bAnn?.id).toBeTruthy();

    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/sites/siteB1/links'],
      ['POST', '/api/sites/siteB1/links', { ref: 'sneaky' }],
      ['DELETE', `/api/sites/siteB1/links/${bLink.id}`],
      ['GET', '/api/sites/siteB1/annotations'],
      ['POST', '/api/sites/siteB1/annotations', { text: 'sneaky' }],
      ['DELETE', `/api/sites/siteB1/annotations/${bAnn.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(env, method, path, { cookie: cookieA, body });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/b-link|B secret note|b-secret-ref/);
    }
    // B's ids through A's own site: not found, and untouched.
    expect((await call(env, 'DELETE', `/api/sites/siteA1/links/${bLink.id}`, { cookie: cookieA })).status).toBe(404);
    expect((await call(env, 'DELETE', `/api/sites/siteA1/annotations/${bAnn.id}`, { cookie: cookieA })).status).toBe(404);

    const links = db.raw.prepare('SELECT site_id, ref, archived_at FROM tracked_links').all();
    expect(links).toEqual([{ site_id: 'siteB1', ref: 'b-link', archived_at: null }]);
    expect(db.raw.prepare('SELECT site_id, text FROM annotations').all()).toEqual([{ site_id: 'siteB1', text: 'B secret note' }]);
  });
});
