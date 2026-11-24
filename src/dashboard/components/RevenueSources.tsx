import { Button } from './primitives/button';
import { MetricRowBackground } from './Capsule';
import { usePref } from '../lib/prefs';
import type { BreakdownRow } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtNumber } from '../lib/format';
import { CardFilters, rowName, renderLabel } from './Panel';
import { AppLink, BlockError, EmptyRow } from './ui';

export type SourceTab = 'source' | 'ref';

const TABS: {
  dim: SourceTab;
  label: string;
  filter: string;
  noun: [string, string];
}[] = [
  {
    dim: 'source',
    label: 'Sources',
    filter: 'source',
    noun: ['source', 'sources'],
  },
  {
    dim: 'ref',
    label: 'Tagged links',
    filter: 'ref',
    noun: ['tagged link', 'tagged links'],
  },
];
const SHOWN = 6;

/** Rows by revenue, then visitors: what paid comes first, what only brought traffic after. */
export function byRevenue(rows: BreakdownRow[]) {
  return [...rows].sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors);
}

/**
 * The Overview's answer under the chart: each source with its visitors, customers and revenue, sorted by revenue,
 * with a thin bar for its share of the period's revenue. "Tagged links" shows the same for ?ref= links.
 * The rows come from the Dashboard (it also writes the finding line from them).
 */
