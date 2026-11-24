import { verifyPlacement, type CheckOptions, type Placement } from '../agent/placements';
import { adminEmails, isHosted } from '../worker/auth';
import type { Env, SiteWithOwner } from '../worker/env';

/** Eight checks x up to five fetches (redirects included) leaves room under the 50-subrequest budget.
 * Hourly runs support 192 checks/day; overdue exposes backlog beyond that capacity. */
export const DAILY_CHECK_CAP = 8;
/** A listing checked more recently than this is skipped. */
export const RECHECK_MS = 20 * 3_600_000;
const PAUSE_MS = 300;

type Due = Placement & { site_json: string };

/**
 * Placements the daily run should check: not archived, live or in review, with a listing URL, and not checked in
 * the last 20 hours. Owners take turns (each one's most overdue first, then each one's second, and so on), so one
 * owner's launches can't push out everyone else's. On a hosted install, the owner's and Pro accounts' launches come first.
 */
export async function duePlacements(env: Env, now: number, cap = DAILY_CHECK_CAP): Promise<{ placement: Placement; site: SiteWithOwner }[]> {
  // How long a launch has waited: since it was last tried, or since it was added. Changing its URL doesn't reset this.
  const waited = 'COALESCE(p.last_attempt_at, p.last_checked_at, p.created_at)';
  const admins = adminEmails(env);
  const first = isHosted(env) ? `(s.owner_id IS NULL OR u.plan_until > ?${admins.length ? ` OR lower(u.email) IN (${admins.map(() => '?').join(', ')})` : ''}) DESC,` : '';
  const res = await env.DB.prepare(
    `SELECT p.*, json_object('id', s.id, 'name', s.name, 'domain', s.domain, 'timezone', s.timezone, 'currency', s.currency,
              'created_at', s.created_at, 'owner_id', s.owner_id, 'owner_email', u.email, 'owner_plan_until', u.plan_until) AS site_json
     FROM placements p JOIN sites s ON s.id = p.site_id LEFT JOIN users u ON u.id = s.owner_id
     WHERE p.archived_at IS NULL AND p.status IN ('live', 'in_review') AND p.listing_url IS NOT NULL
       AND (p.last_checked_at IS NULL OR p.last_checked_at < ?)
     ORDER BY ${first} ROW_NUMBER() OVER (PARTITION BY s.owner_id ORDER BY ${waited}, p.id), ${waited}, p.id
     LIMIT ?`,
  )
    .bind(now - RECHECK_MS, ...(first ? [now, ...admins] : []), cap)
    .all<Due>();
  const out: { placement: Placement; site: SiteWithOwner }[] = [];
  for (const { site_json, ...placement } of res.results) {
    const site = JSON.parse(site_json) as SiteWithOwner;
    out.push({ placement, site });
  }
  return out;
}

/** Builds the job; tests pass a fake fetch, no pause and a small cap. */
export function makeVerifyPlacementsJob(opts: CheckOptions & { cap?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async function verifyPlacements(env: Env, now: number) {
    const due = await duePlacements(env, now, opts.cap ?? DAILY_CHECK_CAP);
    for (let i = 0; i < due.length; i++) {
      if (i) await sleep(opts.pauseMs ?? PAUSE_MS);
      const { placement, site } = due[i];
      try {
        await verifyPlacement(env.DB, site, placement, { fetch: opts.fetch, timeoutMs: opts.timeoutMs, now });
      } catch (e) {
        console.error('placement check failed', placement.id, e);
      }
    }
  };
}

export const verifyPlacementsJob = makeVerifyPlacementsJob();
