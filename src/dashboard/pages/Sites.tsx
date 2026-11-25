import { Input } from '../components/primitives/input';
import { Button } from '../components/primitives/button';
import { useEffect, useState } from 'react';
import { navigate, useMe } from '../App';
import { SpikeCharacter } from '../components/SpikeCharacter';
import { Favicon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { CurrencySelect, TimezoneSelect } from '../components/SiteFields';
import { BlockError, Icon, TitleRow } from '../components/ui';
import { Bar, ComposedChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { currencyDecimals } from '../../shared/currency';
import { api, type Site, type SiteSpark } from '../lib/api';
import { fmtMoney, fmtNumber } from '../lib/format';
import { usePref } from '../lib/prefs';
import { useApi } from '../lib/useApi';
import { useChartColors } from '../lib/theme';

const PERIODS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];
const AUTO_REFRESH_MS = 60_000;

/** One sentence on what went wrong, in words a person can act on. A 401 signs out on its own (see lib/api). */
function explain(message: string) {
  if (/failed to fetch|network|load failed/i.test(message)) return 'Check your connection, then retry.';
  if (/unauthori[sz]ed|401/i.test(message)) return 'Your session expired; sign in again.';
  return `The server said: ${message.replace(/\.$/, '')}.`;
}

export function Sites() {
  const [adding, setAdding] = useState(false);
  const [addHot, setAddHot] = useState(false);
  const [period, setPeriod] = usePref('dm_sites_period', '30d');
  const [reloadKey, setReloadKey] = useState(0);
  const { data: sites, loading: loadingSites, error } = useApi<Site[]>('/api/sites', reloadKey);
  const { data: sparks, loading: loadingSparks, error: sparksError } = useApi<SiteSpark[]>(`/api/sites-overview?period=${period}`, reloadKey);
  const loading = loadingSites || loadingSparks;

  useEffect(() => {
    if (sites && !sites.length) setAdding(true);
  }, [sites]);

  // Keep the numbers fresh while the page sits open.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && setReloadKey((k) => k + 1), AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const bySite = new Map(sparks?.map((s) => [s.id, s]));
  return (
    <div>
      <TitleRow
        title="All websites"
        actions={
          <>
            <div className="tabs" role="group" aria-label="Period">
              {PERIODS.map((p) => (
                <Button variant="raw" size="raw" key={p.value} type="button" aria-pressed={period === p.value} className={`tab ${period === p.value ? 'tab-active' : ''}`} onClick={() => setPeriod(p.value)}>
                  {p.label}
                </Button>
              ))}
            </div>
            <Button variant="raw" size="raw" type="button" className="icon-btn" onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh" title="Refresh">
              <Icon name="refresh" className={loading ? 'animate-spin' : ''} />
            </Button>
            <Button variant="raw" size="raw" type="button" className="btn-dark" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              Add website
            </Button>
          </>
        }
      />

      {error && !sites && <BlockError what={`Couldn't load your websites. ${explain(error)}`} onRetry={() => setReloadKey((k) => k + 1)} />}

      {sites && sites.length > 0 && sparksError && !loadingSparks && (
        <div className="mb-4">
          <BlockError
            what={
              sparks
                ? `Couldn't refresh visitors and revenue. ${explain(sparksError)} The figures below are from the last good load.`
                : `Couldn't load visitors and revenue for this period. ${explain(sparksError)}`
            }
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      )}

      {!sites && !error && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card p-5">
              <div className="skeleton h-5 w-2/5" />
              <div className="skeleton mt-4 h-20" />
              <div className="skeleton mt-3 h-4 w-3/5" />
            </div>
          ))}
        </div>
      )}

      {sites && sites.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.length > 1 && <AllSitesCard sites={sites} sparks={sparks} failed={!!sparksError && !sparks} />}
          {sites.map((s) => {
            const spark = bySite.get(s.id);
            return (
              <a
                key={s.id}
                href={`/site/${s.id}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(`/site/${s.id}`);
                }}
                className="card block p-5 text-left transition-colors duration-150 hover:border-control active:scale-[0.995]"
              >
                <div className="flex items-center gap-3">
                  <Favicon domain={s.domain} size={20} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{s.name}</div>
                    <div className="truncate text-xs text-faint">{s.domain}</div>
                  </div>
                  {!!spark?.online && <Online n={spark.online} />}
                </div>
                <Sparkline series={spark?.series} failed={!!sparksError && !sparks} />
                <Totals visitors={spark?.visitors} revenue={spark ? [{ currency: s.currency, amount: spark.revenue }] : undefined} />
              </a>
            );
          })}
          <Button variant="raw" size="raw"
            type="button"
            onClick={() => setAdding(true)}
            className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-control p-5 text-muted transition-colors duration-150 hover:border-faint hover:bg-raised hover:text-ink"
          >
            <Icon name="plus" />
            <span className="font-medium">Add a website</span>
          </Button>
        </div>
      )}

      {sites && !sites.length && (
        <div className="grid items-center gap-6 rounded-2xl border border-line px-6 py-6 sm:grid-cols-[200px_minmax(0,1fr)]">
          <SpikeCharacter
            size={200}
            className="h-32 w-32 sm:h-[200px] sm:w-[200px]"
            mood={addHot ? 'happy' : 'look'}
            hungry
            trackPointer
            allowClickHop
          />
          <div>
            <h2 className="text-xl font-semibold tracking-[-0.01em]">Nothing to chew on yet</h2>
            <p className="mt-1.5 max-w-[60ch] text-muted">Add your website and paste one line in its head. The first visit shows up here within a few seconds, and payments follow once you connect your payment provider.</p>
            <Button
              variant="raw"
              size="raw"
              type="button"
              className="btn-dark mt-4"
              onClick={() => setAdding(true)}
              onPointerEnter={(e) => e.pointerType === 'mouse' && setAddHot(true)}
              onPointerLeave={() => setAddHot(false)}
              onFocus={() => setAddHot(true)}
              onBlur={() => setAddHot(false)}
            >
              <Icon name="plus" size={14} />
              Add your first website
            </Button>
          </div>
        </div>
      )}
      <AddSite open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

/** Every site added together. Revenue is only summed within a currency. */
function AllSitesCard({ sites, sparks, failed }: { sites: Site[]; sparks: SiteSpark[] | null; failed?: boolean }) {
  const currency = new Map(sites.map((s) => [s.id, s.currency]));
  const series = sparks?.[0]?.series.map((_, i) => ({
    visitors: sparks.reduce((n, s) => n + (s.series[i]?.visitors ?? 0), 0),
    revenue: sparks.reduce((n, s) => n + (s.series[i]?.revenue ?? 0), 0),
  }));
  const revenue = new Map<string, number>();
  for (const s of sparks ?? []) {
    const c = currency.get(s.id) ?? 'USD';
    revenue.set(c, (revenue.get(c) ?? 0) + s.revenue);
  }
  const online = sparks?.reduce((n, s) => n + s.online, 0) ?? 0;
  return (
    <div className="well p-5">
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {sites.slice(0, 3).map((s) => (
            <Favicon key={s.id} domain={s.domain} size={16} />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">All {sites.length} websites</div>
        </div>
        {!!online && <Online n={online} />}
      </div>
      <Sparkline series={series} failed={failed} />
      <Totals visitors={sparks?.reduce((n, s) => n + s.visitors, 0)} revenue={sparks ? [...revenue].map(([currency, amount]) => ({ currency, amount })) : undefined} />
    </div>
  );
}

function Online({ n }: { n: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted" title={`${n} online now`}>
      <span className="live-dot breathe" />
      {n} online
    </span>
  );
}

function Sparkline({ series, failed }: { series?: { visitors: number; revenue: number }[]; failed?: boolean }) {
  const c = useChartColors();
  if (!series && failed) return <div className="mt-4 flex h-20 items-center justify-center rounded-lg border border-dashed border-control text-xs text-muted">Figures not loaded</div>;
  if (!series) return <div className="skeleton mt-4 h-20" />;
  return (
    <div className="mt-4 h-20" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <YAxis yAxisId="v" hide domain={[0, 'dataMax']} />
          <YAxis yAxisId="r" hide domain={[0, (max: number) => Math.max(1, max * 1.4)]} />
          <Bar yAxisId="r" dataKey="revenue" fill={c.revenue} radius={[2, 2, 0, 0]} maxBarSize={6} isAnimationActive={false} />
          <Line yAxisId="v" type="linear" dataKey="visitors" stroke={c.visitors} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Totals({ visitors, revenue }: { visitors?: number; revenue?: { currency: string; amount: number }[] }) {
  const paid = revenue?.filter((r) => r.amount !== 0) ?? [];
  return (
    <div className="mt-3 flex items-baseline gap-5 text-sm">
      <span>
        <span className="block text-xs text-muted">Visitors</span>
        <span className="text-base font-medium">{visitors === undefined ? <span className="text-faint">—</span> : fmtNumber(visitors)}</span>
      </span>
      <span>
        <span className="block text-xs text-muted">Revenue</span>
        <span className="text-base font-medium">
          {revenue === undefined ? (
            <span className="text-faint">—</span>
          ) : paid.length ? (
            paid.map((r) => fmtMoney(r.amount, r.currency, currencyDecimals(r.currency), true)).join(' + ')
          ) : (
            fmtMoney(0, revenue[0]?.currency ?? 'USD', 0)
          )}
        </span>
      </span>
    </div>
  );
}

function AddSite({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useMe();
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const site = await api<Site>('/api/sites', { method: 'POST', json: { domain, name, timezone, currency } });
      void refresh();
      navigate(`/site/${site.id}/settings`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a website" width="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="add-domain">
            Domain
          </label>
          <Input id="add-domain" className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus aria-describedby="add-domain-hint" />
          <p className="hint" id="add-domain-hint">
            Subdomains (app.example.com) are tracked under the same site.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="add-name">
            Name
          </label>
          <Input id="add-name" className="input" placeholder="My shop" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Timezone</label>
            <TimezoneSelect value={timezone} onChange={setTimezone} />
          </div>
          <div>
            <label className="label">Revenue currency</label>
            <CurrencySelect value={currency} onChange={setCurrency} />
          </div>
        </div>
        {error && <p className="text-sm text-negative">{error}</p>}
        <Button variant="raw" size="raw" className="btn-dark h-10 w-full" disabled={!domain}>
          Add website
        </Button>
      </form>
    </Modal>
  );
}
