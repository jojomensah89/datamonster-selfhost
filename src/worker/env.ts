export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Dashboard login password (set with `wrangler secret put ADMIN_PASSWORD`). */
  ADMIN_PASSWORD: string;
  /** Random string used to sign the login cookie (`wrangler secret put SESSION_SECRET`). */
  SESSION_SECRET: string;

  // ---- Hosted (SaaS) mode, all optional. Setting HOSTED_MODE or either Google value turns it on.
  /** "true" keeps the install hosted even if the Google values go missing, so it never falls back to single-owner mode. */
  HOSTED_MODE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Comma-separated emails that never pay and own the pre-existing sites. */
  ADMIN_EMAILS?: string;
  /** Polar organization access token with checkouts:write and customer_sessions:write. */
  POLAR_ACCESS_TOKEN?: string;
  /** Polar product id of the monthly plan, so other products in the same organization are ignored. */
  POLAR_PRODUCT_ID?: string;
  /** Signing secret of the Polar webhook pointed at /api/billing/webhook. */
  POLAR_WEBHOOK_SECRET?: string;
  /** "sandbox" while testing; anything else is Polar's live environment. Each has its own token, product and secret. */
  POLAR_ENVIRONMENT?: string;
  /** Shown on the pricing page. Default "$5"; must match the price in Polar. */
  PLAN_PRICE?: string;
  /** Included events per calendar month (UTC) per hosted account. Default 50000. */
  PLAN_EVENT_LIMIT?: string;
  /** Hard ceiling multiplier above PLAN_EVENT_LIMIT before events are dropped. Default 3. */
  PLAN_EVENT_HARD_MULTIPLIER?: string;
  /** Max websites per hosted account. Default 10. */
  PLAN_SITE_LIMIT?: string;
  /** Most events a day taken from one address for one hosted account. Default 8% of PLAN_EVENT_LIMIT. */
  PLAN_ADDRESS_DAILY_LIMIT?: string;
  /** Events per calendar month (UTC) on Free; recording pauses there until the next month. Default 5000. */
  FREE_EVENT_LIMIT?: string;
  /** A public GitHub repository of this code. Set, the pricing section offers its "Deploy to Cloudflare" button. */
  DEPLOY_REPO_URL?: string;
  SUPPORT_EMAIL?: string;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  api_key: string;
  dodo_webhook_secret: string | null;
  created_at: number;
  owner_id?: string | null;
  dodo_product_ids?: string | null;
  stripe_webhook_secret?: string | null;
  /** 1 when the owner serves the script through their own proxy: its location headers may be used, and its address sends for everyone. */
  proxy_location?: number | boolean | null;
  /** JSON; NULL is the default layout (src/shared/dashboardCards.ts). */
  dashboard_cards?: string | null;
}

/** A site plus its owner's plan and how many sites they have, which decide whether it may record. */
export type SiteWithOwner = Site & { owner_email?: string | null; owner_plan_until?: number | null; owner_sites?: number; owner_free_site?: string | null };

/** Selects SiteWithOwner rows; add a WHERE on `s`. */
export const SITE_WITH_OWNER_SQL = `SELECT s.*, u.email AS owner_email, u.plan_until AS owner_plan_until,
    (SELECT COUNT(*) FROM sites o WHERE o.owner_id = s.owner_id) AS owner_sites,
    (SELECT f.id FROM sites f WHERE f.id = u.free_site_id AND f.owner_id = u.id) AS owner_free_site
  FROM sites s LEFT JOIN users u ON u.id = s.owner_id`;

export type AppEnv = { Bindings: Env; Variables: { site: Site; user: import('./auth').User } };

const siteCache = new Map<string, { site: SiteWithOwner; at: number }>();
/** Ids that don't exist, so repeats don't read the database. Kept apart: anyone can make these up. */
const missingCache = new Map<string, number>();
const MAX_CACHED = 2000;
const TTL_MS = 60_000;

function remember<T>(cache: Map<string, T>, id: string, value: T) {
  cache.delete(id);
  // A Map keeps insertion order, so the first key is the oldest.
  while (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(id, value);
}

/** For tests. */
export const cacheSizes = () => ({ sites: siteCache.size, missing: missingCache.size });

/** Sites change rarely; cache them per isolate so ingestion costs one fewer read per event. */
export async function getSite(db: D1Database, id: string): Promise<SiteWithOwner | null> {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  const now = Date.now();
  const hit = siteCache.get(id);
  if (hit && now - hit.at < TTL_MS) return hit.site;
  if (now - (missingCache.get(id) ?? 0) < TTL_MS) return null;
  const site = await db
    .prepare(`${SITE_WITH_OWNER_SQL} WHERE s.id = ?`)
    .bind(id)
    .first<SiteWithOwner>();
  if (site) remember(siteCache, id, { site, at: now });
  else remember(missingCache, id, now);
  return site;
}

export function forgetSite(id: string) {
  siteCache.delete(id);
  missingCache.delete(id);
}

/** After an owner's plan or websites change, theirs must re-check whether they may record events. Nobody else's are touched. */
export function forgetOwnerSites(ownerId: string) {
  for (const [id, { site }] of siteCache) if (site.owner_id === ownerId) siteCache.delete(id);
}

/** For tests. */
export function forgetAllSites() {
  siteCache.clear();
  missingCache.clear();
}