export function RevenueSources({
  tab,
  onTab,
  rows,
  error,
  totalRevenue,
}: {
  tab: SourceTab;
  onTab: (t: SourceTab) => void;
  rows: BreakdownRow[] | null;
  error?: string;
  /** The period's revenue from the overview, so the shares and the foot add up to the KPI. */
  totalRevenue: number | null;
}) {
  const { site, money, q, addFilter } = useDash();
  const def = TABS.find((t) => t.dim === tab)!;
  // Visits without a ref tag are not a tagged link.
  const sorted = rows ? byRevenue(tab === 'ref' ? rows.filter((r) => r.label) : rows) : [];
  const shown = sorted.slice(0, SHOWN);
  const rest = sorted.slice(SHOWN);
  const paid = sorted.some((r) => r.revenue !== 0);
  const total = totalRevenue ?? sorted.reduce((a, r) => a + r.revenue, 0);
  const signed = total < 0 || sorted.some((r) => r.revenue < 0);
  const totalVisitors = sorted.reduce((a, r) => a + r.visitors, 0);
  const maxVisitors = Math.max(0, ...sorted.map(r => r.visitors));
  const maxRevenue = Math.max(0, ...sorted.map(r => r.revenue));
  const attributed = sorted.reduce((a, r) => a + r.revenue, 0);
  const unmatched = tab === 'source' ? total - attributed : 0;
  // Share of revenue; with no revenue yet, share of visitors so the bars still say something true.
  const share = (r: BreakdownRow) => (paid ? (total > 0 ? Math.max(0, r.revenue) / total : 0) : totalVisitors ? r.visitors / totalVisitors : 0);
  const cols = 'grid grid-cols-[minmax(0,1fr)_64px_88px] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_72px_80px_96px]';

  return (
    <section aria-labelledby="sources-title" className="card v3-contained-card v3-sources min-w-0">
      <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="sources-title" className="text-base font-semibold">
          Revenue by source
        </h2>
        <div className="tabs" role="tablist" aria-label="Group by">
          {TABS.map((t) => (
            <Button variant="raw" size="raw"
              key={t.dim}
              type="button"
              role="tab"
              id={`sources-tab-${t.dim}`}
              aria-selected={t.dim === tab}
              aria-controls="sources-panel"
              tabIndex={t.dim === tab ? 0 : -1}
              className={`tab ${t.dim === tab ? 'tab-active' : ''}`}
              onClick={() => onTab(t.dim)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const next = TABS[(TABS.indexOf(t) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
                onTab(next.dim);
                document.getElementById(`sources-tab-${next.dim}`)?.focus();
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="v3-contained-body" id="sources-panel" role="tabpanel" aria-labelledby={`sources-tab-${tab}`}>
        {error && !rows && (
          <div className="py-2.5">
            <BlockError what={`Couldn't load ${def.noun[1]}: ${error}.`} />
          </div>
        )}
        {!rows && !error && (
          <div aria-busy="true" className="py-1.5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5">
                <div className="flex-1">
                  <div className="skeleton h-4" style={{ width: `${70 - i * 10}%` }} />
                  <div className="skeleton mt-2 h-[5px] w-full rounded-full" />
                </div>
                <div className="skeleton h-4 w-12" />
                <div className="skeleton h-4 w-16" />
              </div>
            ))}
          </div>
        )}
        {rows && sorted.length === 0 && (
          <div className="py-2.5">
            {tab === 'ref' ? (
              <EmptyRow>
                No tagged links in this period.{' '}
                <AppLink to={`/links?site=${site.id}&new=1`} className="card-link">
                  Build a link
                </AppLink>
              </EmptyRow>
            ) : (
              <EmptyRow>No sources in this period.</EmptyRow>
            )}
          </div>
        )}
        {shown.length > 0 && (
          <>
            <div className={`${cols} h-9 text-xs text-muted`}>
              <CardFilters tabs={TABS} label={tab === 'ref' ? 'Link' : 'Source'} />
              <span className="text-right">Visitors</span>
              <span className="hidden text-right sm:block">Customers</span>
              <span className="text-right">Revenue</span>
            </div>
            <ul className="metric-row-list">
              {shown.map((r, i) => {
                const name = rowName(def.dim, r.label);
                const s = share(r);
                const on = q.filters[def.filter] === (r.label ?? '');
                return (
                  <li key={`${r.label}-${i}`}>
                    <Button variant="raw" size="raw"
                      type="button"
                      className={`${cols} metric-data-row relative -mx-2 w-[calc(100%+1rem)] rounded-lg px-2 py-2.5 text-left transition-colors duration-150 hover:bg-raised ${on ? 'row-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => addFilter(def.filter, r.label ?? '')}
                      aria-label={`${on ? 'Filtered by' : 'Filter by'} ${def.noun[0]} ${name}: ${fmtNumber(r.visitors)} visitors, ${fmtNumber(r.customers)} customers, ${money(r.revenue)} revenue${signed ? ', signed amounts; no share' : paid && total > 0 ? `, ${Math.round(s * 100)}% of revenue` : ''}`}
                    >
                      <MetricRowBackground visitors={r.visitors} revenue={r.revenue} maxVisitors={maxVisitors} maxRevenue={maxRevenue} />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2.5 font-medium">{tab === 'ref' ? <span className="truncate">{name}</span> : renderLabel(def.dim, r)}</span>
                      </span>
                      <span className="text-right tabular-nums text-visitors">{fmtNumber(r.visitors)}</span>
                      <span className="hidden text-right tabular-nums text-muted sm:block">{fmtNumber(r.customers)}</span>
                      <span className={`text-right tabular-nums ${r.revenue ? 'font-medium text-revenue' : 'text-muted'}`}>{money(r.revenue)}</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-rule py-2.5 text-sm">
              <span className="text-xs text-muted">
                {rest.length > 0
                  ? `${fmtNumber(rest.length)} more ${rest.length === 1 ? def.noun[0] : def.noun[1]}, ${money(rest.reduce((a, r) => a + r.revenue, 0))}`
                  : `${fmtNumber(sorted.length)} ${sorted.length === 1 ? def.noun[0] : def.noun[1]}`}
                {unmatched > 0 && ` · ${money(unmatched)} not matched to a visit`}
              </span>
              <span className="font-medium tabular-nums">{tab === 'ref' ? `${money(attributed)} from tagged links` : `${money(total)} total`}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
