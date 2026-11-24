import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { bucketLabels, bucketSql, resolveRange, tzOffset, type Range } from './lib/time';
import { currencyDecimals } from './payments';

/** Filters that live on the session row (clicking a row in the dashboard adds one of these). */
const SESSION_FILTERS = [
  'channel',
  'source',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'entry_page',
  'exit_page',
  'hostname',
] as const;

export type Filters = Partial<Record<(typeof SESSION_FILTERS)[number] | 'page' | 'goal', string>>;

export function parseFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Filters = {};
    for (const k of [...SESSION_FILTERS, 'page', 'goal'] as const) {
      if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 500);
    }
    return out;
  } catch {
    return {};
  }
}

/** SQL + params restricting sessions `s` by the dashboard filters (not by time). */
function filterSql(f: Filters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const k of SESSION_FILTERS) {
    const v = f[k];
    if (v === undefined) continue;
    if (v === '') parts.push(`s.${k} IS NULL`);
    else {
      parts.push(`s.${k} = ?`);
      params.push(v);
    }
  }
  if (f.page) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'pageview' AND fe.path = ?)`);
    params.push(f.page);
  }
  if (f.goal) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'goal' AND fe.name = ?)`);
    params.push(f.goal);
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

const hasFilters = (f: Filters) => Object.keys(f).length > 0;

export interface Ctx {
  db: D1Database;
  site: Site;
  range: Range;
  filters: Filters;
  offset: number;
}

export function makeCtx(c: Context<AppEnv>): Ctx {
  const site = c.get('site');
  const q = c.req.query();
  const range = resolveRange(q, site.timezone, site.created_at);
  return { db: c.env.DB, site, range, filters: parseFilters(q.filters), offset: tzOffset(site.timezone, range.to) };
}

