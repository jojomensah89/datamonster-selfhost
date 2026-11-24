import { DatePicker } from '../components/primitives/date-picker';
import { Input } from '../components/primitives/input';
import { SelectField, SelectItem } from '../components/primitives/select-field';
import { Button } from '../components/primitives/button';
import { Capsule } from '../components/Capsule';
import { useState, type FormEvent } from 'react';
import { checkWords, fmtDay, STATUS_LABEL, StatusPill, type Launch } from '../components/LaunchesBlock';
import { Modal } from '../components/Modal';
import { Field, LEDGER_PERIODS, SitePage } from '../components/SitePage';
import { BlockError, EmptyRow, Icon, TitleRow, useToast } from '../components/ui';
import { api, type Site } from '../lib/api';
import { decimalsOf, fmtMoney, fmtNumber } from '../lib/format';
import { useApi } from '../lib/useApi';

/** Mirrors TRANSITIONS in src/agent/placements.ts: the statuses a launch can move to by hand. */
const NEXT: Record<Launch['status'], Launch['status'][]> = {
  draft: ['submitted', 'in_review', 'live'],
  submitted: ['draft', 'in_review', 'live', 'rejected'],
  in_review: ['submitted', 'live', 'rejected'],
  live: ['in_review', 'removed'],
  rejected: ['draft', 'submitted', 'in_review'],
  removed: ['live', 'submitted'],
};
const ALL_STATUSES = Object.keys(STATUS_LABEL) as Launch['status'][];

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export function Launches() {
  return <SitePage title="Launches">{(site) => <SiteLaunches key={site.id} site={site} />}</SitePage>;
}

