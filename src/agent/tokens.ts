import type { Env } from '../worker/env';
import { isAdminEmail, isHosted, planLimits, recordingPlan, type PlanName } from '../worker/auth';
import { randomId } from '../worker/lib/crypto';

export type Scope = 'read' | 'write';
const AGENT_SCOPES: Scope[] = ['read', 'write'];

export interface AgentToken {
  id: string;
  owner_id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  site_ids: string[] | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  /** When the current secret stops working: set for OAuth connections, NULL for tokens made by hand. */
  expires_at?: number | null;
  /** The OAuth client this connection belongs to, if it was made with "sign in and Allow". */
  oauth_client_id?: string | null;
}

interface TokenRow extends Omit<AgentToken, 'scopes' | 'site_ids'> {
  scopes: string;
  site_ids: string | null;
}

export const TOKEN_PREFIX = 'dm_';
const LAST_USED_EVERY_MS = 60_000;
/** How long an OAuth refresh token lives. Each refresh issues a new one, so a connection in use never runs out. */
export const REFRESH_TTL_MS = 30 * 86_400_000;

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only read and write can be granted. Anything else (admin, typos) is dropped, and read is always included. */
export function cleanScopes(input: unknown): Scope[] {
  const asked = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/)).map((s) => String(s).trim().toLowerCase());
  const out = new Set<Scope>(['read']);
  for (const s of asked) if ((AGENT_SCOPES as string[]).includes(s)) out.add(s as Scope);
  return AGENT_SCOPES.filter((s) => out.has(s));
}

function fromRow(r: TokenRow): AgentToken {
  return {
    ...r,
    scopes: cleanScopes(r.scopes),
    site_ids: r.site_ids ? r.site_ids.split(',').filter(Boolean) : null,
  };
}

/** The owner id for the person signed in to the dashboard. Self-hosted installs have one owner. */
export function ownerIdFor(env: Env, userId: string): string {
  return isHosted(env) ? userId : 'admin';
}

/** Creates a token and returns its secret once. Only the hash is stored. */
export async function createToken(
  db: D1Database,
  ownerId: string,
  opts: { name: string; scopes?: unknown; siteIds?: string[] | null; expiresAt?: number | null; oauthClientId?: string | null },
  now = Date.now(),
): Promise<{ token: AgentToken; secret: string }> {
  const secret = TOKEN_PREFIX + randomId(24);
  const scopes = cleanScopes(opts.scopes);
  const id = 'tok_' + randomId(8);
  const name = (opts.name || 'Agent').trim().slice(0, 80) || 'Agent';
  const siteIds = opts.siteIds?.length ? opts.siteIds.join(',') : null;
  await db
    .prepare(
      'INSERT INTO agent_tokens (id, owner_id, name, token_hash, prefix, scopes, site_ids, created_at, expires_at, oauth_client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, ownerId, name, await sha256Hex(secret), secret.slice(0, 10), scopes.join(' '), siteIds, now, opts.expiresAt ?? null, opts.oauthClientId ?? null)
    .run();
  const token: AgentToken = {
    id,
    owner_id: ownerId,
    name,
    prefix: secret.slice(0, 10),
    scopes,
    site_ids: siteIds ? siteIds.split(',') : null,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
    expires_at: opts.expiresAt ?? null,
    oauth_client_id: opts.oauthClientId ?? null,
  };
  return { token, secret };
}

/** Resolves a bearer header to a live token, or null. */
export async function authenticate(db: D1Database, header: string | null | undefined, now = Date.now()): Promise<AgentToken | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m || !m[1].startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .prepare('SELECT * FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
    .bind(await sha256Hex(m[1]), now)
    .first<TokenRow>();
  if (!row) return null;
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_EVERY_MS) {
    await db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
    row.last_used_at = now;
  }
  return fromRow(row);
}

/** Live tokens, and OAuth connections that can still refresh (an access secret is never older than the refresh lifetime). */
export async function listTokens(db: D1Database, ownerId: string, now = Date.now()): Promise<AgentToken[]> {
  const res = await db
    .prepare(
      'SELECT * FROM agent_tokens WHERE owner_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC',
    )
    .bind(ownerId, now - REFRESH_TTL_MS)
    .all<TokenRow>();
  return res.results.map(fromRow);
}

