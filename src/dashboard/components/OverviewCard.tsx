import { ChevronDown as DisclosureChevron, Plus, X } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './primitives/collapsible';
import { Button } from './primitives/button';
import { DatePicker } from './primitives/date-picker';
import { Input } from './primitives/input';
import { Popover, PopoverContent, PopoverTrigger } from './primitives/popover';
import { useMemo, useState, type FormEvent } from 'react';
import { usePref } from '../lib/prefs';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs, type Annotation, type Kpis, type Overview } from '../lib/api';
import { useDash } from '../lib/context';
import { axisDomain, axisTicks } from '../lib/chartAxis';
import { bucketLabel, fmtDuration, fmtMoney, fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';
import { Capsule } from './Capsule';

/** Map an annotation's YYYY-MM-DD day onto a bucket key from the overview series. */
export function bucketForAnnotation(day: string, buckets: string[], granularity: 'hour' | 'day' | 'week' | 'month'): string | null {
  if (!buckets.length) return null;
  if (granularity === 'day') return buckets.includes(day) ? day : null;
  if (granularity === 'hour') return buckets.find((b) => b.startsWith(`${day} `) || b.startsWith(`${day}T`)) ?? null;
  if (granularity === 'month') {
    const ym = day.slice(0, 7);
    return buckets.find((b) => b.startsWith(ym)) ?? null;
  }
  // Weekly buckets are Monday YYYY-MM-DD dates; match the Monday <= day within 6 days.
  let best: string | null = null;
  const target = Date.parse(`${day}T00:00:00Z`);
  for (const b of buckets) {
    const t = Date.parse(`${b}T00:00:00Z`);
    if (Number.isFinite(t) && t <= target && target - t < 7 * 86_400_000) best = b;
  }
  return best;
}

function todayYmd(tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Amounts the overview leaves out of the total because they were paid in another currency. */
export interface OtherCurrency {
  currency: string;
  amount: number;
  payments: number;
}
export type OverviewData = Overview & {
  other_currencies?: OtherCurrency[];
  other_currency_payments?: number;
};

type Metric = 'revenue' | 'visitors' | 'payments' | 'conversion' | 'perVisitor';

const decimalsOf = (currency: string) => {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};

/** "2 payments in EUR and JPY are not included in this total: €120, ¥5,000." Quiet, under the numbers. */
export function OtherCurrencies({ rows, payments }: { rows?: OtherCurrency[]; payments?: number }) {
  if (!rows?.length) return null;
  const names = rows.map((r) => r.currency);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const n = payments ?? rows.reduce((a, r) => a + r.payments, 0);
  const lead = n > 0 ? `${fmtNumber(n)} ${n === 1 ? 'payment' : 'payments'} in ${list} ${n === 1 ? 'is' : 'are'}` : `Amounts in ${list} are`;
  return (
    <p className="v3-other-currencies" role="note">
      {lead} not included in this total: <span className="tabular-nums text-ink">{rows.map((r) => fmtMoney(r.amount, r.currency, decimalsOf(r.currency))).join(', ')}</span>.
    </p>
  );
}

export function OverviewCard({ data }: { data: OverviewData | null }) {
  const { site, q, reloadKey, money } = useDash();
  const [metric, setMetric] = usePref<Metric>('dm_chart_metric', 'visitors');
  const [mode, setMode] = useState('Both');
  const [annVersion, setAnnVersion] = useState(0);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDay, setNoteDay] = useState(() => todayYmd(site?.timezone));
  const [noteText, setNoteText] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState('');
  const [delError, setDelError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { data: annRes } = useApi<{ annotations: Annotation[] }>(
    site && q ? `/api/sites/${site.id}/annotations?${qs(q)}` : null,
    (reloadKey ?? 0) + annVersion,
  );
  const annotations = annRes?.annotations ?? [];
  const c = data?.current,
    p = data?.previous;
  const definitions: [Metric, keyof Kpis, string][] = [
    ['revenue', 'revenue', 'Revenue'],
    ['visitors', 'visitors', 'Visitors'],
    ['payments', 'payments', 'Payments'],
    ['conversion', 'conversionRate', 'Conversion'],
    ['perVisitor', 'revenuePerVisitor', 'Revenue per visitor'],
  ];
  const format = (m: string, n: number) => (m === 'revenue' || m === 'perVisitor' ? money(n) : m === 'conversion' ? fmtPct(n, 2) : fmtNumber(n));
  const points = (data?.series ?? []).map((d) => ({
    ...d,
    conversion: d.visitors ? d.payments / d.visitors : 0,
    perVisitor: d.visitors ? d.revenue / d.visitors : 0,
  }));
  const granularity = data?.range.granularity ?? 'day';
  const notesByBucket = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    const buckets = points.map((pt) => pt.bucket);
    for (const a of annotations) {
      const b = bucketForAnnotation(a.day, buckets, granularity);
      if (!b) continue;
      const list = map.get(b) ?? [];
      list.push(a);
      map.set(b, list);
    }
    return map;
  }, [annotations, data?.series, granularity]);

  async function saveNote(e: FormEvent) {
    e.preventDefault();
    if (!site || !noteDay || !noteText.trim()) return;
    setNoteBusy(true);
    setNoteError('');
    try {
      await api(`/api/sites/${site.id}/annotations`, { method: 'POST', json: { day: noteDay || undefined, text: noteText.trim() } });
      setNoteText('');
      setNoteOpen(false);
      setAnnVersion((v) => v + 1);
    } catch (err) {
      setNoteError((err as Error).message || 'Could not save note. Try again.');
    } finally {
      setNoteBusy(false);
    }
  }

  async function removeNote(id: string) {
    if (!site) return;
    setDeletingId(id);
    setDelError('');
    try {
      await api(`/api/sites/${site.id}/annotations/${id}`, { method: 'DELETE' });
      setAnnVersion((v) => v + 1);
    } catch (err) {
      setDelError((err as Error).message || 'Could not delete note. Try again.');
    } finally {
      setDeletingId(null);
    }
  }

  const selected = definitions.some((d) => d[0] === metric) ? metric : 'revenue';
  const currentName = definitions.find((d) => d[0] === metric)?.[2] ?? 'Revenue';
  const both = mode === 'Both';
  const hasRevenue = points.some((pt) => pt.revenue !== 0);
  // The smallest difference a label can show: 0.01% for rates, one unit (a visitor, a cent) for the rest.
  const leftMetric = both ? 'visitors' : selected;
  const leftTicks = axisTicks(points.map((pt) => pt[leftMetric]), leftMetric === 'conversion' ? 0.0001 : 1);
  const rightTicks = axisTicks(points.map((pt) => pt.revenue), 1, leftTicks.length > 1 ? leftTicks.length - 1 : undefined);
  const color = (m: string) => `var(--chart-${m === 'revenue' || m === 'visitors' ? m : 'neutral'})`;
  return (
    <div className="v3-overview">
      <div className="v3-kpis" role="group" aria-label="Metric shown in the chart">
        {definitions.map(([key, field, label]) => {
          const a = c?.[field] ?? 0,
            b = p?.[field] ?? 0,
            r = a >= 0 && b >= 0 && a + b > 0 ? a / (a + b) : 0,
            delta = b ? ((a - b) / Math.abs(b)) * 100 : null;
          return (
            <Button variant="raw" size="raw"
              key={key}
              type="button"
              className={'v3-kpi ' + (key === 'revenue' ? 'v3-charcoal' : '')}
              data-metric={key}
              aria-pressed={both ? key === 'visitors' || key === 'revenue' : key === selected}
              aria-controls="overview-chart"
              onClick={() => { setMetric(key); setMode('Bar'); }}
            >
              <span className="v3-kpi-top">
                <span>{label}</span>
              </span>
              <strong>{c ? format(key, a) : '—'}</strong>
              <span className="v3-prior">Previous: {p ? format(key, b) : '—'}</span>
              <Capsule ratio={r} large metric={key === 'revenue' || key === 'visitors' ? key : 'neutral'} />
              <span className="v3-meter-note" title={a < 0 || b < 0 ? 'Signed amounts; no share' : `${(r * 100).toFixed(1)}% of both periods`}>
                <b>{key === 'conversion' ? `${((a - b) * 100).toFixed(2)} pts` : delta === null ? (a ? 'New' : '—') : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}</b>
              </span>
              <span className="sr-only">
                {key === 'conversion' ? `${((a - b) * 100).toFixed(2)} pts` : delta === null ? 'No earlier data' : `${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(1)}%`} vs previous period
              </span>
            </Button>
          );
        })}
      </div>
      <OtherCurrencies rows={data?.other_currencies} payments={data?.other_currency_payments} />
      <section className="card v3-chart" id="overview-chart">
        <div className="v3-chart-header">
          <h2>{both ? 'Visitors and revenue' : currentName} over time</h2>
          <div className="v3-chart-controls">
            {site && (
              <Popover open={noteOpen} onOpenChange={(open) => { setNoteOpen(open); if (open) { setNoteError(''); setNoteDay((d) => d || todayYmd(site.timezone)); } }}>
                <PopoverTrigger asChild>
                  <Button variant="raw" size="raw" type="button" className="btn h-9 text-xs">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Note
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" collisionPadding={16} className="w-80 max-w-[calc(100vw-32px)] border-line bg-surface">
                  <form className="space-y-3" onSubmit={saveNote}>
                    <div className="text-sm font-medium text-ink">Add timeline note</div>
                    <div className="space-y-1 text-xs text-muted">
                      <label className="block" htmlFor="note-day">
                        Date
                      </label>
                      <DatePicker id="note-day" className="h-9 w-full text-sm text-ink" value={noteDay} onValueChange={setNoteDay} />
                    </div>
                    <label className="block space-y-1 text-xs text-muted">
                      <span>What happened?</span>
                      <Input
                        type="text"
                        className="input h-9"
                        maxLength={200}
                        placeholder="Started the spring sale"
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        required
                      />
                    </label>
                    {noteError && <p className="text-xs text-negative" role="alert">{noteError}</p>}
                    <div className="flex justify-end gap-2">
                      <Button variant="raw" size="raw" type="button" className="btn h-8 text-xs" onClick={() => setNoteOpen(false)}>
                        Cancel
                      </Button>
                      <Button variant="raw" size="raw" type="submit" className="btn-dark h-8 text-xs" disabled={noteBusy || !noteDay || !noteText.trim()}>
                        {noteBusy ? 'Saving…' : 'Save note'}
                      </Button>
                    </div>
                  </form>
                </PopoverContent>
              </Popover>
            )}
            <div className="v3-switch" role="group" aria-label="Chart display">
              {['Bar', 'Line', 'Both'].map((m) => (
                <Button variant="raw" size="raw" key={m} type="button" aria-pressed={m === mode} onClick={() => setMode(m)}>
                  {m}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="v3-chart-context">
          <span>
            Bounce rate <b>{c ? fmtPct(c.bounceRate) : '—'}</b>
          </span>
          <span>
            Session time <b>{c ? fmtDuration(c.avgDuration) : '—'}</b>
          </span>
        </div>
        <div className="v3-chart-legend" aria-label="Chart legend">
          {(both ? ['visitors', 'revenue'] : [selected]).map(m => <span key={m}><i aria-hidden="true" style={{ background: color(m) }} />{m === 'visitors' ? 'Visitors' : m === 'revenue' ? 'Revenue' : currentName}{both ? (m === 'visitors' ? ' (left axis)' : hasRevenue ? ' (right axis)' : ': none in this period') : ''}</span>)}
        </div>
        <div className="v3-chart-stage">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart accessibilityLayer data={points} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="rgb(var(--c-line))" strokeDasharray="3 5" />
              <XAxis
                dataKey="bucket"
                tickFormatter={(b) => bucketLabel(b, data?.range.granularity ?? 'day')}
                tick={{ fill: 'rgb(var(--c-muted))', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={30}
              />
              <YAxis
                width={both ? 42 : 68}
                yAxisId="m"
                tickFormatter={(v) => format(both ? 'visitors' : selected, v)}
                tick={{ fill: 'rgb(var(--c-muted))', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                ticks={leftTicks}
                interval={0}
                domain={axisDomain(leftTicks)}
              />
              {both && <YAxis yAxisId="revenue" orientation="right" hide={!hasRevenue} width={68} tickFormatter={(v) => money(v)} tick={{ fill: 'rgb(var(--c-muted))', fontSize: 11 }} axisLine={false} tickLine={false} ticks={rightTicks} interval={0} domain={axisDomain(rightTicks)} />}
              <Tooltip
                cursor={{ fill: 'rgb(var(--c-well))' }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <div className="v3-tooltip">
                      <b>{bucketLabel(payload[0].payload.bucket, data?.range.granularity ?? 'day', true)}</b>
                      <dl className="v3-tooltip-rows">
                        {([['visitors', 'Visitors', fmtNumber(payload[0].payload.visitors)], ['pageviews', 'Pageviews', fmtNumber(payload[0].payload.pageviews)], ['revenue', 'Revenue', money(payload[0].payload.revenue)]] as const).map(([k, label, value]) => (
                          <div key={k}><dt><i aria-hidden="true" style={{ background: k === 'pageviews' ? 'var(--chart-neutral)' : color(k) }} />{label}</dt><dd>{value}</dd></div>
                        ))}
                        {!both && !['visitors', 'revenue'].includes(selected) && (
                          <div><dt><i aria-hidden="true" style={{ background: color(selected) }} />{currentName}</dt><dd>{format(selected, Number(payload[0].payload[selected]))}</dd></div>
                        )}
                      </dl>
                      {notesByBucket.get(payload[0].payload.bucket)?.length ? (
                        <ul className="mt-2 space-y-1 border-t border-rule pt-2 text-xs text-ink">
                          {notesByBucket.get(payload[0].payload.bucket)!.map((a) => (
                            <li key={a.id}>{a.text}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null
                }
              />
              {[...notesByBucket.keys()].map((bucket) => (
                <ReferenceLine
                  key={bucket}
                  x={bucket}
                  yAxisId="m"
                  stroke="rgb(var(--c-muted))"
                  strokeDasharray="3 3"
                  strokeOpacity={0.75}
                />
              ))}
              {mode !== 'Line' && (
                <Bar
                  yAxisId={both ? 'revenue' : 'm'}
                  dataKey={both ? 'revenue' : selected}
                  name={both ? 'Revenue' : currentName}
                  fill={color(both ? 'revenue' : selected)}
                  maxBarSize={22}
                  isAnimationActive={false}
                  radius={[5, 5, 0, 0]}
                />
              )}
              {mode !== 'Bar' && (
                <Line
                  yAxisId="m"
                  dataKey={both ? 'visitors' : selected}
                  name={both ? 'Visitors' : currentName}
                  type="monotone"
                  stroke={color(both ? 'visitors' : selected)}
                  strokeWidth={2.3}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {annotations.length > 0 && (
          <div className="mt-3 border-t border-rule pt-3">
            <ul className="flex flex-wrap gap-2" aria-label="Timeline notes">
              {annotations.map((a) => (
                <li key={a.id} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-well pl-2.5 pr-1 py-1 text-xs">
                  <span className="shrink-0 font-mono text-[11px] text-muted">{a.day}</span>
                  <span className="truncate text-ink">{a.text}</span>
                  {site && (
                    <Button
                      variant="raw"
                      size="raw"
                      type="button"
                      className="icon-btn h-5 w-5 shrink-0"
                      aria-label={`Delete note ${a.text}`}
                      disabled={deletingId === a.id}
                      onClick={() => removeNote(a.id)}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {delError && <p className="mt-2 text-xs text-negative" role="alert">{delError}</p>}
          </div>
        )}
        <Collapsible className="mt-3 text-xs text-muted">
          <CollapsibleTrigger asChild><Button variant="raw" size="raw" type="button" className="cursor-pointer">Chart data<DisclosureChevron className="disclosure-chevron ml-2 inline-block h-4 w-4" aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent>
          <div className="mt-2 max-h-60 overflow-auto">
            <table className="w-full text-left">
              <caption>{both ? 'Visitors and revenue' : currentName} by bucket</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">{both ? 'Visitors' : currentName}</th>
                  {both && <th scope="col">Revenue</th>}
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.bucket}>
                    <th scope="row">{bucketLabel(p.bucket, data?.range.granularity ?? 'day', true)}</th>
                    <td>{format(both ? 'visitors' : selected, p[both ? 'visitors' : selected])}</td>
                    {both && <td>{money(p.revenue)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CollapsibleContent></Collapsible>
      </section>
    </div>
  );
}
