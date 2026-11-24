import { Input } from './primitives/input';
import { Button } from './primitives/button';
import { MetricRowBackground } from './Capsule';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { usePref } from '../lib/prefs';
import { qs, type BreakdownRow } from '../lib/api';
import { useDash } from '../lib/context';
import { countryName, fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';
import { BrowserIcon, ChannelIcon, DeviceIcon, Favicon, Flag, OSIcon, SourceIcon } from './Icons';
import { ChipRow } from './ChipRow';
import { Modal } from './Modal';
import { BlockError, Icon } from './ui';

export interface TabDef {
  label: string;
  dim: string;
  /** Session filter applied when a row is clicked (omit for non-filterable tabs). */
  filter?: string;
}

/** How each dimension's label and icon are shown. */
export function renderLabel(dim: string, row: Pick<BreakdownRow, 'label' | 'extra'>): ReactNode {
  const l = row.label;
  const text = (s: ReactNode) => <span className="truncate">{s}</span>;
  switch (dim) {
    case 'channel':
      return (
        <>
          <ChannelIcon channel={l} />
          {text(l)}
        </>
      );
    case 'source':
      return (
        <>
          <SourceIcon source={l} domain={row.extra} />
          {text(l ?? 'Direct/None')}
        </>
      );
    case 'country':
      return (
        <>
          <Flag cc={l} />
          {text(countryName(l))}
        </>
      );
    case 'region':
    case 'city':
      return (
        <>
          <Flag cc={row.extra ?? null} />
          {text(l ?? 'Unknown')}
        </>
      );
    case 'browser':
      return (
        <>
          <BrowserIcon name={l} />
          {text(l)}
        </>
      );
    case 'os':
      return (
        <>
          <OSIcon name={l} />
          {text(l)}
        </>
      );
    case 'device':
      return (
        <>
          <DeviceIcon name={l} />
          {text(l)}
        </>
      );
    case 'hostname':
      return (
        <>
          <Favicon domain={l} />
          {text(l)}
        </>
      );
    case 'exit_link': {
      let host: string | null = null;
      try {
        host = l ? new URL(l).hostname : null;
      } catch {}
      return (
        <>
          <Favicon domain={host} />
          {text(l?.replace(/^https?:\/\/(www\.)?/, ''))}
        </>
      );
    }
    default:
      return text(l ?? <span className="text-faint">(none)</span>);
  }
}

/** The plain-words name of a row, for screen readers. */
export function rowName(dim: string, label: string | null) {
  if (dim === 'country') return countryName(label);
  if (dim === 'source') return label ?? 'Direct/None';
  return label ?? '(none)';
}

/**
 * The filters a card set, on its column-heading row beside the numbers, so each can be removed without leaving the
 * card. `label` is that row's usual heading.
 */
export function CardFilters({ tabs, label }: { tabs: TabDef[]; label?: string }) {
  const { q, addFilter } = useDash();
  const active = tabs.filter((t) => t.filter && t.filter in q.filters);
  if (!active.length) return <span className="min-w-0 flex-1">{label}</span>;
  return (
    <ChipRow values={Object.fromEntries(active.map((t) => [t.filter!, q.filters[t.filter!]]))} className="flex-1 gap-1.5">
      {active.map((t) => {
        const key = t.filter!;
        const value = q.filters[key];
        return (
          <span key={key} data-filter={key} className="filter-chip filter-chip--card">
            <span className="flex min-w-0 items-center gap-1.5 text-ink">{renderLabel(t.dim, { label: value || null })}</span>
            <Button
              variant="raw"
              size="raw"
              type="button"
              className="icon-btn h-6 w-6"
              aria-label={`Remove filter ${t.label}: ${rowName(t.dim, value || null)}`}
              onClick={(e) => {
                // The chip goes away: keep the keyboard on this card's open tab.
                e.currentTarget.closest('.card')?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
                addFilter(key, value);
              }}
            >
              <Icon name="close" size={10} />
            </Button>
          </span>
        );
      })}
    </ChipRow>
  );
}

function Bars({ rows, dim, tab, sort, limit, onPick }: { rows: BreakdownRow[]; dim: string; tab: TabDef; sort: 'visitors' | 'revenue'; limit?: number; onPick?: (r: BreakdownRow) => void }) {
  const { money, q } = useDash();
  const sorted = useMemo(() => [...rows].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0) || b.visitors - a.visitors), [rows, sort]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const maxV = Math.max(1, ...rows.map((r) => r.visitors));
  const maxR = Math.max(1, ...rows.map((r) => r.revenue));
  const hasRevenue = rows.some((r) => r.revenue > 0);
  const tipId = useId();

  return (
    <ul className="metric-row-list">
      {shown.map((r, i) => {
        const name = rowName(dim, r.label);
        const on = !!tab.filter && q.filters[tab.filter] === (r.label ?? '');
        const inner = (
          <>
            <MetricRowBackground visitors={r.visitors} revenue={r.revenue} maxVisitors={maxV} maxRevenue={hasRevenue ? maxR : 0} />
            <span className="relative min-w-0 flex-1 px-3">
              <span className="flex min-w-0 items-center gap-2.5">{renderLabel(dim, r)}</span>
            </span>
            <span className="metric-row-visitors relative text-right tabular-nums text-visitors">{fmtNumber(r.visitors)}</span>
            <span className="metric-row-revenue relative pr-3 text-right font-medium tabular-nums text-revenue">{money(r.revenue, true)}</span>
            <span
              id={`${tipId}-${i}`}
              role="tooltip"
              className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-60 -translate-x-1/2 rounded-xl bg-tip px-3 py-2 text-left text-xs font-normal text-tipInk shadow-float group-hover:block group-focus-visible:block"
            >
              <span className="mb-1 block truncate font-medium">{name}</span>
              <span className="flex justify-between">
                <span className="text-tipMuted">Visitors</span>
                {fmtNumber(r.visitors)}
              </span>
              {r.pageviews !== undefined && dim === 'page' && (
                <span className="flex justify-between">
                  <span className="text-tipMuted">Pageviews</span>
                  {fmtNumber(r.pageviews)}
                </span>
              )}
              <span className="flex justify-between">
                <span className="text-tipMuted">Revenue</span>
                {money(r.revenue)}
              </span>
              <span className="flex justify-between">
                <span className="text-tipMuted">Customers</span>
                {r.customers}
              </span>
              <span className="flex justify-between">
                <span className="text-tipMuted">Conversion</span>
                {r.visitors ? fmtPct(r.customers / r.visitors, 1) : '—'}
              </span>
            </span>
          </>
        );
        const cls = 'metric-data-row group relative flex w-full items-center rounded-lg text-left';
        return (
          <li key={`${r.label}-${i}`}>
            {tab.filter && onPick ? (
              <Button variant="raw" size="raw"
                type="button"
                className={`${cls} ${on ? 'row-on' : ''}`}
                aria-pressed={on}
                onClick={() => onPick(r)}
                aria-label={`${on ? 'Filtered by' : 'Filter by'} ${tab.label.toLowerCase()} ${name}: ${fmtNumber(r.visitors)} visitors, ${money(r.revenue)} revenue`}
              >
                {inner}
              </Button>
            ) : (
              // Not filterable (exit links): still reachable, so the details show on focus too.
              <div className={cls} tabIndex={0} aria-describedby={`${tipId}-${i}`}>
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function Panel({ tabs }: { tabs: TabDef[] }) {
  const { site, q, reloadKey, addFilter, money } = useDash();
  const [saved, setActive] = usePref(`dm_tab_${tabs[0].dim}`, tabs[0].dim);
  const active = tabs.some((t) => t.dim === saved) ? saved : tabs[0].dim;
  // Revenue first wherever there is revenue to sort by; a choice made here is remembered.
  const [sortPref, setSort] = usePref<'visitors' | 'revenue' | null>(`dm_sort_${tabs[0].dim}`, null);
  const [details, setDetails] = useState(false);
  const [search, setSearch] = useState('');
  const tabId = useId();
  const tab = tabs.find((t) => t.dim === active)!;
  const { data, loading, error } = useApi<BreakdownRow[]>(`/api/sites/${site.id}/breakdown?${qs(q, { dim: active })}`, reloadKey);

  const pick = (r: BreakdownRow) => {
    if (!tab.filter) return;
    setDetails(false);
    addFilter(tab.filter, r.label ?? '');
  };

  const hasRevenue = (data ?? []).some((r) => r.revenue > 0);
  const sort: 'visitors' | 'revenue' = hasRevenue ? (sortPref ?? 'revenue') : 'visitors';
  const filtered = (data ?? []).filter((r) => !search || (r.label ?? '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="card v3-contained-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="tabs flex-wrap rounded-xl" role="tablist" aria-label={`Group by ${tabs[0].label.toLowerCase()}`}>
          {tabs.map((t) => (
            <Button variant="raw" size="raw" key={t.dim} type="button" role="tab" id={`${tabId}-${t.dim}`} aria-controls={`${tabId}-panel`} tabIndex={t.dim === active ? 0 : -1} aria-selected={t.dim === active} onKeyDown={e => {
              const index = tabs.indexOf(t);
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
              if (next < 0) return;
              e.preventDefault(); setActive(tabs[next].dim); document.getElementById(`${tabId}-${tabs[next].dim}`)?.focus();
            }} className={`tab whitespace-nowrap ${t.dim === active ? 'tab-active' : ''}`} onClick={() => setActive(t.dim)}>
              {t.label}
            </Button>
          ))}
        </div>
        {hasRevenue && (
          <Button variant="raw" size="raw"
            type="button"
            className="btn-ghost shrink-0 px-2.5"
            onClick={() => setSort(sort === 'visitors' ? 'revenue' : 'visitors')}
            aria-label={`Sorted by ${sort}. Sort by ${sort === 'visitors' ? 'revenue' : 'visitors'}`}
          >
            {sort === 'visitors' ? 'Visitors' : 'Revenue'} <Icon name="updown" size={14} className="text-faint" />
          </Button>
        )}
      </div>
      <div className="metric-row-head flex min-h-8 items-center gap-3 pb-1 text-xs text-muted">
        <CardFilters tabs={tabs} />
        <span className="metric-row-visitors text-right">Visitors</span>
        <span className="metric-row-revenue pr-3 text-right">Revenue</span>
      </div>
      <div className="flex-1" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${active}`}>
        {error && !data && <BlockError what={`Couldn't load ${tab.label.toLowerCase()}: ${error}.`} />}
        {loading && !data && !error && (
          <div className="space-y-1" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-10 rounded-lg" style={{ width: `${92 - i * 12}%` }} />
            ))}
          </div>
        )}
        {data && data.length === 0 && <p className="rounded-[10px] border border-dashed border-control px-3.5 py-3 text-sm text-muted">No {tab.label.toLowerCase()} data in this period.</p>}
        {data && <Bars rows={data} dim={active} tab={tab} sort={sort} limit={tabs[0].dim === 'country' ? 5 : 10} onPick={pick} />}
      </div>
      {data && data.length > (tabs[0].dim === 'country' ? 5 : 10) && (
        <Button variant="raw" size="raw" type="button" className="card-link mt-3 self-start" onClick={() => setDetails(true)}>
          Show all {data.length}
          <Icon name="chevron" size={12} />
        </Button>
      )}
      <Modal open={details} onClose={() => setDetails(false)} title={tab.label} width="max-w-3xl">
        <Input className="input mb-4" placeholder="Search" aria-label="Search rows" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>{tab.label}</th>
                <th className="n">Visitors</th>
                <th className="n">Revenue</th>
                <th className="n">Conversion</th>
                <th className="n">Per visitor</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i} className={tab.filter ? 'cursor-pointer transition-colors hover:bg-raised' : ''} onClick={() => pick(r)}>
                  <td className="max-w-[320px]">
                    {tab.filter ? (
                      <Button variant="raw" size="raw"
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 rounded text-left"
                        onClick={(e) => {
                          e.stopPropagation();
                          pick(r);
                        }}
                        aria-pressed={q.filters[tab.filter] === (r.label ?? '')}
                        aria-label={`Filter by ${tab.label.toLowerCase()} ${rowName(active, r.label)}`}
                      >
                        {renderLabel(active, r)}
                      </Button>
                    ) : (
                      <div className="flex min-w-0 items-center gap-2">{renderLabel(active, r)}</div>
                    )}
                  </td>
                  <td className="n">{fmtNumber(r.visitors)}</td>
                  <td className="n font-medium">{money(r.revenue)}</td>
                  <td className="n">{r.visitors ? fmtPct(r.customers / r.visitors, 1) : <span className="text-faint">—</span>}</td>
                  <td className="n">{r.visitors ? money(r.revenue / r.visitors) : <span className="text-faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
