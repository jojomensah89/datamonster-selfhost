import type { Site } from '../worker/env';
import { randomId } from '../worker/lib/crypto';
import { memoryLimiter } from '../worker/lib/limits';
import type { Ctx } from '../worker/stats';
import { ToolError } from './errors';
import { cleanDay, cleanRef, cleanText, siteToday } from './links';

/**
 * Launches ("placements"): where a site launched or is listed (Product Hunt, BetaList, a newsletter), whether the
 * listing is still up, and what it brought in. Shared by the agent tools (tools.ts), the owner's endpoints (index.ts)
 * and the daily check (src/cron). Callers must already have checked that `site` is visible to them.
 */

export const PLACEMENT_STATUSES = ['draft', 'submitted', 'in_review', 'live', 'rejected', 'removed'] as const;
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];
export type CheckResult = 'ok' | 'missing' | 'error' | 'unknown';

export const MAX_PLACEMENTS_PER_SITE = 100;
export const NAME_MAX = 80;
export const NOTES_MAX = 500;
const URL_MAX = 500;
const SOURCE_MAX = 100;
/** A listing is not fetched again sooner than this, however often verify is called. */
export const RECHECK_AFTER_MS = 60_000;

/** Which status may follow which when set by hand. Verification only ever moves a placement to live. */
export const TRANSITIONS: Record<PlacementStatus, readonly PlacementStatus[]> = {
  draft: ['submitted', 'in_review', 'live'],
  submitted: ['draft', 'in_review', 'live', 'rejected'],
  in_review: ['submitted', 'live', 'rejected'],
  live: ['in_review', 'removed'],
  rejected: ['draft', 'submitted', 'in_review'],
  removed: ['live', 'submitted'],
};

export interface Placement {
  id: string;
  site_id: string;
  name: string;
  listing_url: string | null;
  launched_on: string | null;
  status: PlacementStatus;
  match_source: string | null;
  match_domain: string | null;
  match_ref: string | null;
  last_checked_at: number | null;
  /** When a check last started. Unlike last_checked_at it survives a URL change; never sent out. */
  last_attempt_at?: number | null;
  last_check_result: CheckResult | null;
  last_check_detail: string | null;
  notes: string | null;
  created_by: string;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

/** A live listing whose last check found it gone: the owner should look. */
export const needsAttention = (p: Placement) => !p.archived_at && p.status === 'live' && p.last_check_result === 'missing';

export const publicPlacement = ({ last_attempt_at: _attempt, ...p }: Placement) => ({ ...p, needs_attention: needsAttention(p), overdue: !p.archived_at && ['live', 'in_review'].includes(p.status) && !!p.listing_url && Date.now() - (p.last_checked_at ?? p.created_at) > 30 * 3_600_000 });

// ---------------------------------------------------------------- validation

const BLOCKED_SUFFIXES = [
  'localhost', 'localdomain', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'arpa', 'test', 'invalid', 'onion', 'example', 'alt',
  // Cloud metadata, container and cluster names.
  'metadata.goog', 'consul', 'svc', 'cluster', 'docker', 'kube',
  // Public names that answer with whatever address is written in them.
  'nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'traefik.me', 'vcap.me', 'lacolhost.com', 'rbndr.us',
];

/**
 * Why `url` may not be fetched from the Worker, or null when it may: http(s) only, no credentials, default port,
 * and a public DNS name. IP literals (v4 in any notation, v6) and internal names are refused, so a listing URL can
 * never point the Worker at a private service.
 */
export function urlProblem(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must be an http or https URL';
  if (url.username || url.password) return 'must not contain credentials';
  if (url.port) return 'must not set a port';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':')) return 'must use a domain name, not an IP address';
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return 'must use a public domain name';
  // A numeric last label means an IPv4 literal in some notation (127.0.0.1, 0x7f.1, 2130706433 needs no dot but fails above).
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(tld) || /^0x/.test(tld)) return 'must use a domain name, not an IP address';
  if (BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return 'must be a public host';
  return null;
}

