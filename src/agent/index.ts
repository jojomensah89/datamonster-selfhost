import type { Context, Hono, Next } from 'hono';
import type { AppEnv, Site } from '../worker/env';
import { requireUser, siteAccessSql, isHosted } from '../worker/auth';
import { GUIDE, guideFor } from './guide';
import { openapi } from './openapi';
import { llmsTxt } from './llms';
import { memoryLimiter } from '../worker/lib/limits';
import { agentCallsUsedUp, audit, authenticate, createToken, listTokens, ownerIdFor, revokeToken, tokensUsedUp, tokenSiteAccess, type AgentToken } from './tokens';
import { addAnnotation, annotationsIn, archiveLink, createLink, deleteAnnotation, linksWithStats } from './links';
import { wwwAuthenticate } from './oauth';
import { addPlacement, archivePlacement, getPlacement, placementsWithStats, updatePlacement, verifyPlacement, checkAllowed } from './placements';
import { checkArgs, ctxFrom, ToolError, TOOLS, toolByName, type Tool } from './tools';

import { SERVER_INFO } from './meta';
export { SERVER_INFO };
export { mountOAuth } from './oauth';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type AgentEnv = AppEnv & { Variables: AppEnv['Variables'] & { agentToken: AgentToken } };
type Json = Record<string, unknown>;

// The header points MCP clients at the OAuth discovery document (MCP authorization, RFC 9728), so Claude.ai, ChatGPT
// and other clients can connect with "sign in and Allow" instead of a pasted token.
const unauthorized = (c: Context) =>
  c.json({ error: 'A DataMonster agent token is required: Authorization: Bearer dm_... (or connect with OAuth)' }, 401, {
    'WWW-Authenticate': wwwAuthenticate(new URL(c.req.url).origin),
  });

// Every call is logged, so what one account's agents can do a minute is bounded.
const callsPerAccount = memoryLimiter(240, 60_000);

async function agentAuth(c: Context<AgentEnv>, next: Next) {
  const token = await authenticate(c.env.DB, c.req.header('authorization'));
  if (!token || (!isHosted(c.env) && token.owner_id !== 'admin')) return unauthorized(c);
  if (isHosted(c.env) && !callsPerAccount(token.owner_id)) return c.json({ error: 'Too many calls. Try again in a minute.' }, 429, { 'Retry-After': '60' });
  const used = await agentCallsUsedUp(c.env.DB, c.env, token.owner_id);
  if (used) return c.json({ error: `This account's ${used.toLocaleString('en-US')} agent calls for today are used up. They start again at 00:00 UTC.` }, 429, { 'Retry-After': '3600' });
  c.set('agentToken', token);
  await next();
}