function sessionsWhere(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  const f = filterSql(ctx.filters);
  return {
    sql: `s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

/** Payments in the period; with filters, only those credited to a matching visit. */
function paymentsFrom(ctx: Ctx, from = ctx.range.from, to = ctx.range.to, other = false) {
  const currencyFilter = other ? "p.currency != (SELECT currency FROM sites WHERE id = p.site_id)" : "p.currency = (SELECT currency FROM sites WHERE id = p.site_id)";
  if (!hasFilters(ctx.filters)) {
    return { sql: `payments p WHERE p.site_id = ? AND ${currencyFilter} AND p.ts >= ? AND p.ts < ?`, params: [ctx.site.id, from, to] };
  }
  const f = filterSql(ctx.filters);
  return {
    sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
          WHERE p.site_id = ? AND ${currencyFilter} AND p.ts >= ? AND p.ts < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

const KPI_SQL = (where: string) => `
  SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
         COALESCE(SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END), 0) AS bounces,
         COALESCE(AVG(s.duration), 0) AS avg_duration
  FROM sessions s WHERE ${where}`;

const REVENUE_SQL = (from: string) => `
  SELECT COALESCE(SUM(p.amount), 0) AS revenue,
         COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.id) END) AS customers,
         COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END), 0) AS payments
  FROM ${from}`;

interface KpiRow {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  avg_duration: number;
}
interface RevRow {
  revenue: number;
  customers: number;
  payments: number;
}

function kpis(k: KpiRow, r: RevRow) {
  return {
    visitors: k.visitors,
    sessions: k.sessions,
    pageviews: k.pageviews,
    bounceRate: k.sessions ? k.bounces / k.sessions : 0,
    avgDuration: Math.round(k.avg_duration),
    revenue: r.revenue,
    payments: r.payments,
    customers: r.customers,
    conversionRate: k.visitors ? r.customers / k.visitors : 0,
    revenuePerVisitor: k.visitors ? r.revenue / k.visitors : 0,
  };
}

/** Top numbers + chart. */
export async function overview(ctx: Ctx) {
  const { db, range, site } = ctx;
  const prevFrom = range.from - (range.to - range.from);
  const cur = sessionsWhere(ctx);
  const prev = sessionsWhere(ctx, prevFrom, range.from);
  const curPay = paymentsFrom(ctx);
  const prevPay = paymentsFrom(ctx, prevFrom, range.from);
  const sb = bucketSql('s.started_at', range.granularity, ctx.offset);
  const pb = bucketSql('p.ts', range.granularity, ctx.offset);
  const now = Date.now();

  const [k1, k0, r1, r0, online, ts, tr] = await db.batch([
    db.prepare(KPI_SQL(cur.sql)).bind(...cur.params),
    db.prepare(KPI_SQL(prev.sql)).bind(...prev.params),
    db.prepare(REVENUE_SQL(curPay.sql)).bind(...curPay.params),
    db.prepare(REVENUE_SQL(prevPay.sql)).bind(...prevPay.params),
    db
      .prepare('SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND last_seen_at > ?')
      .bind(site.id, now - 6 * 3_600_000, now - 5 * 60_000),
    db
      .prepare(
        `SELECT ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews
         FROM sessions s WHERE ${cur.sql} GROUP BY b`,
      )
      .bind(...cur.params),
    db
      .prepare(
        `SELECT ${pb} AS b, SUM(p.amount) AS revenue, SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS payments
         FROM ${curPay.sql} GROUP BY b`,
      )
      .bind(...curPay.params),
  ]);

  const excluded = paymentsFrom(ctx, range.from, range.to, true);
  const other = await db.prepare(`SELECT p.currency, SUM(p.amount) AS amount,
    SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS payments FROM ${excluded.sql} GROUP BY p.currency ORDER BY p.currency`).bind(...excluded.params).all<{currency: string; amount: number; payments: number}>();
  const visitorsBy = new Map((ts.results as any[]).map((r) => [r.b, r]));
  const revenueBy = new Map((tr.results as any[]).map((r) => [r.b, r]));
  const labels = bucketLabels(range, ctx.offset);
  const series = labels.map((b) => ({
    bucket: b,
    visitors: visitorsBy.get(b)?.visitors ?? 0,
    pageviews: visitorsBy.get(b)?.pageviews ?? 0,
    revenue: revenueBy.get(b)?.revenue ?? 0,
    payments: revenueBy.get(b)?.payments ?? 0,
  }));

  return {
    range,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    other_currencies: other.results,
    other_currency_payments: other.results.reduce((n, row) => n + row.payments, 0),
    current: kpis(k1.results[0] as KpiRow, r1.results[0] as RevRow),
    previous: kpis(k0.results[0] as KpiRow, r0.results[0] as RevRow),
    online: (online.results[0] as { n: number }).n,
    series,
  };
}

/** Session dimensions, keyed by the name the dashboard asks for. */
const SESSION_DIMS: Record<string, string> = {
  channel: 's.channel',
  source: 's.source',
  campaign: 's.utm_campaign',
  keyword: 's.utm_term',
  utm_source: 's.utm_source',
  utm_medium: 's.utm_medium',
  utm_content: 's.utm_content',
  ref: 's.ref',
  country: 's.country',
  region: 's.region',
  city: 's.city',
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  entry_page: 's.entry_page',
  exit_page: 's.exit_page',
  hostname: 's.hostname',
  referrer: 's.referrer',
};

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  icon?: string | null;
  extra?: string | null;
}

export async function breakdown(ctx: Ctx, dim: string, limit = 100): Promise<BreakdownRow[]> {
  const { db } = ctx;
  const lim = Math.max(1, Math.min(500, Math.trunc(limit) || 100));

  if (Object.hasOwn(SESSION_DIMS, dim)) {
    const col = SESSION_DIMS[dim];
    const w = sessionsWhere(ctx);
    const pay = paymentsFrom(ctx);
    // Payments need the session columns even without filters.
    const payJoin = hasFilters(ctx.filters)
      ? pay
      : {
          sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id WHERE p.site_id = ? AND p.currency = (SELECT currency FROM sites WHERE id = p.site_id) AND p.ts >= ? AND p.ts < ?`,
          params: pay.params,
        };
    const extraCol =
      dim === 'source' ? 'MAX(s.referrer_domain)' : dim === 'region' || dim === 'city' ? 'MAX(s.country)' : 'NULL';
    const visits = db
      .prepare(
        `SELECT ${col} AS label, COUNT(DISTINCT s.visitor_id) AS visitors, SUM(s.pageviews) AS pageviews, ${extraCol} AS extra
         FROM sessions s WHERE ${w.sql} GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
      )
      .bind(...w.params);
    return withRevenue(db, visits, {
      sql: `SELECT ${col} AS label, SUM(p.amount) AS revenue,
                   COUNT(DISTINCT CASE WHEN p.kind = 'payment' THEN COALESCE(p.visitor_id, p.id) END) AS customers
            FROM ${payJoin.sql} GROUP BY label`,
      params: payJoin.params,
    }, lim);
  }

  if (dim === 'page') {
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const visits = db
      .prepare(
        `SELECT e.path AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
         GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
      )
      .bind(...params);
    // Revenue from customers who viewed the page during the period.
    return withRevenue(db, visits, {
      sql: `SELECT pv.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
            FROM (SELECT DISTINCT e.path AS label, e.visitor_id ${base}) pv
            JOIN payments p ON p.site_id = ? AND p.currency = (SELECT currency FROM sites WHERE id = p.site_id) AND p.visitor_id = pv.visitor_id AND p.ts >= ? AND p.ts < ?
            GROUP BY pv.label`,
      params: [...params, ctx.site.id, ctx.range.from, ctx.range.to],
    }, lim);
  }

  if (dim === 'exit_link' || dim === 'goal') {
    const type = dim === 'goal' ? 'goal' : 'outbound';
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, type, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = ? AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const visits = db
      .prepare(
        `SELECT e.name AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
         GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
      )
      .bind(...params);
    return withRevenue(db, visits, {
      sql: `SELECT g.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
            FROM (SELECT DISTINCT e.name AS label, e.visitor_id ${base}) g
            JOIN payments p ON p.site_id = ? AND p.currency = (SELECT currency FROM sites WHERE id = p.site_id) AND p.visitor_id = g.visitor_id AND p.ts >= ? AND p.ts < ?
            GROUP BY g.label`,
      params: [...params, ctx.site.id, ctx.range.from, ctx.range.to],
    }, lim);
  }

  throw new Error(`unknown dimension ${dim}`);
}

/** Runs a breakdown's visits and revenue queries. At most `lim` rows come back, and every visits row has its revenue. */
async function withRevenue(db: D1Database, visits: D1PreparedStatement, rev: { sql: string; params: unknown[] }, lim: number): Promise<BreakdownRow[]> {
  const [v, top] = await db.batch([visits, db.prepare(`SELECT * FROM (${rev.sql}) ORDER BY revenue DESC LIMIT ${lim}`).bind(...rev.params)]);
  const revenue = top.results as any[];
  const labels = (v.results as any[]).map((x) => x.label);
  const known = new Set(revenue.map((x) => x.label));
  if (revenue.length === lim && labels.some((l) => !known.has(l))) {
    // More labels earned money than fit: fetch the ones the visits list needs.
    const more = await db
      .prepare(`SELECT * FROM (${rev.sql}) WHERE label IN (SELECT value FROM json_each(?))${labels.includes(null) ? ' OR label IS NULL' : ''}`)
      .bind(...rev.params, JSON.stringify(labels.filter((l) => l !== null)))
      .all<any>();
    for (const x of more.results) if (!known.has(x.label)) revenue.push(x);
  }
  const rows = merge(v.results as any[], revenue);
  if (rows.length <= lim) return rows;
  // Over the limit: the top earners keep up to half the places, and the most visited fill the rest.
  const keep = new Set([...rows].filter((x) => x.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, Math.ceil(lim / 2)));
  for (const x of rows) if (keep.size < lim) keep.add(x);
  return rows.filter((x) => keep.has(x));
}

function merge(visits: any[], revenue: any[]): BreakdownRow[] {
  const rev = new Map(revenue.map((r) => [r.label, r]));
  const rows: BreakdownRow[] = visits.map((v) => ({
    label: v.label,
    visitors: v.visitors,
    pageviews: v.pageviews ?? undefined,
    revenue: rev.get(v.label)?.revenue ?? 0,
    customers: rev.get(v.label)?.customers ?? 0,
    extra: v.extra ?? null,
  }));
  // Sources that made money but had no visits in this period (paid later) still show up.
  const seen = new Set(visits.map((v) => v.label));
  for (const r of revenue) if (!seen.has(r.label)) rows.push({ label: r.label, visitors: 0, revenue: r.revenue, customers: r.customers });
  return rows;
}

/** Customers in the period, with where they came from (the "Journey" tab). */
export async function customers(ctx: Ctx) {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN' : 'LEFT JOIN';
  const res = await db
    .prepare(
      `SELECT p.id, p.ts, p.amount, p.currency, p.renewal, p.matched_by, p.email AS pay_email, p.name AS pay_name, p.visitor_id, p.session_id,
              v.first_seen, v.name, v.email, v.user_id,
              s.source, s.channel, s.referrer_domain, s.utm_campaign, s.ref, s.country, s.city, s.device, s.os, s.browser, s.entry_page,
              (SELECT COUNT(*) FROM sessions s2 WHERE s2.site_id = p.site_id AND s2.visitor_id = p.visitor_id AND s2.started_at <= p.ts) AS visits
       FROM payments p
       LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
       ${join} sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.site_id = ? AND p.kind = 'payment' AND p.ts >= ? AND p.ts < ?${f.sql}
       ORDER BY p.ts DESC LIMIT 200`,
    )
    .bind(site.id, range.from, range.to, ...f.params)
    .all();
  return res.results;
}

/** Recent visitors in the period (the "Users" tab). */
export async function visitors(ctx: Ctx) {
  const w = sessionsWhere(ctx);
  const res = await ctx.db
    .prepare(
      `SELECT t.*, v.name, v.email, v.user_id, v.first_seen,
              (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = t.site_id AND p.currency = (SELECT currency FROM sites WHERE id = p.site_id) AND p.visitor_id = t.visitor_id) AS spent
       FROM (
         SELECT s.site_id, s.visitor_id, MAX(s.last_seen_at) AS last_seen, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
                SUM(s.duration) AS duration, s.source, s.referrer_domain, s.country, s.city, s.device, s.os, s.browser
         FROM sessions s WHERE ${w.sql} GROUP BY s.visitor_id ORDER BY last_seen DESC LIMIT 200
       ) t LEFT JOIN visitors v ON v.site_id = t.site_id AND v.id = t.visitor_id
       ORDER BY t.last_seen DESC`,
    )
    .bind(...w.params)
    .all();
  return res.results;
}

/** Everything one visitor did: visits, pages, clicks, payments. */
export async function visitorProfile(db: D1Database, site: Site, vid: string) {
  const [v, s, e, p] = await db.batch([
    db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid),
    db.prepare('SELECT * FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 100').bind(site.id, vid),
    db
      .prepare('SELECT session_id, ts, type, name, path, props FROM events WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC LIMIT 1000')
      .bind(site.id, vid),
    db.prepare('SELECT * FROM payments WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC').bind(site.id, vid),
  ]);
  return {
    visitor: v.results[0] ?? null,
    sessions: s.results,
    events: e.results,
    payments: p.results,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
  };
}

export interface FunnelStep {
  type: 'page' | 'goal' | 'payment';
  value: string; // page paths support * wildcards, e.g. /blog/*; payment supports 'any'/'*' or a product_id
  label?: string;
}

const isAnyPayment = (value: string) => {
  const v = value.trim().toLowerCase();
  return !v || v === 'any' || v === '*' || v === 'paid';
};

/** Visitors who completed each step, in order, within the period, along with their period revenue (site currency). */
/** Matches a path against a pattern where * is any text. Walks the path once per fixed part, so it can't blow up. */
export function pathMatcher(pattern: string): (path: string) => boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return (path) => path === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = parts.slice(1, -1).filter(Boolean);
  return (path) => {
    if (path.length < first.length + last.length || !path.startsWith(first) || !path.endsWith(last)) return false;
    const end = path.length - last.length;
    let at = first.length;
    for (const part of middle) {
      const i = path.indexOf(part, at);
      if (i < 0 || i + part.length > end) return false;
      at = i + part.length;
    }
    return true;
  };
}

export async function funnel(ctx: Ctx, steps: FunnelStep[]) {
  if (!steps.length) return [];
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
  const conds: string[] = [];
  const params: unknown[] = [];
  let hasPaymentStep = false;
  for (const st of steps) {
    if (st.type === 'goal') {
      conds.push(`(e.type = 'goal' AND e.name = ?)`);
      params.push(st.value);
    } else if (st.type === 'page') {
      const star = st.value.indexOf('*');
      if (star < 0) {
        conds.push(`(e.type = 'pageview' AND e.path = ?)`);
        params.push(st.value);
      } else {
        // D1 refuses patterns over 50 bytes: a longer one narrows by its start only. pathMatcher below decides either way.
        const glob = st.value.replace(/\*+/g, '*').replace(/[[?]/g, '[$&]');
        if (new TextEncoder().encode(glob).length <= 50) {
          conds.push(`(e.type = 'pageview' AND e.path GLOB ?)`);
          params.push(glob);
        } else {
          conds.push(`(e.type = 'pageview' AND substr(e.path, 1, ?) = ?)`);
          params.push([...st.value.slice(0, star)].length, st.value.slice(0, star));
        }
      }
    } else if (st.type === 'payment') {
      hasPaymentStep = true;
    }
  }

  const pay = paymentsFrom(ctx);
  const batch: D1PreparedStatement[] = [];
  const eventIdx = conds.length ? batch.length : -1;
  if (conds.length) {
    batch.push(
      ctx.db
        .prepare(
          `SELECT e.visitor_id AS v, e.ts, e.type, e.name, e.path FROM events e ${join}
           WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (${conds.join(' OR ')})${f.sql}
           ORDER BY e.ts LIMIT 100000`,
        )
        .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...params, ...f.params),
    );
  }
  const paymentStepIdx = hasPaymentStep ? batch.length : -1;
  if (hasPaymentStep) {
    batch.push(
      ctx.db
        .prepare(
          `SELECT p.visitor_id AS v, p.ts, p.product_id FROM ${pay.sql} AND p.kind = 'payment' AND p.visitor_id IS NOT NULL
           ORDER BY p.ts LIMIT 100000`,
        )
        .bind(...pay.params),
    );
  }
  const revenueIdx = batch.length;
  batch.push(
    ctx.db
      .prepare(
        `SELECT p.visitor_id AS v, COALESCE(SUM(p.amount), 0) AS revenue FROM ${pay.sql} AND p.visitor_id IS NOT NULL
         GROUP BY p.visitor_id`,
      )
      .bind(...pay.params),
  );

  const results = await ctx.db.batch(batch);
  type TimelineRow = { v: string; ts: number; order: number; type: string; name: string | null; path: string | null; product_id: string | null };
  const timeline: TimelineRow[] = [];
  if (eventIdx >= 0) {
    for (const r of results[eventIdx].results as { v: string; ts: number; type: string; name: string | null; path: string }[]) {
      timeline.push({ v: r.v, ts: r.ts, order: 0, type: r.type, name: r.name, path: r.path, product_id: null });
    }
  }
  if (paymentStepIdx >= 0) {
    for (const r of results[paymentStepIdx].results as { v: string; ts: number; product_id: string | null }[]) {
      timeline.push({ v: r.v, ts: r.ts, order: 1, type: 'payment', name: null, path: null, product_id: r.product_id });
    }
  }
  if (eventIdx >= 0 && paymentStepIdx >= 0) {
    timeline.sort((a, b) => a.ts - b.ts || a.order - b.order);
  }

  const revByVisitor = new Map<string, number>();
  for (const r of results[revenueIdx].results as { v: string; revenue: number }[]) {
    revByVisitor.set(r.v, Number(r.revenue) || 0);
  }

  const matchers = steps.map((st) => {
    if (st.type === 'goal') return (r: TimelineRow) => r.type === 'goal' && r.name === st.value;
    if (st.type === 'payment') {
      const any = isAnyPayment(st.value);
      return (r: TimelineRow) => r.type === 'payment' && (any || r.product_id === st.value);
    }
    const matches = pathMatcher(st.value);
    return (r: TimelineRow) => r.type === 'pageview' && r.path !== null && matches(r.path);
  });
  const progress = new Map<string, number>();
  for (const r of timeline) {
    const at = progress.get(r.v) ?? 0;
    if (at < steps.length && matchers[at](r)) progress.set(r.v, at + 1);
  }
  const counts = steps.map(() => 0);
  const revenues = steps.map(() => 0);
  for (const [v, reached] of progress.entries()) {
    const rev = revByVisitor.get(v) ?? 0;
    for (let i = 0; i < reached; i++) {
      counts[i]++;
      revenues[i] += rev;
    }
  }
  return steps.map((st, i) => ({ ...st, visitors: counts[i], revenue: revenues[i] }));
}

/** How far back the live view looks: who is "here now", and how much activity it lists. */
export const REALTIME_WINDOWS = { activeMs: 5 * 60_000, sessionMaxMs: 6 * 3_600_000, feedMs: 30 * 60_000 } as const;
/** The most rows each list returns. Counts and totals are exact whatever these are. */
export const REALTIME_LIMITS = { visitors: 500, events: 100, payments: 50 } as const;

/**
 * Everything the live map needs: who is on the site right now, and what happened in the last 30 minutes.
 * The lists are capped (REALTIME_LIMITS); the counts and payment totals beside them are exact, and each list says
 * whether it was cut short, so a screen never sums a capped list into a headline figure.
 */
export async function realtime(db: D1Database, site: Site, now = Date.now()) {
  const { activeMs, sessionMaxMs, feedMs } = REALTIME_WINDOWS;
  const L = REALTIME_LIMITS;
  const activeSince = now - activeMs;
  const sessionSince = now - sessionMaxMs;
  const feedSince = now - feedMs;
  const siteCurrency = `(SELECT currency FROM sites WHERE id = p.site_id)`;
  const [visitors, counts, events, payments, sums, others] = await db.batch([
    db
      .prepare(
        `SELECT s.visitor_id, s.id AS session_id, s.lat, s.lon, s.country, s.region, s.city, s.device, s.browser, s.os,
                s.source, s.referrer_domain, s.exit_page AS page, s.started_at, s.last_seen_at, s.pageviews,
                v.name, v.email,
                (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = s.site_id AND p.currency = ${siteCurrency} AND p.visitor_id = s.visitor_id) AS spent
         FROM sessions s LEFT JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE s.site_id = ? AND s.started_at > ? AND s.last_seen_at > ?
         ORDER BY s.last_seen_at DESC LIMIT ${L.visitors}`,
      )
      .bind(site.id, sessionSince, activeSince),
    // Exact counts over every active visitor (their most recent session, as in the list), not just the listed ones.
    db
      .prepare(
        `WITH a AS (
           SELECT visitor_id, country, lat, lon, ROW_NUMBER() OVER (PARTITION BY visitor_id ORDER BY last_seen_at DESC) AS rn
           FROM sessions WHERE site_id = ? AND started_at > ? AND last_seen_at > ?
         )
         SELECT COUNT(*) AS visitors,
                COUNT(DISTINCT CASE WHEN country IS NOT NULL AND country NOT IN ('XX', 'T1') THEN country END) AS countries,
                COALESCE(SUM(CASE WHEN lat IS NULL OR lon IS NULL THEN 1 ELSE 0 END), 0) AS unlocated
         FROM a WHERE rn = 1`,
      )
      .bind(site.id, sessionSince, activeSince),
    db
      .prepare(
        `SELECT e.id, e.ts, e.type, e.name, e.path, e.visitor_id, s.country, s.city, s.lat, s.lon, v.name AS vname, v.email AS vemail
         FROM events e
         LEFT JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
         LEFT JOIN visitors v ON v.site_id = e.site_id AND v.id = e.visitor_id
         WHERE e.site_id = ? AND e.ts > ? AND e.type IN ('pageview', 'goal')
         ORDER BY e.ts DESC LIMIT ${L.events + 1}`,
      )
      .bind(site.id, feedSince),
    // A payment's place is the session it was attributed to, never the buyer's later, unrelated visit.
    db
      .prepare(
        `SELECT p.id, p.ts, p.amount, p.kind, p.visitor_id, p.name, p.email, s.country, s.city, s.lat, s.lon
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE p.site_id = ? AND p.currency = ${siteCurrency} AND p.ts > ?
         ORDER BY p.ts DESC LIMIT ${L.payments + 1}`,
      )
      .bind(site.id, feedSince),
    db
      .prepare(
        `SELECT p.kind, COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS amount FROM payments p
         WHERE p.site_id = ? AND p.currency = ${siteCurrency} AND p.ts > ? GROUP BY p.kind`,
      )
      .bind(site.id, feedSince),
    // Payments in other currencies are left out of the figures above (no conversion) and named instead.
    db
      .prepare(
        `SELECT p.currency, COUNT(*) AS payments, COALESCE(SUM(p.amount), 0) AS amount FROM payments p
         WHERE p.site_id = ? AND p.currency <> ${siteCurrency} AND p.ts > ? GROUP BY p.currency ORDER BY payments DESC, p.currency`,
      )
      .bind(site.id, feedSince),
  ]);

  // One row per visitor (their most recent visit).
  const seen = new Set<string>();
  const active = (visitors.results as any[]).filter((v) => !seen.has(v.visitor_id) && seen.add(v.visitor_id));
  const c = (counts.results as any[])[0] ?? { visitors: 0, countries: 0, unlocated: 0 };
  const eventRows = (events.results as any[]).slice(0, L.events);
  const paymentRows = (payments.results as any[]).slice(0, L.payments);

  const feed = [
    ...eventRows.map((e) => ({
      id: `e${e.id}`,
      ts: e.ts,
      type: e.type as 'pageview' | 'goal',
      label: e.type === 'goal' ? e.name : e.path,
      visitor_id: e.visitor_id,
      name: e.vname ?? null,
      email: e.vemail ?? null,
      country: e.country,
      city: e.city ?? null,
      lat: e.lat,
      lon: e.lon,
    })),
    ...paymentRows.map((p) => ({
      id: `p${p.id}`,
      ts: p.ts,
      type: (p.kind === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
      amount: p.amount,
      visitor_id: p.visitor_id,
      name: p.name ?? null,
      email: p.email ?? null,
      country: p.country ?? null,
      city: p.city ?? null,
      lat: p.lat ?? null,
      lon: p.lon ?? null,
    })),
  ].sort((a, b) => b.ts - a.ts);

  const byKind = new Map((sums.results as any[]).map((r) => [r.kind, r as { n: number; amount: number }]));
  const paid = byKind.get('payment') ?? { n: 0, amount: 0 };
  const refunded = byKind.get('refund') ?? { n: 0, amount: 0 };

  return {
    now,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    domain: site.domain,
    window: { active_ms: activeMs, feed_ms: feedMs, active_since: activeSince, feed_since: feedSince },
    /** Exact, over every active visitor. */
    active: { visitors: Number(c.visitors) || 0, countries: Number(c.countries) || 0, unlocated: Number(c.unlocated) || 0 },
    /** Exact payment figures for the feed window, in the site's currency, minor units. Refunds are positive here. */
    payments: {
      count: paid.n,
      amount: paid.amount,
      refunds: refunded.n,
      refunded: Math.abs(refunded.amount),
      net: paid.amount + refunded.amount,
    },
    other_currencies: others.results as { currency: string; payments: number; amount: number }[],
    truncated: {
      visitors: Number(c.visitors) > active.length,
      events: (events.results as any[]).length > L.events,
      payments: (payments.results as any[]).length > L.payments,
    },
    visitors: active,
    feed,
  };
}

/** Sparkline sizes for the all-websites view: [range, bucket count]. Rolling windows, so no timezone maths. */
const SPARK_PERIODS: Record<string, [number, number]> = {
  '24h': [86_400_000, 24],
  '7d': [7 * 86_400_000, 28],
  '30d': [30 * 86_400_000, 30],
  '90d': [90 * 86_400_000, 45],
};

export interface SiteSpark {
  id: string;
  visitors: number;
  revenue: number;
  online: number;
  series: { visitors: number; revenue: number }[];
}

/** Totals and a small visitors/revenue series for every site the user can see, in one round trip. */
export async function sparklines(db: D1Database, siteIds: string[], period: string, now = Date.now()): Promise<SiteSpark[]> {
  if (!siteIds.length) return [];
  // D1 allows 100 bound parameters per statement.
  if (siteIds.length > 90) {
    const chunks = [];
    for (let i = 0; i < siteIds.length; i += 90) chunks.push(sparklines(db, siteIds.slice(i, i + 90), period, now));
    return (await Promise.all(chunks)).flat();
  }
  const [span, n] = SPARK_PERIODS[period] ?? SPARK_PERIODS['30d'];
  const width = span / n;
  const from = now - span;
  const ids = siteIds.map(() => '?').join(', ');
  const bucket = (col: string) => `MIN(${n - 1}, CAST((${col} - ${from}) / ${width} AS INTEGER))`;

  const [totals, pay, online, vs, rs] = await db.batch([
    db
      .prepare(`SELECT site_id, COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id IN (${ids}) AND started_at >= ? GROUP BY site_id`)
      .bind(...siteIds, from),
    db.prepare(`SELECT site_id, SUM(amount) AS r FROM payments WHERE currency = (SELECT currency FROM sites WHERE id = payments.site_id) AND site_id IN (${ids}) AND ts >= ? GROUP BY site_id`).bind(...siteIds, from),
    db
      .prepare(
        `SELECT site_id, COUNT(DISTINCT visitor_id) AS n FROM sessions
         WHERE site_id IN (${ids}) AND started_at > ? AND last_seen_at > ? GROUP BY site_id`,
      )
      .bind(...siteIds, now - 6 * 3_600_000, now - 5 * 60_000),
    db
      .prepare(
        `SELECT site_id, ${bucket('started_at')} AS b, COUNT(DISTINCT visitor_id) AS v FROM sessions
         WHERE site_id IN (${ids}) AND started_at >= ? GROUP BY site_id, b`,
      )
      .bind(...siteIds, from),
    db
      .prepare(`SELECT site_id, ${bucket('ts')} AS b, SUM(amount) AS r FROM payments WHERE currency = (SELECT currency FROM sites WHERE id = payments.site_id) AND site_id IN (${ids}) AND ts >= ? GROUP BY site_id, b`)
      .bind(...siteIds, from),
  ]);

  const byId = (rows: unknown[], field: string) => new Map((rows as any[]).map((r) => [r.site_id, r[field] as number]));
  const v = byId(totals.results, 'v');
  const r = byId(pay.results, 'r');
  const o = byId(online.results, 'n');
  const out = new Map(
    siteIds.map((id) => [
      id,
      { id, visitors: v.get(id) ?? 0, revenue: r.get(id) ?? 0, online: o.get(id) ?? 0, series: Array.from({ length: n }, () => ({ visitors: 0, revenue: 0 })) },
    ]),
  );
  for (const row of vs.results as any[]) out.get(row.site_id)!.series[row.b].visitors = row.v;
  for (const row of rs.results as any[]) out.get(row.site_id)!.series[row.b].revenue = row.r;
  return [...out.values()];
}