/** A listing page the Worker may check: see urlProblem. Returns the normalized URL without its fragment. */
export function cleanListingUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ToolError('listing_url is empty');
  if (raw.length > URL_MAX) throw new ToolError(`listing_url is longer than ${URL_MAX} characters`);
  if (/[\u0000-\u001f\u007f\\\s]/.test(raw)) throw new ToolError('listing_url contains characters that are not allowed');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ToolError('listing_url is not a valid URL');
  }
  const problem = urlProblem(url);
  if (problem) throw new ToolError(`listing_url ${problem}`);
  url.hash = '';
  return url.toString();
}

/** A referrer domain rule: "producthunt.com" (scheme, www. and path are dropped). */
export function cleanMatchDomain(input: unknown): string {
  const d = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d) || d.length > 253) throw new ToolError('match_domain must be a domain like producthunt.com');
  return d;
}

function cleanStatus(input: unknown): PlacementStatus {
  const s = String(input ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!(PLACEMENT_STATUSES as readonly string[]).includes(s)) throw new ToolError(`status must be one of ${PLACEMENT_STATUSES.join(', ')}`);
  return s as PlacementStatus;
}

const isBlank = (v: unknown) => v === null || (typeof v === 'string' && v.trim() === '');

type Fields = Partial<Pick<Placement, 'name' | 'listing_url' | 'launched_on' | 'status' | 'match_source' | 'match_domain' | 'match_ref' | 'notes'>>;

/** Cleans the fields present in `input`. A null or empty string clears an optional field. */
function cleanFields(input: Record<string, unknown>): Fields {
  const out: Fields = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name, NAME_MAX);
    if (!name) throw new ToolError('name is required');
    out.name = name;
  }
  if (input.listing_url !== undefined) out.listing_url = isBlank(input.listing_url) ? null : cleanListingUrl(input.listing_url);
  if (input.launched_on !== undefined) out.launched_on = isBlank(input.launched_on) ? null : cleanDay(input.launched_on);
  if (input.status !== undefined && !isBlank(input.status)) out.status = cleanStatus(input.status);
  if (input.match_source !== undefined) out.match_source = isBlank(input.match_source) ? null : cleanText(input.match_source, SOURCE_MAX) || null;
  if (input.match_domain !== undefined) out.match_domain = isBlank(input.match_domain) ? null : cleanMatchDomain(input.match_domain);
  if (input.match_ref !== undefined) out.match_ref = isBlank(input.match_ref) ? null : cleanRef(input.match_ref);
  if (input.notes !== undefined) out.notes = isBlank(input.notes) ? null : cleanText(input.notes, NOTES_MAX) || null;
  return out;
}

// ---------------------------------------------------------------- create, update, archive

export interface PlacementInput {
  name?: unknown;
  listing_url?: unknown;
  launched_on?: unknown;
  status?: unknown;
  match_source?: unknown;
  match_domain?: unknown;
  match_ref?: unknown;
  notes?: unknown;
}

const byName = (db: D1Database, siteId: string, name: string) =>
  db.prepare('SELECT * FROM placements WHERE site_id = ? AND name = ? COLLATE NOCASE').bind(siteId, name).first<Placement>();

export const getPlacement = (db: D1Database, site: Site, id: string) =>
  db.prepare('SELECT * FROM placements WHERE id = ? AND site_id = ?').bind(String(id ?? ''), site.id).first<Placement>();

/**
 * Adds a placement. The same name again returns the existing one unchanged (restoring it if archived), so a retried
 * call never makes two; use updatePlacement to change it. Without a match rule, sessions whose source is the name count.
 */