function SiteLaunches({ site }: { site: Site }) {
  const [period, setPeriod] = useState('all');
  const [archived, setArchived] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Launch | 'new' | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const toast = useToast();
  const { data, error, loading } = useApi<{ placements: Launch[] }>(`/api/sites/${site.id}/placements?period=${period}${archived ? '&include_archived=true' : ''}`, reload);
  const rows = data?.placements ?? [];
  const decimals = decimalsOf(site.currency);
  const money = (minor: number) => fmtMoney(minor, site.currency, decimals);
  const gone = rows.filter((l) => l.needs_attention);
  const live = rows.filter((l) => l.status === 'live' && !l.archived_at);
  // Listings the daily check has missed for over 30 hours: said plainly, not as an alarm.
  const overdue = rows.filter((l) => l.overdue && !l.needs_attention && !l.archived_at);
  const totals = rows
    .filter((l) => !l.archived_at)
    .reduce(
      (t, l) => ({
        revenue: t.revenue + l.revenue,
        visitors: t.visitors + l.visitors,
      }),
      { revenue: 0, visitors: 0 },
    );

  async function check(l: Launch) {
    setChecking(l.id);
    try {
      const r = await api<{ checked: boolean; placement: Launch }>(`/api/sites/${site.id}/placements/${l.id}/verify`, { method: 'POST' });
      const words: Record<string, string> = {
        ok: 'The listing is up',
        missing: 'The listing is gone',
        error: "Couldn't reach the listing",
        unknown: "Couldn't confirm the listing",
      };
      toast.show(r.checked ? words[r.placement.last_check_result ?? 'unknown'] : 'Checked less than a minute ago');
      setReload((k) => k + 1);
    } catch (e) {
      toast.show((e as Error).message, true);
    } finally {
      setChecking(null);
    }
  }
  async function restore(l: Launch) {
    try {
      await api(`/api/sites/${site.id}/placements/${l.id}`, {
        method: 'PATCH',
        json: { archived: false },
      });
      toast.show(`${l.name} restored`);
      setReload((k) => k + 1);
    } catch (e) {
      toast.show((e as Error).message, true);
    }
  }

  const actions = (l: Launch) =>
    l.archived_at ? (
      <Button variant="raw" size="raw" type="button" className="btn-ghost" onClick={() => restore(l)}>
        Restore
      </Button>
    ) : (
      <>
        {l.listing_url && (
          <Button variant="raw" size="raw" type="button" className="btn-ghost" disabled={checking === l.id} onClick={() => check(l)} aria-label={`Check ${l.name} listing now`}>
            {checking === l.id ? 'Checking' : 'Check'}
          </Button>
        )}
        <Button variant="raw" size="raw" type="button" className="btn-ghost" onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`}>
          Edit
        </Button>
      </>
    );

  const sub = (l: Launch) => (
    <>
      {l.listing_url ? (
        <a href={l.listing_url} target="_blank" rel="noreferrer noopener" className="hover:text-ink hover:underline">
          {host(l.listing_url)}
        </a>
      ) : (
        'No listing link'
      )}
      {l.launched_on && <> · launched {fmtDay(l.launched_on)}</>}
      {l.archived_at && <> · archived</>}
    </>
  );

  return (
    <div>
      <TitleRow
        title="Launches"
        actions={
          <>
            <label className="sr-only" htmlFor="launch-period">
              Period
            </label>
            <SelectField id="launch-period" className="input w-auto" value={period} onValueChange={(value) => setPeriod(value)}>
              {LEDGER_PERIODS.map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectField>
            <Button variant="raw" size="raw" type="button" className="btn-dark" onClick={() => setEditing('new')}>
              <Icon name="plus" size={14} />
              Add a launch
            </Button>
          </>
        }
      />

      {gone.length > 0 && (
        <div className="notice mb-4" role="status">
          {gone.map((l) => l.name).join(', ')} {gone.length === 1 ? 'was' : 'were'} live but the listing {gone.length === 1 ? 'is' : 'are'} gone on the last check
          {gone[0].last_check_detail ? ` (${gone[0].last_check_detail})` : ''}. Open the listing, then mark it removed or check again.
        </div>
      )}

      {data && rows.length > 0 && (
        <p className="mb-3 text-sm text-muted">
          <span className="font-medium text-ink tabular-nums">{money(totals.revenue)}</span> from {fmtNumber(totals.visitors)} visitors across {rows.filter((l) => !l.archived_at).length} launches ·{' '}
          {live.length} live
          {' · '}live and in-review listings are checked daily
          {overdue.length > 0 && (
            <>
              {' · '}
              {overdue.length === 1 ? `${overdue[0].name} has` : `${overdue.length} listings have`} not been checked for over a day
            </>
          )}
        </p>
      )}

      <div className="card px-4 py-1">
        {error && !data && (
          <div className="py-3">
            <BlockError what={`Couldn't load launches: ${error}.`} onRetry={() => setReload((k) => k + 1)} />
          </div>
        )}
        {loading && !data && !error && (
          <div aria-busy="true" className="py-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 py-3">
                <div className="flex-1">
                  <div className="skeleton h-4 w-40" />
                  <div className="skeleton mt-1.5 h-3 w-56" />
                </div>
                <div className="skeleton h-[22px] w-16 rounded-full" />
                <div className="skeleton h-4 w-20" />
              </div>
            ))}
          </div>
        )}
        {data && rows.length === 0 && (
          <div className="py-3">
            <EmptyRow>
              {archived ? 'No launches, archived or not.' : 'No launches yet. Add a place that lists or features you, such as a local directory, a newsletter or Product Hunt, and its visitors, customers and revenue show here.'}{' '}
              <Button variant="raw" size="raw" type="button" className="card-link" onClick={() => setEditing('new')}>
                Add a launch
              </Button>
            </EmptyRow>
          </div>
        )}

        {rows.length > 0 && (
          <>
            {/* Desktop and tablet: a table. */}
            <table className="data-table hidden lg:table">
              <thead>
                <tr>
                  <th>Launch</th>
                  <th>Status</th>
                  <th>Listing</th>
                  <th className="n">Visitors</th>
                  <th className="n">Customers</th>
                  <th className="n">Revenue</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className={l.archived_at ? 'text-muted' : ''}>
                    <td className="max-w-[280px]">
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
                      <span className="mt-0.5 block truncate text-xs text-muted">{sub(l)}</span>
                    </td>
                    <td>
                      <StatusPill launch={l} />
                    </td>
                    <td className="whitespace-nowrap text-muted" title={l.last_check_detail ?? undefined}>
                      {checkWords(l)}
                    </td>
                    <td className="n tabular-nums">{fmtNumber(l.visitors)}</td>
                    <td className="n tabular-nums">{fmtNumber(l.customers)}</td>
                    <td className={`n tabular-nums ${l.revenue ? 'font-medium' : 'text-muted'}`}>{money(l.revenue)}</td>
                    <td className="w-[1%] whitespace-nowrap text-right">{actions(l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Phone: two-line rows. */}
            <ul className="lg:hidden">
              {rows.map((l, i) => (
                <li key={l.id} className={`py-3 ${i ? 'border-t border-rule' : ''}`}>
                  <div className="flex items-center gap-3">
                    <b className="min-w-0 flex-1 truncate font-medium">{l.name}</b>
                    <StatusPill launch={l} />
                    <span className={`w-20 text-right tabular-nums ${l.revenue ? 'font-medium' : 'text-muted'}`}>{money(l.revenue)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted">
                    <span className="min-w-0 flex-1 truncate">
                      {checkWords(l)} · {fmtNumber(l.visitors)} visitors · {fmtNumber(l.customers)} paid
                    </span>
                  </div>
                  <Capsule
                    metric="revenue"
                    ratio={
                      Math.max(0, l.revenue) /
                      Math.max(
                        1,
                        rows.reduce((a, v) => a + Math.max(0, v.revenue), 0),
                      )
                    }
                    caption={`${Math.round((Math.max(0, l.revenue) / Math.max(1, rows.reduce((a, v) => a + Math.max(0, v.revenue), 0))) * 100)}% of returned positive launch revenue`}
                  />
                  <div className="-ml-3 mt-1 flex gap-1">{actions(l)}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {data && (
        <Button variant="raw" size="raw" type="button" className="btn-ghost mt-3 -ml-3" onClick={() => setArchived((a) => !a)} aria-pressed={archived}>
          {archived ? 'Hide archived launches' : 'Show archived launches'}
        </Button>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add a launch' : 'Edit launch'} width="max-w-xl">
        {editing !== null && (
          <LaunchForm
            site={site}
            launch={editing === 'new' ? null : editing}
            onDone={(msg) => {
              setEditing(null);
              if (msg) toast.show(msg);
              setReload((k) => k + 1);
            }}
          />
        )}
      </Modal>
      {toast.node}
    </div>
  );
}

function LaunchForm({ site, launch, onDone }: { site: Site; launch: Launch | null; onDone: (msg?: string) => void }) {
  const [f, setF] = useState({
    name: launch?.name ?? '',
    listing_url: launch?.listing_url ?? '',
    launched_on: launch?.launched_on ?? '',
    status: launch?.status ?? ('' as Launch['status'] | ''),
    match_source: launch?.match_source ?? '',
    match_domain: launch?.match_domain ?? '',
    match_ref: launch?.match_ref ?? '',
    notes: launch?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const statuses = launch ? [launch.status, ...NEXT[launch.status]] : ALL_STATUSES;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string> = { ...f };
      if (!launch) {
        // New launch: leave out what was not filled in, so the server's defaults apply.
        for (const k of Object.keys(body)) if (!body[k]) delete body[k];
        const r = await api<{ created: boolean }>(`/api/sites/${site.id}/placements`, { method: 'POST', json: body });
        onDone(r.created ? `${f.name} added` : `${f.name} already exists`);
      } else {
        if (body.status === launch.status) delete body.status;
        await api(`/api/sites/${site.id}/placements/${launch.id}`, {
          method: 'PATCH',
          json: body,
        });
        onDone('Saved');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!launch) return;
    setBusy(true);
    try {
      await api(`/api/sites/${site.id}/placements/${launch.id}`, {
        method: 'DELETE',
      });
      onDone(`${launch.name} archived`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <Field label="Name" id="lf-name">
        <Input id="lf-name" className="input" required maxLength={80} value={f.name} onChange={set('name')} placeholder="Local directory" autoFocus />
      </Field>
      <Field label="Listing page" id="lf-url" hint="Checked daily while the launch is live or in review.">
        <Input
          id="lf-url"
          className="input"
          type="url"
          inputMode="url"
          value={f.listing_url}
          onChange={set('listing_url')}
          placeholder="https://directory.example/your-business"
          aria-describedby="lf-url-hint"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Status" id="lf-status">
          <SelectField id="lf-status" className="input" value={f.status} onValueChange={value => (set('status'))({ target: { value } })}>
            {!launch && <SelectItem value="">{f.listing_url ? 'Submitted' : 'Draft'}</SelectItem>}
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectField>
        </Field>
        <Field label="Launch day" id="lf-day">
          <DatePicker id="lf-day" className="input"  value={f.launched_on} onValueChange={value => (set('launched_on'))({ target: { value } })} />
        </Field>
      </div>
      <fieldset>
        <legend className="label">Which visits count</legend>
        <p className="hint mb-3 mt-0" id="lf-match-hint">
          A visit counts when it matches any of these. Left empty, visits whose source is the name count.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input className="input" aria-label="Source name" aria-describedby="lf-match-hint" value={f.match_source} onChange={set('match_source')} placeholder="Source, e.g. Local directory" />
          <Input className="input" aria-label="Referrer domain" aria-describedby="lf-match-hint" value={f.match_domain} onChange={set('match_domain')} placeholder="directory.example" />
          <Input className="input" aria-label="Ref tag" aria-describedby="lf-match-hint" value={f.match_ref} onChange={set('match_ref')} placeholder="ref, e.g. directory" />
        </div>
      </fieldset>
      <Field label="Notes" id="lf-notes">
        <Input id="lf-notes" className="input" maxLength={500} value={f.notes} onChange={set('notes')} />
      </Field>
      {err && (
        <p className="text-sm text-negative" role="alert">
          {err}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {launch && !launch.archived_at ? (
          <Button variant="raw" size="raw" type="button" className="btn-danger" onClick={archive} disabled={busy}>
            Archive
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="raw" size="raw" type="button" className="btn" onClick={() => onDone()} disabled={busy}>
            Cancel
          </Button>
          <Button variant="raw" size="raw" type="submit" className="btn-dark" disabled={busy || !f.name.trim()}>
            {launch ? 'Save' : 'Add launch'}
          </Button>
        </div>
      </div>
    </form>
  );
}
