import { Popover, PopoverTrigger, PopoverContent } from './primitives/popover';
import { DatePicker } from './primitives/date-picker';
import { Button } from './primitives/button';
import { useState, type ReactNode } from 'react';
import type { Overview, Query, Site } from '../lib/api';
import { dayInTz } from '../lib/format';
import { Icon, TitleRow } from './ui';

export const PERIODS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const GRANULARITIES = [
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

type Granularity = (typeof GRANULARITIES)[number]['value'];

function granularitiesForSpan(span: number): Granularity[] {
  const hour = 3_600_000;
  const day = 24 * hour;
  if (span <= 2 * day + hour) return ['hour'];
  if (span <= 7 * day + hour) return ['hour', 'day'];
  if (span <= 31 * day + hour) return ['day', 'week'];
  if (span <= 120 * day + hour) return ['day', 'week', 'month'];
  if (span <= 400 * day + hour) return ['week', 'month'];
  return ['month'];
}

export function Dropdown({ button, children, align = 'left' }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>{button}</PopoverTrigger>
    <PopoverContent align={align === 'right' ? 'end' : 'start'} className="w-auto min-w-[200px] p-1">
      {children(() => setOpen(false))}
    </PopoverContent>
  </Popover>;
}

const Chevron = () => <Icon name="down" size={14} className="text-faint" />;

function itemCls(active: boolean) {
  return `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-raised ${active ? 'font-medium text-ink' : 'text-muted'}`;
}

export function Toolbar({
  site,
  q,
  update,
  overview,
  onRefresh,
  onLive,
  loading,
  sub,
  extra,
}: {
  /** Shown before Refresh. */
  extra?: ReactNode;
  /** The line under the title; the Overview passes its finding. */
  sub?: ReactNode;
  site: Site;
  q: Query;
  update: (p: Partial<Query>) => void;
  overview: Overview | null;
  onRefresh: () => void;
  onLive: () => void;
  loading: boolean;
}) {
  const [from, setFrom] = useState(q.from ?? '');
  const [to, setTo] = useState(q.to ?? '');

  const label =
    q.period === 'custom'
      ? q.from === q.to
        ? new Date(q.from + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : `${q.from} → ${q.to}`
      : PERIODS.find((p) => p.value === q.period)?.label ?? 'Last 30 days';

  function shift(dir: -1 | 1) {
    if (!overview) return;
    const { from, to } = overview.range;
    const span = Math.max(to - from, 86_400_000);
    const nf = from + dir * span;
    const nt = nf + span - 1;
    if (nf > Date.now()) return;
    update({ period: 'custom', from: dayInTz(nf, site.timezone), to: dayInTz(Math.min(nt, Date.now()), site.timezone) });
  }
  const canForward = overview ? overview.range.to < Date.now() - 60_000 : false;
  const allowedGranularities = granularitiesForSpan(overview ? overview.range.to - overview.range.from : 30 * 86_400_000);
  const requestedGranularity = q.granularity as Granularity | undefined;
  const currentGranularity = requestedGranularity && allowedGranularities.includes(requestedGranularity) ? requestedGranularity : overview?.range.granularity;

  return (
    <TitleRow
      title={site.name}
      sub={
        sub ?? (
          <>
            {site.domain} · times in {site.timezone.replace(/_/g, ' ')} · revenue in {site.currency}
          </>
        )
      }
      actions={
        <>
          <div className="flex h-8 items-stretch rounded-full border border-control bg-surface">
            <Button variant="raw" size="raw" type="button" className="grid w-8 place-items-center rounded-l-full text-muted transition-colors hover:bg-raised hover:text-ink" onClick={() => shift(-1)} aria-label="Previous period">
              <Icon name="left" size={14} />
            </Button>
            <Dropdown
              align="right"
              button={
                <Button variant="raw" size="raw" type="button" className="flex h-full items-center gap-1.5 border-x border-line px-3 text-sm font-medium transition-colors hover:bg-raised" aria-haspopup="dialog">
                  {label} <Chevron />
                </Button>
              }
            >
              {(close) => (
                <>
                  {PERIODS.map((p) => (
                    <Button variant="raw" size="raw"
                      key={p.value}
                      type="button"
                      className={itemCls(q.period === p.value)}
                      onClick={() => {
                        close();
                        update({ period: p.value, granularity: undefined });
                      }}
                    >
                      <span className="flex-1">{p.label}</span>
                      {q.period === p.value && <Icon name="check" size={14} className="text-accent" />}
                    </Button>
                  ))}
                  <div className="my-1 border-t border-rule" />
                  <form
                    className="space-y-2 p-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!from || !to) return;
                      close();
                      update({ period: 'custom', from, to: to < from ? from : to, granularity: undefined });
                    }}
                  >
                    <div className="text-xs font-medium text-muted">Custom range</div>
                    <DatePicker  aria-label="From" className="input" value={from} onValueChange={(value) => setFrom(value)} />
                    <DatePicker  aria-label="To" className="input" value={to} onValueChange={(value) => setTo(value)} />
                    <Button variant="raw" size="raw" className="btn-dark w-full">Apply</Button>
                  </form>
                </>
              )}
            </Dropdown>
            <Button variant="raw" size="raw"
              type="button"
              className="grid w-8 place-items-center rounded-r-full text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
              onClick={() => shift(1)}
              disabled={!canForward}
              aria-label="Next period"
            >
              <Icon name="chevron" size={14} />
            </Button>
          </div>

          <Dropdown
            align="right"
            button={
              <Button variant="raw" size="raw" type="button" className="btn" aria-haspopup="dialog">
                {GRANULARITIES.find((g) => g.value === currentGranularity)?.label ?? 'Daily'} <Chevron />
              </Button>
            }
          >
            {(close) =>
              GRANULARITIES.filter((g) => allowedGranularities.includes(g.value)).map((g) => (
                <Button variant="raw" size="raw"
                  key={g.value}
                  type="button"
                  className={itemCls(currentGranularity === g.value)}
                  onClick={() => {
                    close();
                    update({ granularity: g.value });
                  }}
                >
                  <span className="flex-1">{g.label}</span>
                  {currentGranularity === g.value && <Icon name="check" size={14} className="text-accent" />}
                </Button>
              ))
            }
          </Dropdown>

          <Button variant="raw" size="raw" type="button" className="btn" onClick={onLive} title="Live map (M)">
            <span className="live-dot breathe" /> Live map
          </Button>

          {extra}

          <Button variant="raw" size="raw" type="button" className="icon-btn" onClick={onRefresh} aria-label="Refresh" title="Refresh">
            <Icon name="refresh" className={loading ? 'animate-spin' : ''} />
          </Button>
        </>
      }
    />
  );
}
