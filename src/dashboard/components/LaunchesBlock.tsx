import { Capsule } from './Capsule';
import { qs } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtAgo, fmtNumber } from '../lib/format';
import { useApi } from '../lib/useApi';
import { AppLink, BlockError, EmptyRow } from './ui';

/** A launch as the owner endpoints return it (src/agent/placements.ts). */
export interface Launch {
  id: string;
  name: string;
  listing_url: string | null;
  launched_on: string | null;
  status: 'draft' | 'submitted' | 'in_review' | 'live' | 'rejected' | 'removed';
  match_source: string | null;
  match_domain: string | null;
  match_ref: string | null;
  last_checked_at: number | null;
  last_check_result: 'ok' | 'missing' | 'error' | 'unknown' | null;
  last_check_detail: string | null;
  notes: string | null;
  created_by: string;
  archived_at: number | null;
  needs_attention: boolean;
  /** Live or in review with a listing link, and not checked for over 30 hours (src/agent/placements.ts). */
  overdue?: boolean;
  created_at?: number;
  visitors: number;
  customers: number;
  revenue: number;
}

export const STATUS_LABEL: Record<Launch['status'], string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  live: 'Live',
  rejected: 'Rejected',
  removed: 'Removed',
};

const STATUS_PILL: Record<Launch['status'], string> = {
  draft: 'pill',
  submitted: 'pill pill-info',
  in_review: 'pill pill-warn',
  live: 'pill pill-pos',
  rejected: 'pill pill-neg',
  removed: 'pill',
};

/** One status mark per row: a live listing that disappeared says so instead of "Live". */
export function StatusPill({ launch }: { launch: Launch }) {
  if (launch.needs_attention) return <span className="pill pill-neg flex-none">Listing gone</span>;
  return <span className={`${STATUS_PILL[launch.status]} flex-none`}>{STATUS_LABEL[launch.status]}</span>;
}

/** "12 Nov" from YYYY-MM-DD. */
export const fmtDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

/** "31 h" under two days, then "3 days". */
export function fmtSince(ms: number) {
  const h = Math.max(1, Math.floor(ms / 3_600_000));
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}

/**
 * The last check in words: "checked 3 hours ago", "check failed 2 days ago", "not checked yet".
 * A listing the daily check has missed says so ("not checked for 31 h"), in the same quiet ink; only a missing
 * listing gets a warning colour, from its pill.
 */
export function checkWords(l: Launch, now = Date.now()) {
  if (!l.listing_url) return 'no listing link';
  if (l.overdue && l.last_check_result !== 'missing') return `not checked for ${fmtSince(now - (l.last_checked_at ?? l.created_at ?? now))}`;
  if (!l.last_checked_at) return 'not checked yet';
  const ago = `${fmtAgo(now - l.last_checked_at)} ago`;
  if (l.last_check_result === 'missing') return `missing ${ago}`;
  if (l.last_check_result === 'error') return `check failed ${ago}`;
  if (l.last_check_result === 'unknown') return `unconfirmed ${ago}`;
  return `checked ${ago}`;
}

/** Name, status and money (visitors under it): the block sits beside Revenue by source, so it stays narrow. */
const COLS = 'grid grid-cols-[minmax(0,1fr)_auto_88px] gap-3';

/** The Overview's Launches ledger: each place the site launched, its state and what it paid in the period. */
export function LaunchesBlock() {
  const { site, q, reloadKey, money } = useDash();
  const { data, error, loading } = useApi<{ placements: Launch[] }>(`/api/sites/${site.id}/placements?${qs({ ...q, filters: {} })}`, reloadKey);
  const rows = data?.placements ?? [];
  const shown = rows.slice(0, 5);
  const manage = `/launches?site=${site.id}`;

  return (
    <section aria-labelledby="launches-title" className="card v3-contained-card v3-launches min-w-0">
      <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
        <h2 id="launches-title" className="text-base font-semibold">
          Launches
        </h2>
        <AppLink to={manage} className="card-link text-sm">
          {rows.length ? (rows.length > shown.length ? `All ${rows.length} launches` : 'Manage launches') : 'Add a launch'}
        </AppLink>
      </div>
      <div className="v3-contained-body">
        {error && !data && (
          <div className="py-2.5">
            <BlockError what={`Couldn't load launches: ${error}.`} />
          </div>
        )}
        {loading && !data && !error && (
          <div aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 py-2.5">
                <div className="flex-1">
                  <div className="skeleton h-4 w-32" />
                  <div className="skeleton mt-1.5 h-3 w-48" />
                </div>
                <div className="skeleton h-[22px] w-14 rounded-full" />
                <div className="skeleton h-4 w-16" />
              </div>
            ))}
          </div>
        )}
        {data && rows.length === 0 && (
          <div className="py-2.5">
            <EmptyRow>No launches yet. Add a launch to compare its visitors, customers and revenue.</EmptyRow>
          </div>
        )}
        {shown.map((l, i) => {
          const notYet = l.visitors === 0 && l.revenue === 0 && l.status !== 'live';
          return (
            <div key={l.id} className={`${COLS} items-center py-2.5 ${i ? 'border-t border-rule' : ''}`}>
              <div className="min-w-0">
                <b className="block truncate font-medium">{l.name}</b>
                <Capsule
                  metric="revenue"
                  ratio={
                    Math.max(0, l.revenue) /
                    Math.max(
                      1,
                      rows.reduce((a, v) => a + Math.max(0, v.revenue), 0),
                    )
                  }
                  caption={`${Math.round(
                    (Math.max(0, l.revenue) /
                      Math.max(
                        1,
                        rows.reduce((a, v) => a + Math.max(0, v.revenue), 0),
                      )) *
                      100,
                  )}% of returned positive launch revenue`}
                />
                <span className="mt-0.5 block truncate text-xs leading-4 text-muted" title={l.last_check_detail ?? undefined}>
                  {l.launched_on ? `Launched ${fmtDay(l.launched_on)}` : STATUS_LABEL[l.status]} · {checkWords(l)}
                </span>
              </div>
              <span>
                <StatusPill launch={l} />
              </span>
              <span className="text-right tabular-nums">
                {notYet ? (
                  <>
                    <span className="text-faint">—</span>
                    <span className="block text-xs leading-4 text-muted">not live yet</span>
                  </>
                ) : (
                  <>
                    <span className={l.revenue ? 'font-medium' : 'text-muted'}>{money(l.revenue)}</span>
                    <span className="block text-xs leading-4 text-muted">{fmtNumber(l.visitors)} visitors</span>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
