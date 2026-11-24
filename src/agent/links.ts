import type { Site } from '../worker/env';
import { randomId } from '../worker/lib/crypto';
import { tzOffset } from '../worker/lib/time';
import { breakdown, type Ctx } from '../worker/stats';
import { ToolError } from './errors';

/**
 * Tagged links and annotations. Shared by the agent tools (tools.ts) and the owner's dashboard endpoints (index.ts),
 * so both apply the same validation. Callers must already have checked that `site` is visible to them.
 */

export const REF_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
export const MAX_LINKS_PER_SITE = 1000;
export const MAX_ANNOTATIONS_PER_SITE = 5000;
export const ANNOTATION_MAX = 200;
const LABEL_MAX = 100;
const DESTINATION_MAX = 500;

export interface TrackedLink {
  id: string;
  site_id: string;
  ref: string;
  destination: string;
  label: string | null;
  created_by: string;
  created_at: number;
  archived_at: number | null;
}

export interface Annotation {
  id: string;
  site_id: string;
  day: string;
  text: string;
  created_by: string;
  created_at: number;
}

/** Removes control characters (C0, C1) and bidi overrides, collapses whitespace, trims and caps the length. */
export function cleanText(input: unknown, max: number): string {
  return String(input ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

export function cleanRef(input: unknown): string {
  const ref = String(input ?? '').trim().toLowerCase();
  if (!REF_PATTERN.test(ref)) {
    throw new ToolError('ref must be 2-49 characters: lowercase letters, digits and hyphens, starting with a letter or digit (e.g. "ph-launch")');
  }
  return ref;
}

/**
 * Resolves a path ("/pricing?plan=pro") or a full URL on the site's own domain to a canonical https URL.
 * Any other host, scheme, credentials or port is rejected, so a link can never point visitors elsewhere.
 */
export function destinationFor(site: Site, path: unknown): URL {
  const raw = path === undefined || path === null ? '/' : String(path).trim() || '/';
  if (raw.length > DESTINATION_MAX) throw new ToolError(`path is longer than ${DESTINATION_MAX} characters`);
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new ToolError('path contains characters that are not allowed');
  const domain = site.domain.toLowerCase();
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  let url: URL;
  try {
    url = new URL(isAbsolute ? raw : raw.startsWith('/') ? raw : `/${raw}`, `https://${domain}`);
  } catch {
    throw new ToolError('path is not a valid URL or path');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ToolError('path must be an http(s) URL or a path on the site');
  if (url.username || url.password || url.port) throw new ToolError('path must not contain credentials or a port');
  const host = url.hostname.toLowerCase();
  if (host !== domain && host !== `www.${domain}`) throw new ToolError(`path must stay on ${domain}; links to other hosts are not allowed`);
  for (const key of url.searchParams.keys()) {
    if (key === 'ref' || key === 'via') throw new ToolError('path already has a ref parameter; pass the tag as ref instead');
  }
  url.protocol = 'https:';
  return url;
}

/** The URL to share: the destination with ?ref=<ref> added, keeping its own query and fragment as written. */
export function taggedUrl(destination: string, ref: string): string {
  const u = new URL(destination);
  const search = u.search ? `${u.search}&ref=${ref}` : `?ref=${ref}`;
  return `${u.origin}${u.pathname}${search}${u.hash}`;
}

export const publicLink = (l: TrackedLink) => ({ ...l, url: taggedUrl(l.destination, l.ref) });

export async function createLink(
  db: D1Database,
  site: Site,
  input: { ref: unknown; path?: unknown; label?: unknown },
  createdBy: string,
  now = Date.now(),
): Promise<{ created: boolean; link: ReturnType<typeof publicLink> }> {
  const ref = cleanRef(input.ref);
  const destination = destinationFor(site, input.path).toString();
  const label = input.label === undefined || input.label === null ? null : cleanText(input.label, LABEL_MAX) || null;

  const existing = await db.prepare('SELECT * FROM tracked_links WHERE site_id = ? AND ref = ?').bind(site.id, ref).first<TrackedLink>();
  if (existing) return reuse(db, existing, destination);

  const count = await db.prepare('SELECT COUNT(*) AS n FROM tracked_links WHERE site_id = ?').bind(site.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_LINKS_PER_SITE) throw new ToolError(`this site already has ${MAX_LINKS_PER_SITE} links`, 409);

  const id = 'lnk_' + randomId(8);
  const res = await db
    .prepare(
      `INSERT INTO tracked_links (id, site_id, ref, destination, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, ref) DO NOTHING`,
    )
    .bind(id, site.id, ref, destination, label, createdBy, now)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    // Lost a race with an identical request: answer like the second call would have.
    const row = await db.prepare('SELECT * FROM tracked_links WHERE site_id = ? AND ref = ?').bind(site.id, ref).first<TrackedLink>();
    if (row) return reuse(db, row, destination);
  }
  return { created: true, link: publicLink({ id, site_id: site.id, ref, destination, label, created_by: createdBy, created_at: now, archived_at: null }) };
}

/** Same ref and destination: return the link (restoring it if archived). Different destination: a clear error. */
async function reuse(db: D1Database, link: TrackedLink, destination: string) {
  if (link.destination !== destination) {
    throw new ToolError(
      `ref "${link.ref}" already points to ${link.destination}${link.archived_at ? ' (archived)' : ''}. Choose another ref, or use the existing link.`,
      409,
    );
  }
  if (link.archived_at) {
    await db.prepare('UPDATE tracked_links SET archived_at = NULL WHERE id = ?').bind(link.id).run();
    link = { ...link, archived_at: null };
  }
  return { created: false, link: publicLink(link) };
}

export async function archiveLink(db: D1Database, site: Site, linkId: string, now = Date.now()): Promise<boolean> {
  const res = await db
    .prepare('UPDATE tracked_links SET archived_at = ? WHERE id = ? AND site_id = ? AND archived_at IS NULL')
    .bind(now, linkId, site.id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Links with what each brought in over ctx's range: visitors, paying customers and revenue per ref,
 * from the same breakdown query the dashboard uses.
 */
export async function linksWithStats(ctx: Ctx, opts: { includeArchived?: boolean } = {}) {
  const res = await ctx.db
    .prepare(`SELECT * FROM tracked_links WHERE site_id = ?${opts.includeArchived ? '' : ' AND archived_at IS NULL'} ORDER BY created_at DESC`)
    .bind(ctx.site.id)
    .all<TrackedLink>();
  if (!res.results.length) return [];
  const rows = await breakdown(ctx, 'ref', 500);
  const byRef = new Map(rows.map((r) => [r.label, r]));
  return res.results.map((l) => {
    const r = byRef.get(l.ref);
    return { ...publicLink(l), visitors: r?.visitors ?? 0, customers: r?.customers ?? 0, revenue: r?.revenue ?? 0 };
  });
}

// ---------------------------------------------------------------- annotations

export function cleanDay(input: unknown): string {
  const day = String(input ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const ok = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === day;
  if (!ok) throw new ToolError('day must be a real date, YYYY-MM-DD');
  return day;
}

/** Today's date in the site's time zone. */
export const siteToday = (site: Site, now = Date.now()) => new Date(now + tzOffset(site.timezone, now)).toISOString().slice(0, 10);

export async function addAnnotation(
  db: D1Database,
  site: Site,
  input: { day?: unknown; text: unknown },
  createdBy: string,
  now = Date.now(),
): Promise<{ created: boolean; annotation: Annotation }> {
  const day = input.day === undefined || input.day === null || input.day === '' ? siteToday(site, now) : cleanDay(input.day);
  const text = cleanText(input.text, ANNOTATION_MAX);
  if (!text) throw new ToolError('text is required');
  // A retried call must not leave the same note twice.
  const same = await db.prepare('SELECT * FROM annotations WHERE site_id = ? AND day = ? AND text = ?').bind(site.id, day, text).first<Annotation>();
  if (same) return { created: false, annotation: same };
  const count = await db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE site_id = ?').bind(site.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ANNOTATIONS_PER_SITE) throw new ToolError(`this site already has ${MAX_ANNOTATIONS_PER_SITE} annotations`, 409);
  const annotation: Annotation = { id: 'ann_' + randomId(8), site_id: site.id, day, text, created_by: createdBy, created_at: now };
  await db
    .prepare('INSERT INTO annotations (id, site_id, day, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(annotation.id, site.id, day, text, createdBy, now)
    .run();
  return { created: true, annotation };
}

/** Annotations on the days ctx's range covers, in the site's time zone. */
export async function annotationsIn(ctx: Ctx): Promise<Annotation[]> {
  const tz = ctx.site.timezone;
  const day = (ts: number) => new Date(ts + tzOffset(tz, ts)).toISOString().slice(0, 10);
  const res = await ctx.db
    .prepare('SELECT * FROM annotations WHERE site_id = ? AND day >= ? AND day <= ? ORDER BY day, created_at')
    .bind(ctx.site.id, day(ctx.range.from), day(ctx.range.to - 1))
    .all<Annotation>();
  return res.results;
}

export async function deleteAnnotation(db: D1Database, site: Site, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM annotations WHERE id = ? AND site_id = ?').bind(id, site.id).run();
  return (res.meta?.changes ?? 0) > 0;
}