async function sitesFor(c: Context<AgentEnv>, token: AgentToken): Promise<Site[]> {
  const access = await tokenSiteAccess(c.env.DB, c.env, token);
  const res = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE ${access.sql} ORDER BY s.created_at`).bind(...access.params).all<Site>();
  return res.results;
}

/** Runs one tool for one token: scope check, argument check, the call itself and the audit row. */
export async function callTool(c: Context<AgentEnv>, tool: Tool, args: Json) {
  const token = c.get('agentToken');
  let siteId = typeof args.site_id === 'string' ? args.site_id.slice(0, 64) : null;
  if (!token.scopes.includes(tool.scope)) {
    await audit(c.env.DB, token, { tool: tool.name, siteId, args, write: tool.scope === 'write', ok: false });
    throw new ToolError(`this token does not have the ${tool.scope} scope`, 403);
  }
  try {
    checkArgs(tool, args);
    const sites = await sitesFor(c, token);
    // The log names the site the call ran on, even when the token sees one site and the call left it out.
    if (!siteId && 'site_id' in tool.input.properties && sites.length === 1) siteId = sites[0].id;
    const data = await tool.run(args, { db: c.env.DB, env: c.env, sites, tokenId: token.id });
    await audit(c.env.DB, token, { tool: tool.name, siteId, args, write: tool.scope === 'write', ok: true });
    return data;
  } catch (e) {
    await audit(c.env.DB, token, { tool: tool.name, siteId, args, write: tool.scope === 'write', ok: false });
    throw e;
  }
}

/** Query-string arguments for REST GETs: numbers stay strings (the tools coerce them), filters arrive as JSON. */
function argsFromQuery(q: Record<string, string>): Json {
  const out: Json = { ...q };
  if (typeof q.filters === 'string') {
    try {
      out.filters = JSON.parse(q.filters);
    } catch {
      throw new ToolError('filters must be a JSON object, e.g. {"source":"X"}');
    }
  }
  return out;
}

function toolResponse(c: Context, run: () => Promise<unknown>) {
  return run().then(
    (data) => c.json(data as Json),
    (e) => {
      if (e instanceof ToolError) return c.json({ error: e.message }, e.status as 400);
      console.error('agent tool failed', e);
      return c.json({ error: 'internal error' }, 500);
    },
  );
}

// ---------------------------------------------------------------- MCP (Streamable HTTP, JSON responses)

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function mcpTools(token: AgentToken) {
  return TOOLS.filter((t) => token.scopes.includes(t.scope)).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.input,
    annotations:
      t.scope === 'read'
        ? { readOnlyHint: true, openWorldHint: !!t.openWorld }
        : { readOnlyHint: false, destructiveHint: false, idempotentHint: !!t.idempotent, openWorldHint: !!t.openWorld },
  }));
}

async function handleRpc(c: Context<AgentEnv>, msg: Json): Promise<Json | null> {
  const { id, method } = msg;
  const params = (msg.params ?? {}) as Json;
  const isNotification = id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id, -32600, 'Invalid request');
  if (isNotification) return null; // notifications/initialized, notifications/cancelled: nothing to answer

  switch (method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '');
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: guideFor(isHosted(c.env)).start,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: mcpTools(c.get('agentToken')) });
    case 'tools/call': {
      const tool = toolByName(String(params.name ?? ''));
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name ?? '')}`);
      try {
        const data = await callTool(c, tool, (params.arguments ?? {}) as Json);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
      } catch (e) {
        // Tool failures go back to the model as a result it can read and correct, not as a protocol error.
        const message = e instanceof ToolError ? e.message : 'internal error';
        if (!(e instanceof ToolError)) console.error('mcp tool failed', e);
        return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------- routes

export function mountAgent(app: Hono<AppEnv>) {
  const a = app as unknown as Hono<AgentEnv>;

  // Public: what agents can call and how to use it. No data.
  a.get('/api/agent/v1/openapi.json', (c) => c.json(openapi(new URL(c.req.url).origin)));
  a.get('/api/agent/v1/guide', (c) => {
    const topic = c.req.query('topic');
    return c.json(topic && topic in GUIDE ? { topic, text: guideFor(isHosted(c.env))[topic as keyof typeof GUIDE] } : { topics: guideFor(isHosted(c.env)) });
  });

  // Public: /llms.txt for agents that discover the install from its origin. Plain Markdown, no data, cached briefly.
  a.get('/llms.txt', (c) =>
    c.body(llmsTxt(new URL(c.req.url).origin, isHosted(c.env)), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    }),
  );

  // REST: one path per tool, GET with query arguments or POST with a JSON body.
  a.use('/api/agent/v1/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/agent/v1/openapi.json' || p === '/api/agent/v1/guide') return next();
    return agentAuth(c, next);
  });
  a.get('/api/agent/v1/:tool', (c) =>
    toolResponse(c, async () => {
      const tool = toolByName(c.req.param('tool'));
      if (!tool) throw new ToolError('unknown tool', 404);
      // A GET must never change anything (link prefetchers, crawlers): write tools are POST only.
      if (tool.scope === 'write') throw new ToolError(`${tool.name} changes data: call it with POST and a JSON body`, 405);
      return callTool(c, tool, argsFromQuery(c.req.query()));
    }),
  );
  a.post('/api/agent/v1/:tool', (c) =>
    toolResponse(c, async () => {
      const tool = toolByName(c.req.param('tool'));
      if (!tool) throw new ToolError('unknown tool', 404);
      const body = await c.req.json<Json>().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ToolError('body must be a JSON object');
      return callTool(c, tool, body);
    }),
  );

  // MCP over Streamable HTTP. The server keeps no session and answers every POST with JSON.
  a.post('/api/agent/mcp', agentAuth, async (c) => {
    const body = await c.req.json<unknown>().catch(() => undefined);
    if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json(rpcError(null, -32700, 'Parse error: send one JSON-RPC message per request'), 400);
    }
    const out = await handleRpc(c, body as Json);
    if (!out) return c.body(null, 202);
    return c.json(out);
  });
  a.get('/api/agent/mcp', (c) => c.json({ error: 'This server does not open a stream. POST JSON-RPC messages.' }, 405, { Allow: 'POST' }));

  // Dashboard: the signed-in owner manages tokens and reads the audit log.
  a.use('/api/agent-tokens', requireUser);
  a.use('/api/agent-tokens/*', requireUser);
  a.use('/api/agent-audit', requireUser);
  a.get('/api/agent-tokens', async (c) => c.json(await listTokens(c.env.DB, ownerIdFor(c.env, c.get('user').id))));
  a.post('/api/agent-tokens', async (c) => {
    const b = await c.req.json<{ name?: string; scopes?: unknown; site_ids?: string[] }>().catch(() => ({}) as { name?: string; scopes?: unknown; site_ids?: string[] });
    const ownerId = ownerIdFor(c.env, c.get('user').id);
    if (await tokensUsedUp(c.env.DB, ownerId)) return c.json({ error: 'That is enough new tokens for one day. Try again tomorrow.' }, 429);
    // A token may only be limited to sites the owner can already see.
    let siteIds: string[] | null = null;
    if (Array.isArray(b.site_ids) && b.site_ids.length) {
      const probe = { id: 'probe', owner_id: ownerId, name: '', prefix: '', scopes: ['read' as const], site_ids: null, created_at: 0, last_used_at: null, revoked_at: null };
      const access = await tokenSiteAccess(c.env.DB, c.env, probe);
      const own = await c.env.DB.prepare(`SELECT s.id FROM sites s WHERE ${access.sql}`).bind(...access.params).all<{ id: string }>();
      const allowed = new Set(own.results.map((r) => r.id));
      siteIds = b.site_ids.map(String).filter((id) => allowed.has(id));
      if (!siteIds.length) return c.json({ error: 'none of those sites belong to you' }, 400);
    }
    const { token, secret } = await createToken(c.env.DB, ownerId, { name: b.name ?? 'Agent', scopes: b.scopes, siteIds });
    return c.json({ token, secret, note: 'Copy the secret now. It is not shown again.' }, 201);
  });
  a.delete('/api/agent-tokens/:id', async (c) => {
    const ok = await revokeToken(c.env.DB, ownerIdFor(c.env, c.get('user').id), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'token not found' }, 404);
  });
  a.get('/api/agent-audit', async (c) => {
    const res = await c.env.DB.prepare('SELECT * FROM agent_audit WHERE owner_id = ? ORDER BY ts DESC, id DESC LIMIT 200')
      .bind(ownerIdFor(c.env, c.get('user').id))
      .all();
    return c.json(res.results);
  });

  // Dashboard: tagged links and annotations, for the signed-in owner, with the dashboard's own site access rules.
  // The worker already runs requireUser on /api/sites/*; ensureUser only signs in again if that ever changes.
  const ensureUser = async (c: Context<AgentEnv>, next: Next) => (c.get('user') ? next() : requireUser(c as never, next));
  const ownerSite = async (c: Context<AgentEnv>): Promise<Site | null> => {
    const access = siteAccessSql(c.env, c.get('user'));
    return c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`).bind(c.req.param('id'), ...access.params).first<Site>();
  };
  const ownerRoute = (handler: (c: Context<AgentEnv>, site: Site) => Promise<Response>) => async (c: Context<AgentEnv>) => {
    const site = await ownerSite(c);
    if (!site) return c.json({ error: 'site not found' }, 404);
    try {
      return await handler(c, site);
    } catch (e) {
      if (e instanceof ToolError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  };
  const body = async (c: Context<AgentEnv>) => {
    const b = await c.req.json<Json>().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ToolError('body must be a JSON object');
    return b;
  };
  for (const p of ['/api/sites/:id/links', '/api/sites/:id/links/*', '/api/sites/:id/annotations', '/api/sites/:id/annotations/*', '/api/sites/:id/placements', '/api/sites/:id/placements/*']) a.use(p, ensureUser);

  a.get(
    '/api/sites/:id/links',
    ownerRoute(async (c, site) => {
      const ctx = ctxFrom(c.env.DB, site, c.req.query());
      return c.json({ links: await linksWithStats(ctx, { includeArchived: c.req.query('include_archived') === 'true' }) });
    }),
  );
  a.post(
    '/api/sites/:id/links',
    ownerRoute(async (c, site) => {
      const b = await body(c);
      const { created, link } = await createLink(c.env.DB, site, { ref: b.ref, path: b.path, label: b.label }, 'owner');
      return c.json({ created, link }, created ? 201 : 200);
    }),
  );
  a.delete(
    '/api/sites/:id/links/:linkId',
    ownerRoute(async (c, site) =>
      (await archiveLink(c.env.DB, site, c.req.param('linkId') ?? '')) ? c.json({ ok: true }) : c.json({ error: 'link not found' }, 404),
    ),
  );
  a.get(
    '/api/sites/:id/annotations',
    ownerRoute(async (c, site) => c.json({ annotations: await annotationsIn(ctxFrom(c.env.DB, site, c.req.query())) })),
  );
  a.post(
    '/api/sites/:id/annotations',
    ownerRoute(async (c, site) => {
      const b = await body(c);
      const { created, annotation } = await addAnnotation(c.env.DB, site, { day: b.day, text: b.text }, 'owner');
      return c.json({ created, annotation }, created ? 201 : 200);
    }),
  );
  a.delete(
    '/api/sites/:id/annotations/:annId',
    ownerRoute(async (c, site) =>
      (await deleteAnnotation(c.env.DB, site, c.req.param('annId') ?? '')) ? c.json({ ok: true }) : c.json({ error: 'annotation not found' }, 404),
    ),
  );

  // Dashboard: launches (placements). Same rules as the agent tools; the owner may also archive and restore.
  a.get(
    '/api/sites/:id/placements',
    ownerRoute(async (c, site) => {
      const ctx = ctxFrom(c.env.DB, site, { period: 'all', ...c.req.query() });
      return c.json({ placements: await placementsWithStats(ctx, { includeArchived: c.req.query('include_archived') === 'true' }) });
    }),
  );
  a.post(
    '/api/sites/:id/placements',
    ownerRoute(async (c, site) => {
      const { created, placement } = await addPlacement(c.env.DB, site, await body(c), 'owner');
      return c.json({ created, placement }, created ? 201 : 200);
    }),
  );
  a.patch(
    '/api/sites/:id/placements/:pid',
    ownerRoute(async (c, site) => c.json({ placement: await updatePlacement(c.env.DB, site, c.req.param('pid') ?? '', await body(c)) })),
  );
  a.delete(
    '/api/sites/:id/placements/:pid',
    ownerRoute(async (c, site) =>
      (await archivePlacement(c.env.DB, site, c.req.param('pid') ?? '')) ? c.json({ ok: true }) : c.json({ error: 'launch not found' }, 404),
    ),
  );
  a.post(
    '/api/sites/:id/placements/:pid/verify',
    ownerRoute(async (c, site) => {
      const p = await getPlacement(c.env.DB, site, c.req.param('pid') ?? '');
      if (!p) return c.json({ error: 'launch not found' }, 404);
      checkAllowed(site);
      return c.json(await verifyPlacement(c.env.DB, site, p));
    }),
  );
}