export async function revokeToken(db: D1Database, ownerId: string, id: string, now = Date.now()): Promise<boolean> {
  const res = await db
    .prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL')
    .bind(now, id, ownerId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * The SQL that limits sites to the ones this token's owner can see, mirroring siteAccessSql() for dashboard users:
 * self-hosted sees every site; in hosted mode an owner sees their own sites, and an admin also sees the sites that
 * existed before accounts. A token limited to certain sites narrows that further.
 */
export async function tokenSiteAccess(db: D1Database, env: Env, token: AgentToken): Promise<{ sql: string; params: unknown[] }> {
  let sql: string;
  const params: unknown[] = [];
  if (!isHosted(env)) {
    // Only the single owner's tokens see every site. A hosted customer's token must not, if an install ever loses its hosted settings.
    if (token.owner_id !== 'admin') return { sql: '0 = 1', params: [] };
    sql = '1 = 1';
  } else {
    const owner = await db.prepare('SELECT email FROM users WHERE id = ?').bind(token.owner_id).first<{ email: string }>();
    if (!owner) return { sql: '0 = 1', params: [] };
    sql = isAdminEmail(env, owner.email) ? '(s.owner_id = ? OR s.owner_id IS NULL)' : 's.owner_id = ?';
    params.push(token.owner_id);
  }
  if (token.site_ids?.length) {
    sql += ` AND s.id IN (${token.site_ids.map(() => '?').join(', ')})`;
    params.push(...token.site_ids);
  }
  return { sql, params };
}

/** Counted per UTC day beside the month's events. Pruned daily (src/cron). */
const callsKey = (now: number) => `${new Date(now).toISOString().slice(0, 10)}/agent`;

/** Each call is stored, so a hosted account has a number of them a day. Null when there is room, otherwise the number. */
export async function agentCallsUsedUp(db: D1Database, env: Env, ownerId: string, now = Date.now()): Promise<number | null> {
  if (!isHosted(env)) return null;
  const owner = await db
    .prepare('SELECT email, plan_until, (SELECT events FROM usage_monthly WHERE owner_id = users.id AND month = ?) AS calls FROM users WHERE id = ?')
    .bind(callsKey(now), ownerId)
    .first<{ email: string; plan_until: number | null; calls: number | null }>();
  if (!owner || isAdminEmail(env, owner.email)) return null;
  const plan: PlanName = recordingPlan(owner.plan_until, now);
  const limit = planLimits(env, plan).agentCallsPerDay;
  return (owner.calls ?? 0) >= limit ? limit : null;
}

/** Connections an account may make in a day, by hand or by signing an app in. Revoked ones count: they stay stored. */
const TOKENS_PER_DAY = 50;
export async function tokensUsedUp(db: D1Database, ownerId: string, now = Date.now()): Promise<boolean> {
  if (ownerId === 'admin') return false;
  const r = await db.prepare('SELECT COUNT(*) AS n FROM agent_tokens WHERE owner_id = ? AND created_at > ?').bind(ownerId, now - 86_400_000).first<{ n: number }>();
  return (r?.n ?? 0) >= TOKENS_PER_DAY;
}

const AUDIT_KEPT = 5_000;
const AUDIT_STRING = 300;
const AUDIT_TOTAL = 2000;

/** Arguments for the activity log: always valid JSON, with long values shortened and marked rather than cut mid-way. */
export function auditArgs(args: unknown): string | null {
  if (args === undefined) return null;
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… (${s.length} characters)` : s);
  const shrink = (v: unknown, max: number, depth: number): unknown => {
    if (typeof v === 'string') return clip(v, max);
    if (!v || typeof v !== 'object') return v;
    if (depth > 2) return clip(JSON.stringify(v), max);
    const entries = Object.entries(v);
    const kept = entries.slice(0, 20).map(([k, x]) => [clip(k, 60), shrink(x, max, depth + 1)] as [string, unknown]);
    if (entries.length > 20) kept.push(['…', `${entries.length - 20} more`]);
    return Array.isArray(v) ? kept.map(([, x]) => x) : Object.fromEntries(kept);
  };
  for (const max of [AUDIT_STRING, 80, 20]) {
    const json = JSON.stringify(shrink(args, max, 0));
    if (json.length <= AUDIT_TOTAL) return json;
  }
  return JSON.stringify({ note: `arguments too large to list (${JSON.stringify(args).length} characters)` });
}

export async function audit(
  db: D1Database,
  token: AgentToken,
  entry: { tool: string; siteId?: string | null; args?: unknown; write?: boolean; ok: boolean },
  now = Date.now(),
) {
  const row = db
    .prepare('INSERT INTO agent_audit (owner_id, token_id, site_id, tool, args, write, ok, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(token.owner_id, token.id, entry.siteId?.slice(0, 64) ?? null, entry.tool, auditArgs(entry.args), entry.write ? 1 : 0, entry.ok ? 1 : 0, now);
  // A single-owner install has nobody to share with: no counting, and its log is kept whole.
  if (token.owner_id === 'admin') return void (await row.run());
  await db.batch([
    row,
    db.prepare('INSERT INTO usage_monthly (owner_id, month, events) VALUES (?, ?, 1) ON CONFLICT(owner_id, month) DO UPDATE SET events = events + 1').bind(token.owner_id, callsKey(now)),
    ...(Math.random() < 0.01
      ? [db.prepare('DELETE FROM agent_audit WHERE owner_id = ? AND ts < (SELECT ts FROM agent_audit WHERE owner_id = ? ORDER BY ts DESC LIMIT 1 OFFSET ?)').bind(token.owner_id, token.owner_id, AUDIT_KEPT)]
      : []),
  ]);
}
