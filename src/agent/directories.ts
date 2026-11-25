import { ToolError } from './errors';

/**
 * Places to launch, from a free public list others maintain: https://submitmystartup.com (MIT, see THIRD_PARTY_NOTICES.md).
 * Fetched only when an agent asks, at most once a day, and kept trimmed in D1. The request says nothing about the owner.
 */
export const DIRECTORIES_SITE = 'https://submitmystartup.com/';
export const DIRECTORIES_LIST = 'https://submitmystartup.com/api/v1/directories.json';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const KINDS = ['directory', 'launch', 'gallery', 'review-site', 'profile', 'editorial', 'community', 'app-review', 'beta-testing'];
export const COSTS = ['free', 'free-with-catch', 'paid-only'];
const NEEDS = ['account', 'badge', 'domainEmail', 'engagement', 'phone', 'captcha', 'invitation'];

export interface Directory {
  name: string;
  url: string;
  kind: string | null;
  cost: string | null;
  /** The cheapest paid option, such as "5.99 USD a month". */
  paid_from: string | null;
  /** What the free way asks for. */
  needs: string[];
  checked: string | null;
  details: string;
}

export const DIRECTORY_NOTE =
  "From Where to Submit Your Startup (https://github.com/mmmmingos/where-to-submit-your-startup, MIT). It does not cover every place, such as Product Hunt and Show HN. Facts can be out of date: read each site's own rules and prices first.";

/** The places that work, with only the facts an agent needs. None of the list's free text is passed on. */
export function trimDirectories(data: unknown): Directory[] {
  const rows = (data as { directories?: unknown } | null)?.directories;
  if (!Array.isArray(rows)) return [];
  const out: Directory[] = [];
  for (const d of rows) {
    const f = d?.facts;
    if (f?.state !== 'live' || typeof d.name !== 'string' || !/^https:\/\/[^\s"'<>]{1,300}$/.test(d.url) || !/^[a-z0-9-]{1,80}$/.test(d.id)) continue;
    const paid = f.cost?.cheapestPaid;
    const price = typeof paid?.amount === 'number' && /^[A-Z]{3}$/.test(paid.currency) ? `${paid.amount} ${paid.currency}` : null;
    out.push({
      name: d.name.replace(/\s+/g, ' ').slice(0, 80),
      url: d.url,
      kind: KINDS.includes(f.format) ? f.format : null,
      cost: COSTS.includes(f.cost?.free) ? f.cost.free : null,
      paid_from: price && (/^(day|week|month|year)$/.test(paid.period) ? `${price} a ${paid.period}` : price),
      needs: NEEDS.filter((n) => f.requirements?.[n] === 'required'),
      checked: /^\d{4}-\d\d-\d\d$/.test(d.lastChecked) ? d.lastChecked : null,
      details: `${DIRECTORIES_SITE}#site-${d.id}`,
    });
  }
  return out;
}

async function directories(db: D1Database, now: number): Promise<Directory[]> {
  const row = await db.prepare('SELECT fetched_at, list FROM directory_list WHERE id = 1').first<{ fetched_at: number; list: string }>();
  if (row && now - row.fetched_at < DAY) return JSON.parse(row.list);
  try {
    const r = await fetch(DIRECTORIES_LIST, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const list = r.ok ? trimDirectories(await r.json()) : [];
    if (!list.length) throw new Error(`nothing usable (status ${r.status})`);
    await db
      .prepare('INSERT INTO directory_list (id, fetched_at, list) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, list = excluded.list')
      .bind(now, JSON.stringify(list))
      .run();
    return list;
  } catch (e) {
    console.error('directory list', e);
    if (!row) throw new ToolError(`The list of directories can't be reached right now. It is also at ${DIRECTORIES_SITE}`, 503);
    // The older copy will do. Try again in an hour.
    await db.prepare('UPDATE directory_list SET fetched_at = ? WHERE id = 1').bind(now - DAY + HOUR).run();
    return JSON.parse(row.list);
  }
}

export async function listDirectories(db: D1Database, f: { search?: string; kind?: string; cost?: string; limit: number }, now = Date.now()) {
  const search = f.search?.trim().toLowerCase();
  const found = (await directories(db, now)).filter(
    (d) => (!f.kind || d.kind === f.kind) && (!f.cost || d.cost === f.cost) && (!search || `${d.name}\n${d.url}`.toLowerCase().includes(search)),
  );
  return { directories: found.slice(0, f.limit), total: found.length, note: DIRECTORY_NOTE };
}
