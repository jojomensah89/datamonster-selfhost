import { Button } from '../components/primitives/button';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { CustomizeCards } from '../components/CustomizeCards';
import { FilterBar } from '../components/FilterBar';
import { GoalsPanel } from '../components/GoalsPanel';
import { LaunchesBlock } from '../components/LaunchesBlock';
import { LiveCard } from '../components/LiveCard';
import { isDialogOpen } from '../components/Dialog';
import { OverviewCard, type OverviewData } from '../components/OverviewCard';
import { Panel, rowName, type TabDef } from '../components/Panel';
import { byRevenue, RevenueSources, type SourceTab } from '../components/RevenueSources';
import { PERIODS, Toolbar } from '../components/Toolbar';
import { VisitorModal } from '../components/VisitorModal';
import { BlockError, EmptyRow } from '../components/ui';
import type { CardId } from '../../shared/dashboardCards';
import { qs, type BreakdownRow, type Query, type Site } from '../lib/api';
import { useCardLayout } from '../lib/cardLayout';
import { DashContext, type Dash } from '../lib/context';
import { toggledFilter, withoutFilter } from '../lib/filters';
import { fmtMoney, fmtNumber, fmtPct } from '../lib/format';
import { usePref } from '../lib/prefs';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

// The live view is only downloaded when opened.
const LiveView = lazy(() => import('../components/LiveView'));

const PANELS: Record<'locations' | 'channels' | 'pages' | 'devices', TabDef[]> = {
  locations: [
    { label: 'Country', dim: 'country', filter: 'country' },
    { label: 'Region', dim: 'region', filter: 'region' },
    { label: 'City', dim: 'city', filter: 'city' },
  ],
  channels: [
    { label: 'Channel', dim: 'channel', filter: 'channel' },
    { label: 'Referrer', dim: 'source', filter: 'source' },
    { label: 'Campaign', dim: 'campaign', filter: 'utm_campaign' },
    { label: 'Keyword', dim: 'keyword', filter: 'utm_term' },
  ],
  pages: [
    { label: 'Page', dim: 'page', filter: 'page' },
    { label: 'Entry page', dim: 'entry_page', filter: 'entry_page' },
    { label: 'Exit link', dim: 'exit_link' },
    { label: 'Hostname', dim: 'hostname', filter: 'hostname' },
  ],
  devices: [
    { label: 'Browser', dim: 'browser', filter: 'browser' },
    { label: 'OS', dim: 'os', filter: 'os' },
    { label: 'Device', dim: 'device', filter: 'device' },
  ],
};

/** "in the last 30 days", "today", "in this period". */
function periodWords(q: Query) {
  if (q.period === 'today') return 'today';
  if (q.period === 'yesterday') return 'yesterday';
  if (q.period === 'all') return 'so far';
  const p = PERIODS.find((x) => x.value === q.period);
  return p ? `in the ${p.label.toLowerCase()}` : 'in this period';
}

const sourceName = (label: string | null) => (label === null ? 'Direct visits' : rowName('source', label));

/**
 * The one-line finding under the title, worked out from the period's numbers. It says less when there is little
 * to go on: no share of revenue from three payments.
 */
function finding(o: OverviewData, rows: BreakdownRow[], q: Query, money: (m: number) => string) {
  const c = o.current;
  const when = periodWords(q);
  if (!c.visitors && !c.revenue) return <>No visitors or revenue {when}.</>;
  if (c.revenue <= 0) {
    const top = [...rows].sort((a, b) => b.visitors - a.visitors)[0];
    if (!top) return <>No revenue {when} yet.</>;
    return (
      <>
        No revenue {when} yet. <b className="font-medium text-ink">{sourceName(top.label)}</b> sent the most visitors, {fmtNumber(top.visitors)} of {fmtNumber(c.visitors)}.
      </>
    );
  }
  const top = byRevenue(rows)[0];
  if (!top || top.revenue <= 0)
    return (
      <>
        {money(c.revenue)} {when}, not yet matched to a source.
      </>
    );
  const name = <b className="font-medium text-ink">{sourceName(top.label)}</b>;
  if (c.payments < 5) {
    return (
      <>
        {fmtNumber(c.payments)} {c.payments === 1 ? 'payment' : 'payments'} {when}, {money(c.revenue)} in all. {name} brought {money(top.revenue)}.
      </>
    );
  }
  return (
    <>
      {name} brought {fmtPct(top.revenue / c.revenue)} of revenue {when}, {money(top.revenue)} of {money(c.revenue)}.
    </>
  );
}