export async function addPlacement(
  db: D1Database,
  site: Site,
  input: PlacementInput,
  createdBy: string,
  now = Date.now(),
): Promise<{ created: boolean; placement: ReturnType<typeof publicPlacement> }> {
  if (isBlank(input.name) || input.name === undefined) throw new ToolError('name is required');
  const f = cleanFields(input as Record<string, unknown>);
  const name = f.name!;

  const existing = await byName(db, site.id, name);
  if (existing) return { created: false, placement: publicPlacement(await restore(db, existing, now)) };

  const count = await db.prepare('SELECT COUNT(*) AS n FROM placements WHERE site_id = ?').bind(site.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PLACEMENTS_PER_SITE) throw new ToolError(`this site already has ${MAX_PLACEMENTS_PER_SITE} launches`, 409);

  const status = f.status ?? (f.listing_url ? 'submitted' : 'draft');
  const noRule = !f.match_source && !f.match_domain && !f.match_ref;
  const p: Placement = {
    id: 'plc_' + randomId(8),
    site_id: site.id,
    name,
    listing_url: f.listing_url ?? null,
    launched_on: f.launched_on ?? (status === 'live' ? siteToday(site, now) : null),
    status,
    match_source: noRule ? name : (f.match_source ?? null),
    match_domain: f.match_domain ?? null,
    match_ref: f.match_ref ?? null,
    last_checked_at: null,
    last_check_result: null,
    last_check_detail: null,
    notes: f.notes ?? null,
    created_by: createdBy,
    created_at: now,
    updated_at: null,
    archived_at: null,
  };
  const res = await db
    .prepare(
      `INSERT INTO placements (id, site_id, name, listing_url, launched_on, status, match_source, match_domain, match_ref, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(p.id, site.id, p.name, p.listing_url, p.launched_on, p.status, p.match_source, p.match_domain, p.match_ref, p.notes, createdBy, now)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    // Lost a race with the same name: answer like the second call would have.
    const row = await byName(db, site.id, name);
    if (row) return { created: false, placement: publicPlacement(row) };
  }
  return { created: true, placement: publicPlacement(p) };
}

async function restore(db: D1Database, p: Placement, now: number): Promise<Placement> {
  if (!p.archived_at) return p;
  await db.prepare('UPDATE placements SET archived_at = NULL, updated_at = ? WHERE id = ?').bind(now, p.id).run();
  return { ...p, archived_at: null, updated_at: now };
}

/** Throws unless `from` may become `to` by hand. Setting the same status again is fine. */
export function checkTransition(from: PlacementStatus, to: PlacementStatus) {
  if (from === to || TRANSITIONS[from].includes(to)) return;
  throw new ToolError(`a launch that is ${from} can't become ${to}; it can become ${TRANSITIONS[from].join(', ')}`, 409);
}

/**
 * Changes the fields present in `input`. `archived` (true/false) is for the owner's dashboard only; agents never
 * archive. Status changes follow TRANSITIONS; becoming live without a launch date sets it to today.
 */
export async function updatePlacement(
  db: D1Database,
  site: Site,
  id: string,
  input: PlacementInput & { archived?: unknown },
  now = Date.now(),
): Promise<ReturnType<typeof publicPlacement>> {
  const p = await getPlacement(db, site, id);
  if (!p) throw new ToolError('launch not found', 404);
  const f = cleanFields(input as Record<string, unknown>);
  if (f.status) checkTransition(p.status, f.status);
  if (f.name && f.name.toLowerCase() !== p.name.toLowerCase()) {
    const clash = await byName(db, site.id, f.name);
    if (clash) throw new ToolError(`another launch is already named "${clash.name}"`, 409);
  }
  const next: Placement = { ...p, ...f, updated_at: now };
  if (!next.match_source && !next.match_domain && !next.match_ref) {
    throw new ToolError('a launch needs at least one of match_source, match_domain or match_ref to count visitors');
  }
  if (f.status === 'live' && p.status !== 'live' && !next.launched_on) next.launched_on = siteToday(site, now);
  if (input.archived === true || input.archived === 'true') next.archived_at = p.archived_at ?? now;
  else if (input.archived === false || input.archived === 'false') next.archived_at = null;
  // A new listing URL makes the last check meaningless.
  if (f.listing_url !== undefined && f.listing_url !== p.listing_url) {
    next.last_checked_at = null;
    next.last_check_result = null;
    next.last_check_detail = null;
  }
  await db
    .prepare(
      `UPDATE placements SET name = ?, listing_url = ?, launched_on = ?, status = ?, match_source = ?, match_domain = ?, match_ref = ?,
         notes = ?, last_checked_at = ?, last_check_result = ?, last_check_detail = ?, updated_at = ?, archived_at = ?
       WHERE id = ? AND site_id = ?`,
    )
    .bind(
      next.name, next.listing_url, next.launched_on, next.status, next.match_source, next.match_domain, next.match_ref,
      next.notes, next.last_checked_at, next.last_check_result, next.last_check_detail, next.updated_at, next.archived_at,
      p.id, site.id,
    )
    .run();
  return publicPlacement(next);
}

export async function archivePlacement(db: D1Database, site: Site, id: string, now = Date.now()): Promise<boolean> {
  const res = await db
    .prepare('UPDATE placements SET archived_at = ?, updated_at = ? WHERE id = ? AND site_id = ? AND archived_at IS NULL')
    .bind(now, now, String(id ?? ''), site.id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------- what each placement brought in

/** Sessions that came from `p`: any of its match fields, as SQL on sessions `s`. Null when it has none. */
export function matchSql(p: Pick<Placement, 'match_source' | 'match_domain' | 'match_ref'>): { sql: string; params: string[] } | null {
  const parts: string[] = [];
  const params: string[] = [];
  if (p.match_source) {
    parts.push('s.source = ? COLLATE NOCASE');
    params.push(p.match_source);
  }
  if (p.match_domain) {
    // Domains are [a-z0-9.-] only (cleanMatchDomain), so LIKE needs no escaping.
    parts.push('(s.referrer_domain = ? OR s.referrer_domain LIKE ?)');
    params.push(p.match_domain, `%.${p.match_domain}`);
  }
  if (p.match_ref) {
    parts.push('s.ref = ?');
    params.push(p.match_ref);
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : null;
}

/**
 * Placements with visitors, paying customers and revenue over ctx's range. The counting rules are the dashboard's
 * breakdown (worker/stats.ts): visitors by sessions started in the range, revenue by payments in the range credited
 * to a matching session. breakdown() itself groups by one column, while a placement matches sessions by any of
 * several, so each placement gets the same two aggregates over its own match condition (a session counts once).
 */
export async function placementsWithStats(ctx: Ctx, opts: { includeArchived?: boolean } = {}) {
  const res = await ctx.db
    .prepare(
      `SELECT * FROM placements WHERE site_id = ?${opts.includeArchived ? '' : ' AND archived_at IS NULL'}
       ORDER BY archived_at IS NOT NULL, launched_on IS NULL, launched_on DESC, created_at DESC`,
    )
    .bind(ctx.site.id)
    .all<Placement>();
  const rows = res.results;
  if (!rows.length) return [];
  const { from, to } = ctx.range;
  // Every launch in two queries: the visits and the payments are each read once, then matched to the launches.
  const launches = `launches AS MATERIALIZED (SELECT id, match_source, match_domain, match_ref FROM placements WHERE site_id = ?)`;
  const matches = `((l.match_source IS NOT NULL AND x.source = l.match_source COLLATE NOCASE)
      OR (l.match_domain IS NOT NULL AND (x.referrer_domain = l.match_domain OR x.referrer_domain LIKE '%.' || l.match_domain))
      OR (l.match_ref IS NOT NULL AND x.ref = l.match_ref))`;
  const [v, r] = await ctx.db.batch([
    ctx.db
      .prepare(
        `WITH ${launches}, x AS MATERIALIZED (
           SELECT DISTINCT source, referrer_domain, ref, visitor_id FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?)
         SELECT l.id, COUNT(DISTINCT x.visitor_id) AS visitors FROM launches l JOIN x ON ${matches} GROUP BY l.id`,
      )
      .bind(ctx.site.id, ctx.site.id, from, to),
    ctx.db
      .prepare(
        `WITH ${launches}, x AS MATERIALIZED (
           SELECT p.id, p.amount, p.kind, p.visitor_id, s.source, s.referrer_domain, s.ref
           FROM payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
           WHERE p.currency = (SELECT currency FROM sites WHERE id = p.site_id) AND p.site_id = ? AND p.ts >= ? AND p.ts < ?)
         SELECT l.id, SUM(x.amount) AS revenue, COUNT(DISTINCT CASE WHEN x.kind = 'payment' THEN COALESCE(x.visitor_id, x.id) END) AS customers
         FROM launches l JOIN x ON ${matches} GROUP BY l.id`,
      )
      .bind(ctx.site.id, ctx.site.id, from, to),
  ]);
  const visitors = new Map((v.results as { id: string; visitors: number }[]).map((row) => [row.id, row.visitors]));
  const money = new Map((r.results as { id: string; revenue: number; customers: number }[]).map((row) => [row.id, row]));
  return rows.map((p) => ({ ...publicPlacement(p), visitors: visitors.get(p.id) ?? 0, customers: money.get(p.id)?.customers ?? 0, revenue: money.get(p.id)?.revenue ?? 0 }));
}

// ---------------------------------------------------------------- verification

export const USER_AGENT = 'DataMonster-ListingCheck/1.0 (+https://datamonster.dev; checks that a launch listing is still up)';
const BODY_MAX = 1_000_000;
const MAX_REDIRECTS = 4;

export interface CheckOptions {
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ListingCheck {
  result: CheckResult;
  detail: string;
  /** The URL that answered last, after redirects. */
  final_url: string;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const left = BODY_MAX - size;
    size += value.byteLength;
    text += decoder.decode(value.byteLength > left ? value.subarray(0, left) : value, { stream: true });
    if (size >= BODY_MAX) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return text + decoder.decode();
}

const HIDDEN = ['script', 'style', 'noscript', 'template', 'svg'];

/** The page's text without tags or hidden elements. One pass, so a hostile page can't make it slow (no backtracking). */
export function visibleText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const noCloser = new Set<string>();
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) {
      out.push(html.slice(at));
      break;
    }
    out.push(html.slice(at, open), ' ');
    const hidden = HIDDEN.find((t) => lower.startsWith(t, open + 1) && !/[\w-]/.test(lower[open + 1 + t.length] ?? ''));
    // The closing tag is searched for once per name: if it isn't further on, it never will be.
    const close = hidden && !noCloser.has(hidden) ? lower.indexOf(`</${hidden}`, open) : -1;
    if (hidden && close < 0) noCloser.add(hidden);
    const end = html.indexOf('>', close < 0 ? open : close);
    if (end < 0) break;
    at = end + 1;
  }
  return out.join('').replace(/&[a-z#0-9]{1,32};/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** Whether `html` names the site: its domain anywhere (links included), or its name in the visible text. */
export function mentionsSite(html: string, site: Pick<Site, 'domain' | 'name'>): boolean {
  const lower = html.toLowerCase();
  const domain = site.domain.toLowerCase();
  if (domain && lower.includes(domain)) return true;
  const name = site.name.trim().toLowerCase();
  if (name.length < 3 || name === domain) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u');
  return re.test(visibleText(html).toLowerCase());
}

/**
 * Fetches a listing page and decides whether the site is still listed:
 * - 2xx and the page names the site: ok
 * - 404 or 410, or a redirect from the listing to the directory's home page: missing
 * - 2xx without the site's name on a page that needs JavaScript or is not HTML: unknown (never "missing")
 * - anything else (other statuses, timeouts, too many redirects, a redirect to a disallowed host): error
 * Redirects are followed by hand, and every hop must pass urlProblem, so a public listing can't bounce the Worker
 * to a private address. No cookies or credentials are sent (the Worker has none for these sites).
 */
export async function checkListing(listingUrl: string, site: Pick<Site, 'domain' | 'name'>, opts: CheckOptions = {}): Promise<ListingCheck> {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  const first = new URL(listingUrl);
  let url = first;
  for (let hop = 0; ; hop++) {
    const problem = urlProblem(url);
    if (problem) {
      return { result: 'error', detail: hop ? `refused a redirect to ${url.hostname}: it ${problem}` : `the listing URL ${problem}`, final_url: url.toString() };
    }
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      });
    } catch (e) {
      const timedOut = signal.aborted || (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      return { result: 'error', detail: timedOut ? 'timed out' : 'could not connect', final_url: url.toString() };
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) return { result: 'error', detail: 'too many redirects', final_url: url.toString() };
      try {
        url = new URL(location, url);
      } catch {
        return { result: 'error', detail: 'redirected to an invalid URL', final_url: url.toString() };
      }
      continue;
    }
    const final_url = url.toString();
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      return { result: 'missing', detail: `HTTP ${res.status}`, final_url };
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { result: 'error', detail: `HTTP ${res.status}`, final_url };
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type && !type.includes('html') && !type.startsWith('text/')) {
      await res.body?.cancel().catch(() => {});
      return { result: 'unknown', detail: 'not an HTML page', final_url };
    }
    let html: string;
    try {
      html = await readCapped(res);
    } catch {
      return { result: 'error', detail: signal.aborted ? 'timed out' : 'could not read the page', final_url };
    }
    if (mentionsSite(html, site)) return { result: 'ok', detail: `the page mentions ${site.domain}`, final_url };
    // Bounced from a listing path to the directory's front page: the listing is gone.
    if (hop > 0 && first.pathname !== '/' && (url.pathname === '/' || url.pathname === '')) {
      return { result: 'missing', detail: `the listing now redirects to ${url.hostname}/`, final_url };
    }
    if (visibleText(html).length < 400) return { result: 'unknown', detail: 'the page needs JavaScript to show its content', final_url };
    return { result: 'unknown', detail: `the page loads but does not mention ${site.domain}`, final_url };
  }
}

/** The status a check moves a placement to: a confirmed listing is live; nothing else changes the status. */
export function statusAfterCheck(status: PlacementStatus, result: CheckResult): PlacementStatus {
  if (result === 'ok' && (status === 'draft' || status === 'submitted' || status === 'in_review' || status === 'removed')) return 'live';
  return status;
}

// Each launch has its own pause (RECHECK_AFTER_MS), and a website up to 100 launches: this is the pause for all of them.
const checksPerOwner = memoryLimiter(20, 60_000);
/** Before a check someone asks for. The hourly job has its own pace. */
export function checkAllowed(site: Site) {
  if (!checksPerOwner(site.owner_id ?? site.id)) throw new ToolError('Too many listing checks. Try again in a minute.', 429);
}

/**
 * Checks a placement's listing now and stores the result. A placement checked in the last minute is not fetched
 * again (checked: false), so repeated calls can't turn the Worker into a crawler.
 */
export async function verifyPlacement(
  db: D1Database,
  site: Site,
  p: Placement,
  opts: CheckOptions & { now?: number } = {},
): Promise<{ checked: boolean; placement: ReturnType<typeof publicPlacement>; check: ListingCheck | null }> {
  const now = opts.now ?? Date.now();
  if (!p.listing_url) throw new ToolError('this launch has no listing_url to check; add one with update first');
  if (p.archived_at) throw new ToolError('this launch is archived');
  if (p.last_checked_at && now - p.last_checked_at < RECHECK_AFTER_MS) return { checked: false, placement: publicPlacement(p), check: null };

  // Recorded before fetching: a page that stops the check can't come first again next time, and two calls at once make one check.
  const claimed = await db
    .prepare('UPDATE placements SET last_attempt_at = ? WHERE id = ? AND site_id = ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?)')
    .bind(now, p.id, site.id, now - RECHECK_AFTER_MS)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return { checked: false, placement: publicPlacement(p), check: null };

  const check = await checkListing(p.listing_url, site, opts);
  const status = statusAfterCheck(p.status, check.result);
  const launched_on = status === 'live' && !p.launched_on ? siteToday(site, now) : p.launched_on;
  const detail = check.detail.slice(0, 200);
  await db
    .prepare(
      `UPDATE placements SET last_checked_at = ?, last_check_result = ?, last_check_detail = ?, status = ?, launched_on = ?
       WHERE id = ? AND site_id = ?`,
    )
    .bind(now, check.result, detail, status, launched_on, p.id, site.id)
    .run();
  const next: Placement = { ...p, last_checked_at: now, last_check_result: check.result, last_check_detail: detail, status, launched_on };
  return { checked: true, placement: publicPlacement(next), check };
}
