import { SelectField, SelectItem } from './primitives/select-field';
import { Input } from './primitives/input';
import { Button } from './primitives/button';
import { Capsule } from './Capsule';
import { useId, useState, type ReactNode } from 'react';
import { usePref } from '../lib/prefs';
import { api, qs, type BreakdownRow } from '../lib/api';
import { fmtMoney } from '../lib/format';
import { displayName } from '../../shared/names';
import { useDash } from '../lib/context';
import { countryName, fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';
import { Avatar, BrowserIcon, DeviceIcon, Flag, OSIcon, SourceIcon } from './Icons';
import { EmptyRow, Icon } from './ui';

type Tab = 'goal' | 'funnel' | 'user' | 'journey';

export function GoalsPanel({ totalVisitors }: { totalVisitors: number }) {
  const [tab, setTab] = usePref<Tab>('dm_tab_goals', 'journey');
  const [search, setSearch] = useState('');
  const tabId = useId();
  return (
    <div className="card dash-goals min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div className="tabs flex-wrap rounded-xl" role="tablist" aria-label="People and conversions">
          {(['goal', 'funnel', 'user', 'journey'] as const).map((t) => (
            <Button variant="raw" size="raw" key={t} type="button" role="tab" id={`${tabId}-${t}`} aria-controls={`${tabId}-panel`} tabIndex={tab === t ? 0 : -1} aria-selected={tab === t} onKeyDown={e => {
              const tabs = ['goal', 'funnel', 'user', 'journey'] as const;
              const index = tabs.indexOf(t);
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
              if (next < 0) return;
              e.preventDefault(); setTab(tabs[next]); document.getElementById(`${tabId}-${tabs[next]}`)?.focus();
            }} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
              {t === 'journey' ? 'Journey' : t === 'user' ? 'Users' : t === 'goal' ? 'Goals' : 'Funnel'}
            </Button>
          ))}
        </div>
        {(tab === 'user' || tab === 'journey') && (
          <label className="relative block w-full max-w-[240px]">
            <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <Input className="input h-8 pl-8" placeholder="Search" aria-label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        )}
      </div>
      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
      {tab === 'goal' && <Goals totalVisitors={totalVisitors} />}
      {tab === 'funnel' && <Funnels />}
      {tab === 'user' && <Users search={search} />}
      {tab === 'journey' && <Journey search={search} />}
      </div>
    </div>
  );
}

function Goals({ totalVisitors }: { totalVisitors: number }) {
  const { site, q, reloadKey, money, addFilter } = useDash();
  const { data } = useApi<BreakdownRow[]>(`/api/sites/${site.id}/breakdown?${qs(q, { dim: 'goal' })}`, reloadKey);
  if (!data) return <Loading />;
  if (!data.length)
    return (
      <EmptyRow>
        No goals yet. Add <code className="text-[13px] text-ink">data-dm-goal="signup_click"</code> to any button, or call{' '}
        <code className="text-[13px] text-ink">window.datamonster('goal', 'signup')</code>.
      </EmptyRow>
    );
  return (
    <>
    <ul className="sm:hidden">
      {data.map((g) => (
        <li key={g.label} className="border-b border-rule py-3 last:border-0">
          <Button variant="raw" size="raw" type="button" className="min-h-8 max-w-full break-words rounded text-left font-medium" onClick={() => addFilter('goal', g.label ?? '')} aria-pressed={q.filters.goal === (g.label ?? '')} aria-label={`Filter by visitors who completed ${g.label}`}>
            {g.label}
          </Button>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div><dt className="text-xs text-muted">Visitors</dt><dd className="break-words tabular-nums">{fmtNumber(g.visitors)}</dd></div>
            <div><dt className="text-xs text-muted">Completions</dt><dd className="break-words tabular-nums">{fmtNumber(g.pageviews ?? 0)}</dd></div>
            <div><dt className="text-xs text-muted">Conversion</dt><dd className="break-words tabular-nums">{totalVisitors ? fmtPct(g.visitors / totalVisitors, 1) : <span className="text-faint">—</span>}</dd></div>
            <div><dt className="text-xs text-muted">Revenue</dt><dd className="break-words font-medium tabular-nums text-revenue">{money(g.revenue)}</dd></div>
          </dl>
        </li>
      ))}
    </ul>
    <table className="data-table hidden sm:table">
      <thead>
        <tr>
          <th>Goal</th>
          <th className="n">Visitors</th>
          <th className="n">Completions</th>
          <th className="n">Conversion</th>
          <th className="n">Revenue</th>
        </tr>
      </thead>
      <tbody>
        {data.map((g) => (
          <tr key={g.label} className={`cursor-pointer transition-colors hover:bg-raised ${q.filters.goal === (g.label ?? '') ? 'bg-raised' : ''}`} onClick={() => addFilter('goal', g.label ?? '')}>
            <td className="font-medium">
              <Button variant="raw" size="raw"
                type="button"
                className="rounded text-left"
                onClick={(e) => {
                  e.stopPropagation();
                  addFilter('goal', g.label ?? '');
                }}
                aria-pressed={q.filters.goal === (g.label ?? '')}
                aria-label={`Filter by visitors who completed ${g.label}`}
              >
                {g.label}
              </Button>
              <Capsule metric="visitors" ratio={g.visitors / Math.max(1, totalVisitors)} caption={`${((g.visitors / Math.max(1, totalVisitors)) * 100).toFixed(1)}% of period visitors`} />
            </td>
            <td className="n">{fmtNumber(g.visitors)}</td>
            <td className="n">{fmtNumber(g.pageviews ?? 0)}</td>
            <td className="n">{totalVisitors ? fmtPct(g.visitors / totalVisitors, 1) : <span className="text-faint">—</span>}</td>
            <td className="n font-medium text-revenue">{money(g.revenue)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

interface FunnelDef {
  id: string;
  name: string;
  steps: { type: 'page' | 'goal' | 'payment'; value: string }[];
}

function funnelStepLabel(s: FunnelDef['steps'][0]) {
  if (s.type === 'goal') return `Goal: ${s.value}`;
  if (s.type === 'payment') {
    const v = s.value.trim();
    return !v || v === 'any' || v === '*' || v.toLowerCase() === 'paid' ? 'Payment' : `Payment: ${v}`;
  }
  return s.value;
}

function Funnels() {
  const { site, q, reloadKey, money } = useDash();
  const [version, setVersion] = useState(0);
  const { data: funnels } = useApi<FunnelDef[]>(`/api/sites/${site.id}/funnels`, version);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = funnels?.find((f) => f.id === selected) ?? funnels?.[0];
  const { data: stats } = useApi<(FunnelDef['steps'][0] & { visitors: number; revenue?: number })[]>(current ? `/api/sites/${site.id}/funnels/${current.id}/stats?${qs(q)}` : null, reloadKey + version);

  if (!funnels) return <Loading />;
  if (creating || !funnels.length)
    return (
      <FunnelForm
        onDone={(id) => {
          setCreating(false);
          if (id) setSelected(id);
          setVersion((v) => v + 1);
        }}
        canCancel={funnels.length > 0}
      />
    );

  const top = stats?.[0]?.visitors || 0;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SelectField className="input h-8 w-auto" aria-label="Funnel" value={current?.id} onValueChange={(value) => setSelected(value)}>
          {funnels.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
        </SelectField>
        <Button variant="raw" size="raw" type="button" className="btn" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} />
          New funnel
        </Button>
        {current && (
          <Button variant="raw" size="raw"
            type="button"
            className="btn-danger"
            onClick={async () => {
              if (!confirm(`Delete funnel "${current.name}"?`)) return;
              await api(`/api/sites/${site.id}/funnels/${current.id}`, {
                method: 'DELETE',
              });
              setSelected(null);
              setVersion((v) => v + 1);
            }}
          >
            Delete
          </Button>
        )}
      </div>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, stats?.length ?? 1)}, minmax(0, 1fr))`,
        }}
      >
        {stats?.map((s, i) => {
          const pct = top ? s.visitors / top : 0;
          const prev = i ? stats[i - 1].visitors : s.visitors;
          const label = funnelStepLabel(s);
          const rev = s.revenue ?? 0;
          return (
            <div key={i} className="min-w-0">
              <div className="flex h-48 items-end rounded-xl bg-raised">
                <div
                  className={`w-full rounded-xl transition-[height] duration-300 ${s.type === 'payment' ? 'bg-revenue' : 'bg-visitors'}`}
                  style={{ height: `${Math.max(pct * 100, 2)}%` }}
                />
              </div>
              <div className="mt-2 truncate text-sm font-medium" title={label}>
                {label}
              </div>
              <div className="text-sm text-muted">
                {fmtNumber(s.visitors)} visitors · {fmtPct(pct)}
              </div>
              {(rev !== 0 || s.type === 'payment') && (
                <div className="text-xs font-medium tabular-nums text-revenue">{money(rev)}</div>
              )}
              {i > 0 && <div className="text-xs text-muted">−{prev ? fmtPct(1 - s.visitors / prev) : '0%'} drop-off</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FunnelForm({ onDone, canCancel }: { onDone: (id?: string) => void; canCancel: boolean }) {
  const { site } = useDash();
  const [name, setName] = useState('Purchase funnel');
  const [steps, setSteps] = useState<FunnelDef['steps']>([
    { type: 'page', value: '/' },
    { type: 'page', value: '/pricing' },
    { type: 'payment', value: 'any' },
  ]);
  const [error, setError] = useState('');
  const set = (i: number, patch: Partial<FunnelDef['steps'][0]>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <form
      className="max-w-xl space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const f = await api<FunnelDef>(`/api/sites/${site.id}/funnels`, {
            method: 'POST',
            json: { name, steps },
          });
          onDone(f.id);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <p className="text-sm text-muted">
        Steps are counted in order per visitor. Page paths support wildcards like <code>/blog/*</code>; Payment matches any paid order (or a specific product ID).
      </p>
      <Input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Funnel name" aria-label="Funnel name" />
      {steps.map((s, i) => (
        <div key={i} className="flex gap-2">
          <SelectField
            className="input w-28 shrink-0"
            aria-label={`Step ${i + 1} type`}
            value={s.type}
            onValueChange={(value) => {
              const type = value as 'page' | 'goal' | 'payment';
              set(i, { type, value: type === 'payment' ? 'any' : s.type === 'payment' ? '' : s.value });
            }}
          >
            <SelectItem value="page">Page</SelectItem>
            <SelectItem value="goal">Goal</SelectItem>
            <SelectItem value="payment">Payment</SelectItem>
          </SelectField>
          <Input
            className="input"
            aria-label={`Step ${i + 1} value`}
            value={s.type === 'payment' && s.value === 'any' ? '' : s.value}
            onChange={(e) => set(i, { value: s.type === 'payment' ? e.target.value || 'any' : e.target.value })}
            placeholder={s.type === 'page' ? '/pricing' : s.type === 'goal' ? 'signup' : 'Any payment (optional product ID)'}
          />
          <Button variant="raw" size="raw" type="button" className="icon-btn h-9 w-9" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} disabled={steps.length <= 2}>
            <Icon name="close" size={14} />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="raw" size="raw" type="button" className="btn" onClick={() => setSteps((s) => [...s, { type: 'page', value: '' }])} disabled={steps.length >= 10}>
          <Icon name="plus" size={14} />
          Step
        </Button>
        <Button variant="raw" size="raw" className="btn-dark">Save funnel</Button>
        {canCancel && (
          <Button variant="raw" size="raw" type="button" className="btn" onClick={() => onDone()}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  );
}

function VisitorCell({ id, name, email, country, city, device, os, browser, badge, onOpen }: Record<string, any>) {
  return (
    <div className="flex items-center gap-3">
      <Avatar id={id} size={36} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {onOpen ? (
            // The row is clickable with a mouse; the name is the keyboard's way in.
            <Button variant="raw" size="raw"
              type="button"
              className="truncate rounded text-left font-medium"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              aria-label={`Open profile of ${displayName(id, name, email)}`}
            >
              {displayName(id, name, email)}
            </Button>
          ) : (
            <span className="truncate font-medium">{displayName(id, name, email)}</span>
          )}
          {badge}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
          <span className="flex items-center gap-1">
            <Flag cc={country} size={15} /> {city ? `${city}, ` : ''}
            {countryName(country)}
          </span>
          <span className="flex items-center gap-1">
            <DeviceIcon name={device} size={15} /> {device}
          </span>
          <span className="flex items-center gap-1">
            <OSIcon name={os} size={15} /> {os}
          </span>
          <span className="flex items-center gap-1">
            <BrowserIcon name={browser} size={15} /> {browser}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Below 640px the people tables become two-line rows: who and the key number on line 1, every other column in
 * 13px grey on line 2 (wrapping, never dropped). A row that opens a visitor is a real button.
 */
function PhoneRow({ id, name, badge, value, meta, onOpen }: { id: string; name: string; badge?: ReactNode; value: ReactNode; meta: ReactNode[]; onOpen?: () => void }) {
  const body = (
    <>
      <Avatar id={id} size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate font-medium">{name}</span>
          {badge}
          <span className="ml-auto shrink-0 pl-2 text-right tabular-nums">{value}</span>
        </span>
        {/* Fields are spaced, not dotted, so a wrapped line never starts or ends on a stray separator. */}
        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] leading-snug text-muted">
          {meta
            .filter((m) => m !== null && m !== undefined && m !== false && m !== '')
            .map((m, i) => (
              <span key={i} className="inline-flex items-center gap-1 whitespace-nowrap">
                {m}
              </span>
            ))}
        </span>
      </span>
    </>
  );
  const cls = 'flex w-full items-start gap-3 py-3 text-left';
  return onOpen ? (
    <Button variant="raw" size="raw" type="button" className={`${cls} -mx-2 w-[calc(100%+1rem)] rounded-lg px-2 transition-colors duration-150 active:bg-raised`} onClick={onOpen}>
      {body}
    </Button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** "City, Country · Device · OS · Browser", the identity line the desktop cell shows under the name. */
const placeAndTech = (r: Record<string, any>) => [
  <>
    <Flag cc={r.country} size={13} /> {r.city ? `${r.city}, ` : ''}
    {countryName(r.country)}
  </>,
  [r.device, r.os, r.browser].filter(Boolean).join(' · '),
];

function Loading() {
  return (
    <div aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 border-b border-rule py-3 last:border-0">
          <div className="skeleton h-9 w-9 rounded-full" />
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

function matches(r: Record<string, any>, search: string) {
  if (!search) return true;
  const s = search.toLowerCase();
  return ['name', 'email', 'pay_email', 'pay_name', 'source', 'country', 'city', 'visitor_id', 'utm_campaign', 'ref'].some((k) =>
    String(r[k] ?? '')
      .toLowerCase()
      .includes(s),
  );
}

function ShowAll({ total, shown, onClick }: { total: number; shown: number; onClick: () => void }) {
  if (total <= shown) return null;
  return (
    <Button variant="raw" size="raw" type="button" className="card-link mt-3" onClick={onClick}>
      Show all {total}
      <Icon name="down" size={12} />
    </Button>
  );
}

const MATCH_LABELS: Record<string, string> = {
  return_page: 'return page',
  customer: 'earlier payment',
  email: 'email',
  timing: 'checkout click timing',
};

function Journey({ search }: { search: string }) {
  const { site, q, reloadKey, money, openVisitor } = useDash();
  const [all, setAll] = useState(false);
  const [version, setVersion] = useState(0);
  const [rematch, setRematch] = useState<string | null>(null);
  const [reasons, setReasons] = useState<
    {
      id: string;
      name: string | null;
      matched: boolean;
      reason: string | null;
    }[]
  >([]);
  const { data } = useApi<any[]>(`/api/sites/${site.id}/customers?${qs(q)}`, reloadKey + version);
  if (!data) return <Loading />;
  if (!data.length) return <EmptyRow>No payments in this period. Connect Dodo Payments or Stripe in site settings to see who paid and where they came from.</EmptyRow>;
  const unmatched = data.filter((r) => !r.visitor_id).length;
  const rows = data.filter((r) => matches(r, search)).slice(0, all || search ? undefined : 10);
  return (
    <div className="overflow-x-auto">
      {unmatched > 0 && (
        <div className="notice mb-3 flex flex-wrap items-center justify-between gap-3">
          <span>
            {unmatched} payment{unmatched > 1 ? 's' : ''} not linked to a visitor yet.{' '}
            <a className="underline" href={`/site/${site.id}/settings`}>
              Why?
            </a>
          </span>
          <Button variant="raw" size="raw"
            type="button"
            className="btn"
            disabled={rematch === 'working'}
            onClick={async () => {
              setRematch('working');
              let matched = 0, checked = 0;
              const details: typeof reasons = [];
              try {
                // The server works through a few payments per call; 25 calls covers 500.
                for (let after: string | null = null, i = 0; i === 0 || (after && i < 25); i++) {
                  const r: { matched: number; checked: number; details: typeof reasons; next: string | null } = await api(`/api/sites/${site.id}/rematch`, { method: 'POST', json: { after } });
                  matched += r.matched;
                  checked += r.checked;
                  details.push(...r.details);
                  after = r.next;
                }
                setRematch(`Matched ${matched} of ${checked}`);
              } catch {
                setRematch('Could not finish, try again');
              }
              setReasons(details);
              setVersion((v) => v + 1);
            }}
          >
            {rematch === 'working' ? 'Matching…' : (rematch ?? 'Try matching again')}
          </Button>
          {reasons.length > 0 && (
            <ul className="w-full space-y-1 border-t border-warnLine pt-2 text-xs">
              {reasons.map((r) => (
                <li key={r.id}>
                  <b>{r.name ?? r.id}</b>: {r.matched ? 'matched' : 'not matched'}
                  {r.reason ? ` · ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ul className="sm:hidden">
        {rows.map((r, i) => (
          <li key={r.id} className={i ? 'border-t border-rule' : ''}>
            <PhoneRow
              id={r.visitor_id ?? r.id}
              name={displayName(r.visitor_id ?? r.id, r.name ?? r.pay_name, r.email ?? r.pay_email)}
              badge={<span className="pill pill-info">{r.renewal ? 'Returning' : 'Customer'}</span>}
              value={<span className="font-medium text-revenue">{fmtMoney(r.amount, r.currency)}</span>}
              onOpen={r.visitor_id ? () => openVisitor(r.visitor_id) : undefined}
              meta={[
                r.session_id ? r.source : <span className="text-faint">Not attributed</span>,
                r.session_id && (r.utm_campaign || r.ref),
                r.session_id && r.matched_by && r.matched_by !== 'metadata' && `matched by ${MATCH_LABELS[r.matched_by] ?? r.matched_by}`,
                r.first_seen ? `paid after ${fmtAgo(r.ts - r.first_seen)}` : null,
                r.visits > 0 && `${r.visits} visit${r.visits > 1 ? 's' : ''}`,
                fmtDateTime(r.ts, site.timezone),
                ...placeAndTech(r),
              ]}
            />
          </li>
        ))}
      </ul>
      <table className="data-table hidden min-w-[760px] sm:table">
        <thead>
          <tr>
            <th>Visitor</th>
            <th>Source</th>
            <th className="n">Spent</th>
            <th>Time to complete</th>
            <th>Completed at</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.visitor_id ? 'cursor-pointer transition-colors hover:bg-raised' : ''} onClick={() => r.visitor_id && openVisitor(r.visitor_id)}>
              <td>
                <VisitorCell
                  id={r.visitor_id ?? r.id}
                  name={r.name ?? r.pay_name}
                  email={r.email ?? r.pay_email}
                  country={r.country}
                  city={null}
                  device={r.device}
                  os={r.os}
                  browser={r.browser}
                  onOpen={r.visitor_id ? () => openVisitor(r.visitor_id) : undefined}
                  badge={<span className="pill pill-info">{r.renewal ? 'Returning' : 'Customer'}</span>}
                />
              </td>
              <td>
                {r.session_id ? (
                  <div className="flex items-center gap-2">
                    <SourceIcon source={r.source} domain={r.referrer_domain} />
                    <div>
                      <div>{r.source}</div>
                      {(r.utm_campaign || r.ref) && <div className="text-xs text-muted">{r.utm_campaign || r.ref}</div>}
                      {r.matched_by && r.matched_by !== 'metadata' && (
                        <div className="text-xs text-faint">
                          matched by {MATCH_LABELS[r.matched_by] ?? r.matched_by}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <span className="text-faint" title="No visitor id in the payment metadata, and no return-page, email or timing match">
                    Not attributed
                  </span>
                )}
              </td>
              <td className="n font-medium text-revenue">{fmtMoney(r.amount, r.currency)}</td>
              <td>
                {r.first_seen ? fmtAgo(r.ts - r.first_seen) : <span className="text-faint">—</span>}
                {r.visits > 0 && (
                  <div className="text-xs text-muted">
                    {r.visits} visit{r.visits > 1 ? 's' : ''}
                  </div>
                )}
              </td>
              <td className="text-muted">{fmtDateTime(r.ts, site.timezone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!search && <ShowAll total={data.length} shown={all ? data.length : 10} onClick={() => setAll(true)} />}
    </div>
  );
}

function Users({ search }: { search: string }) {
  const { site, q, reloadKey, money, openVisitor } = useDash();
  const [all, setAll] = useState(false);
  const { data } = useApi<any[]>(`/api/sites/${site.id}/visitors?${qs(q)}`, reloadKey);
  if (!data) return <Loading />;
  if (!data.length) return <EmptyRow>No visitors in this period.</EmptyRow>;
  const rows = data.filter((r) => matches(r, search)).slice(0, all || search ? undefined : 10);
  return (
    <div className="overflow-x-auto">
      <ul className="sm:hidden">
        {rows.map((r, i) => (
          <li key={r.visitor_id} className={i ? 'border-t border-rule' : ''}>
            <PhoneRow
              id={r.visitor_id}
              name={displayName(r.visitor_id, r.name, r.email)}
              badge={r.spent > 0 ? <span className="pill pill-info">Customer</span> : null}
              value={r.spent ? <span className="font-medium text-revenue">{money(r.spent)}</span> : <span className="text-faint">—</span>}
              onOpen={() => openVisitor(r.visitor_id)}
              meta={[
                r.source,
                `${fmtNumber(r.sessions)} visit${r.sessions === 1 ? '' : 's'}`,
                `${fmtNumber(r.pageviews)} page${r.pageviews === 1 ? '' : 's'}`,
                fmtDuration(r.duration),
                `seen ${fmtAgo(Date.now() - r.last_seen)} ago`,
                ...placeAndTech(r),
              ]}
            />
          </li>
        ))}
      </ul>
      <table className="data-table hidden min-w-[760px] sm:table">
        <thead>
          <tr>
            <th>Visitor</th>
            <th>Source</th>
            <th className="n">Visits</th>
            <th className="n">Pages</th>
            <th className="n">Time</th>
            <th className="n">Spent</th>
            <th className="n">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.visitor_id} className="cursor-pointer transition-colors hover:bg-raised" onClick={() => openVisitor(r.visitor_id)}>
              <td>
                <VisitorCell
                  id={r.visitor_id}
                  name={r.name}
                  email={r.email}
                  country={r.country}
                  city={r.city}
                  device={r.device}
                  os={r.os}
                  browser={r.browser}
                  onOpen={() => openVisitor(r.visitor_id)}
                  badge={r.spent > 0 ? <span className="pill pill-info">Customer</span> : null}
                />
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <SourceIcon source={r.source} domain={r.referrer_domain} /> {r.source}
                </div>
              </td>
              <td className="n">{r.sessions}</td>
              <td className="n">{r.pageviews}</td>
              <td className="n">{fmtDuration(r.duration)}</td>
              <td className="n">{r.spent ? <span className="font-medium text-revenue">{money(r.spent)}</span> : <span className="text-faint">—</span>}</td>
              <td className="n text-muted">{fmtAgo(Date.now() - r.last_seen)} ago</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!search && <ShowAll total={data.length} shown={all ? data.length : 10} onClick={() => setAll(true)} />}
    </div>
  );
}