export function Dashboard({ siteId }: { siteId: string }) {
  const [q, update] = useQueryState(siteId);
  const [reloadKey, setReloadKey] = useState(0);
  const [visitor, setVisitor] = useState<string | null>(null);
  const [live, setLive] = useState(() => new URLSearchParams(window.location.search).get('live') === '1');

  // "M" opens the live map.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey && !isDialogOpen() && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) setLive(true);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const [sitesKey, setSitesKey] = useState(0);
  const { data: sites, error: sitesError } = useApi<Site[]>('/api/sites', sitesKey);
  const site = sites?.find((s) => s.id === siteId);
  const { data: overview, loading } = useApi<OverviewData>(site ? `/api/sites/${siteId}/overview?${qs(q)}` : null, reloadKey);
  // Revenue by source: the block under the chart and the finding line both read these rows.
  const [sourceTab, setSourceTab] = usePref<SourceTab>('dm_sources_tab', 'source');
  const { data: sources, error: sourcesError } = useApi<BreakdownRow[]>(site ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'source' })}` : null, reloadKey);
  const { data: refs, error: refsError } = useApi<BreakdownRow[]>(site && sourceTab === 'ref' ? `/api/sites/${siteId}/breakdown?${qs(q, { dim: 'ref' })}` : null, reloadKey);

  const layout = useCardLayout(siteId, site?.dashboard_cards);
  const [choosing, setChoosing] = useState(false);
  const chooser = useRef<HTMLButtonElement>(null);

  const addFilter = useCallback((key: string, value: string) => update({ filters: toggledFilter(q.filters, key, value) }), [q.filters, update]);

  const dash: Dash | null = useMemo(() => {
    if (!site) return null;
    const decimals = overview?.decimals ?? 2;
    return {
      site,
      q,
      reloadKey,
      decimals,
      money: (minor, compact) => fmtMoney(minor, site.currency, decimals, compact),
      addFilter,
      openVisitor: setVisitor,
    };
  }, [site, q, reloadKey, overview?.decimals, addFilter]);

  if (sitesError && !sites) return <BlockError what={`Couldn't load this site: ${sitesError}.`} onRetry={() => setSitesKey((k) => k + 1)} />;
  if (sites && !site) {
    return (
      <EmptyRow>
        This site doesn't exist or you can't see it.{' '}
        <Button variant="raw" size="raw" type="button" className="card-link" onClick={() => navigate('/')}>
          All websites
        </Button>
      </EmptyRow>
    );
  }
  if (!dash || !site) {
    return (
      <div aria-busy="true">
        <div className="skeleton h-7 w-48" />
        <div className="skeleton mt-2 h-4 w-72" />
        <div className="skeleton mt-6 h-[420px] rounded-[20px]" />
      </div>
    );
  }

  const shown = layout.cards.filter((c) => c.on).map((c) => c.id);
  const card = (id: CardId): ReactNode => {
    if (id === 'sources')
      return (
        <RevenueSources
          tab={sourceTab}
          onTab={setSourceTab}
          rows={(sourceTab === 'ref' ? refs : sources) ?? null}
          error={(sourceTab === 'ref' ? refsError : sourcesError) || undefined}
          totalRevenue={overview?.current.revenue ?? null}
        />
      );
    if (id === 'launches') return <LaunchesBlock />;
    if (id === 'live') return <LiveCard onOpen={() => setLive(true)} paused={live} />;
    if (id === 'goals') return <GoalsPanel totalVisitors={overview?.current.visitors ?? 0} />;
    return <Panel tabs={PANELS[id]} />;
  };

  return (
    <DashContext.Provider value={dash}>
      <div>
        <Toolbar
          site={site}
          q={q}
          update={update}
          overview={overview}
          onRefresh={() => setReloadKey((k) => k + 1)}
          onLive={() => setLive(true)}
          loading={loading}
          extra={
            <CustomizeCards
              cards={layout.cards}
              onChange={layout.setCards}
              open={choosing}
              onOpenChange={(open) => {
                setChoosing(open);
                if (open) layout.clearError();
                else layout.flush();
              }}
              error={layout.error ? "Couldn't save your cards, so they are back as they were. Try again." : undefined}
              triggerRef={chooser}
            />
          }
          sub={overview && sources ? finding(overview, sources, q, (m) => dash.money(m)) : undefined}
        />

        {layout.error && !choosing && (
          <p role="alert" className="mb-4 text-sm text-negative">
            Couldn't save your cards, so they are back as they were.
          </p>
        )}

        {Object.keys(q.filters).length > 0 && (
          <FilterBar
            filters={q.filters}
            onRemove={(k) => update({ filters: withoutFilter(q.filters, k) })}
            onClear={() => update({ filters: {} })}
            onEmpty={() => chooser.current?.focus({ preventScroll: true })}
          />
        )}

        <OverviewCard data={overview} />

        <div className="dash-cards">
          {shown.map((id) => (
            <div key={id} className={`dash-card dash-card--${id}`}>
              {card(id)}
            </div>
          ))}
        </div>
        {shown.length === 0 && (
          <EmptyRow className="mt-8">
            All cards are hidden.{' '}
            <Button
              variant="raw"
              size="raw"
              type="button"
              className="card-link"
              onClick={() => {
                window.scrollTo({ top: 0 });
                setChoosing(true);
              }}
            >
              Choose cards
            </Button>
          </EmptyRow>
        )}

        <p className="mt-6 text-xs text-muted">
          Times in {site.timezone} · Revenue in {site.currency} ·{' '}
          <Button variant="raw" size="raw" type="button" className="card-link text-xs" onClick={() => navigate(`/site/${site.id}/settings`)}>
            Install and settings
          </Button>
        </p>
      </div>
      {live && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-ground" />}>
          <LiveView onClose={() => setLive(false)} />
        </Suspense>
      )}
      <VisitorModal key={visitor ?? 'none'} visitorId={visitor} onClose={() => setVisitor(null)} />
    </DashContext.Provider>
  );
}
