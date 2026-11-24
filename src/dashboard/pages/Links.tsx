import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useReducedMotion } from '../components/Dialog';
import { FlowSample, LinkFlow } from '../components/LinkFlow';
import { Hint } from '../components/CopyIcon';
import { GroupHead, QrPanel, ShowMore, TAP, UrlBox } from '../components/LinkParts';
import { foldId, LinkRows, rowId } from '../components/LinkRows';
import { LinkTable } from '../components/LinkTable';
import { Modal } from '../components/Modal';
import { Button } from '../components/primitives/button';
import { Input } from '../components/primitives/input';
import { SelectField, SelectItem } from '../components/primitives/select-field';
import { Field, LEDGER_PERIODS, SitePage } from '../components/SitePage';
import { BlockError, EmptyRow, Icon, TitleRow, useToast } from '../components/ui';
import { api, type Site } from '../lib/api';
import { decimalsOf, fmtMoney, fmtNumber } from '../lib/format';
import {
  ARCHIVED, byRevenue, count, FIRST_ROWS, fmtEach, groupLinks, groupOf, MORE_ROWS, nameOf, PLACES, planLink, REF_PATTERN, rowsToShow, searchLinks, suggestRef, typedRef, type GroupId,
  type SavedLink,
} from '../lib/links';
import { loadPref, savePref } from '../lib/prefs';
import { useApi } from '../lib/useApi';

const FIELD = 'input h-11 frame:h-9';
const VIEWS = { bars: 'Bars', table: 'Table' } as const;
type View = keyof typeof VIEWS;
const VIEW_PREF = 'dm_links_view';
/** Search appears once the list is longer than this. */
const SEARCH_OVER = 8;
const TABLE_ROWS = 50;

/** ?new=1 opens the form once, so a refresh or a copied address does not open it again. */
function takeNewParam() {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('new')) return;
  q.delete('new');
  window.history.replaceState(window.history.state, '', window.location.pathname + (q.toString() ? `?${q}` : ''));
}

export function Links() {
  return <SitePage title="Links">{(site) => <SiteLinks key={site.id} site={site} />}</SitePage>;
}

const NONE: SavedLink[] = [];

/** A callback that never changes identity, so the memoised rows and flow do not redraw for it. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R) {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}

function SiteLinks({ site }: { site: Site }) {
  const [period, setPeriod] = useState('all');
  const [view, setView] = useState<View>(() => (loadPref<string>(VIEW_PREF, 'bars') === 'table' ? 'table' : 'bars'));
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  /** Whether the last thing opened or closed was by pointer: only then does it move. */
  const [moving, setMoving] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const [folds, setFolds] = useState<Partial<Record<GroupId, boolean>>>({});
  const [limits, setLimits] = useState<Partial<Record<GroupId, number>>>({});
  const [tableRows, setTableRows] = useState(TABLE_ROWS);
  const [goTo, setGoTo] = useState<{ id: string; focus?: boolean; scroll?: ScrollBehavior } | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get('new') === '1');
  const [qr, setQr] = useState<SavedLink | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  /** What was just done to a link, until the list has caught up. */
  const after = useRef<{ did: 'archived' | 'restored' | 'created'; id: string } | null>(null);
  /** A link made in the form that is still open. */
  const made = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const toast = useToast();
  useEffect(takeNewParam, []);

  // Archived links come along: they have their own group, and the form knows what it restored.
  const { data, error, loading } = useApi<{ links: SavedLink[] }>(`/api/sites/${site.id}/links?period=${period}&include_archived=true`, reload);
  const all = data?.links ?? NONE;
  const active = useMemo(() => all.filter((l) => !l.archived_at), [all]);
  const hidden = all.length - active.length;
  const searchable = all.length > SEARCH_OVER;
  const query = searchable ? text.trim() : '';
  const found = useMemo(() => searchLinks(all, query), [all, query]);
  const groups = useMemo(() => groupLinks(found), [found]);

  const decimals = decimalsOf(site.currency);
  const money = useCallback((minor: number) => fmtMoney(minor, site.currency, decimals), [site.currency, decimals]);
  const each = useCallback((minor: number) => fmtEach(minor, site.currency, decimals), [site.currency, decimals]);
  const created = useCallback(
    (l: SavedLink) => new Date(l.created_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: site.timezone }),
    [site.timezone],
  );
  const totals = active.reduce((t, l) => ({ revenue: t.revenue + l.revenue, visitors: t.visitors + l.visitors }), { revenue: 0, visitors: 0 });

  const isOpen = (g: GroupId) => {
    if (query || g === 'earning' || g === 'visited') return true;
    // Links without visits are only in the way once there are others to look at.
    return folds[g] ?? (g === 'unvisited' && !groups.earning.length && !groups.visited.length);
  };
  // One scale for the whole list, whatever the search or "Show more" leaves on screen.
  const scaled = isOpen('archived') ? all : active;
  const maxVisitors = scaled.reduce((m, l) => Math.max(m, l.visitors), 0);
  const maxRevenue = scaled.reduce((m, l) => Math.max(m, l.revenue), 0);
  const tabled = useMemo(() => found.filter((l) => !l.archived_at).sort(byRevenue), [found]);
  const tabledAll = isOpen('archived') ? [...tabled, ...groups.archived] : tabled;
  const positive = tabledAll.reduce((a, l) => a + Math.max(0, l.revenue), 0);

  /** Opens a link's row, making whatever hides it give way. */
  const reveal = useStable((id: string, { keepSearch = false, byPointer = false } = {}) => {
    const l = all.find((x) => x.id === id);
    if (!l) return;
    const g = groupOf(l);
    const rows = rowsToShow(groupLinks(all)[g].findIndex((x) => x.id === id));
    if (!keepSearch) setText('');
    setFolds((f) => ({ ...f, [g]: true }));
    setLimits((m) => ({ ...m, [g]: Math.max(m[g] ?? FIRST_ROWS, rows) }));
    setTableRows((n) => Math.max(n, 1 + [...active].sort(byRevenue).findIndex((x) => x.id === id)));
    setMoving(byPointer);
    setOpen(id);
  });
  const onPick = useStable((id: string, byPointer: boolean) => {
    // Links open in the bars. The remembered choice stays as it was.
    setView('bars');
    reveal(id, { byPointer });
    setGoTo({ id, focus: true, scroll: byPointer && !reducedMotion ? 'smooth' : 'auto' });
  });
  const onOpen = useStable((id: string, byPointer: boolean) => {
    setMoving(byPointer);
    setOpen((o) => (o === id ? null : id));
  });

  useEffect(() => {
    if (!goTo) return;
    if (goTo.focus) document.getElementById(rowId(goTo.id))?.focus({ preventScroll: true });
    if (goTo.scroll) document.getElementById(`${rowId(goTo.id)}-item`)?.scrollIntoView({ block: 'nearest', behavior: goTo.scroll });
  }, [goTo]);

  // The row moves with the reload: keep keyboard focus near where it was, and show where a link went.
  useEffect(() => {
    const done = after.current;
    if (!done || !data) return;
    after.current = null;
    const fold = document.getElementById(foldId('archived'));
    const row = document.getElementById(rowId(done.id));
    if (done.did === 'created') {
      reveal(done.id);
      if (creating) made.current = done.id;
      else setGoTo({ id: done.id, scroll: 'auto' });
    } else if (done.did === 'restored' && view === 'bars') {
      reveal(done.id, { keepSearch: true });
      setGoTo({ id: done.id, focus: true, scroll: 'auto' });
    } else {
      (fold instanceof HTMLButtonElement ? fold : (row ?? newButton.current))?.focus();
    }
  }, [data]);

  const changed = () => setReload((k) => k + 1);
  async function change(l: SavedLink, did: 'archived' | 'restored', send: () => Promise<unknown>, said: string) {
    setBusy(l.id);
    try {
      await send();
      toast.show(said);
      if (did === 'archived') setOpen((o) => (o === l.id ? null : o));
      after.current = { did, id: l.id };
      changed();
    } catch (e) {
      toast.show((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }
  const onArchive = useStable((l: SavedLink) =>
    change(l, 'archived', () => api(`/api/sites/${site.id}/links/${l.id}`, { method: 'DELETE' }), `${nameOf(l)} archived. The link still works.`),
  );
  const onRestore = useStable((l: SavedLink) =>
    // Saving the same ref and page again brings an archived link back.
    change(l, 'restored', () => api(`/api/sites/${site.id}/links`, { method: 'POST', json: { ref: l.ref, path: l.destination } }), `${nameOf(l)} restored`),
  );
  const onFold = (g: GroupId, byPointer: boolean) => {
    setMoving(byPointer);
    setFolds((f) => ({ ...f, [g]: !isOpen(g) }));
  };
  const onMore = (g: GroupId) => {
    const shown = limits[g] ?? FIRST_ROWS;
    setLimits((m) => ({ ...m, [g]: shown + MORE_ROWS }));
    // The button can go away: carry on from the first new row.
    setGoTo({ id: groups[g][shown].id, focus: true });
  };
  const closeNew = () => {
    setCreating(false);
    // Focus goes back to the button that opened the form, unless that went away with the empty page.
    if (made.current) setGoTo({ id: made.current, focus: true, scroll: 'auto' });
    made.current = null;
  };
  // The open row, while it is on screen, keeps its ribbon marked.
  const shown = view === 'bars' ? found.find((l) => l.id === open) : undefined;
  const kept = shown && isOpen(groupOf(shown)) && groups[groupOf(shown)].indexOf(shown) < (limits[groupOf(shown)] ?? FIRST_ROWS) ? shown.id : null;
  const empty = !!data && !error && all.length === 0;
  const rowActions = { money, created, busy, onQr: setQr, onArchive, onRestore };

  return (
    <div>
      <TitleRow
        title="Links"
        actions={
          <>
            <label className="sr-only" htmlFor="links-period">
              Period
            </label>
            <SelectField id="links-period" className="input h-11 w-auto frame:h-8" value={period} onValueChange={setPeriod}>
              {LEDGER_PERIODS.map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectField>
            <Button ref={newButton} variant="raw" size="raw" type="button" className={`${empty ? 'btn' : 'btn-dark'} ${TAP}`} onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New link
            </Button>
          </>
        }
      />

      {active.length > 0 && (
        <p className="mb-3 text-sm text-muted">
          <span className="font-medium tabular-nums text-ink">{money(totals.revenue)}</span> from {count(totals.visitors, 'visitor')} across {count(active.length, 'link')}
        </p>
      )}

      <LinkFlow links={all} hot={hot} kept={kept} onHot={setHot} onPick={onPick} money={money} each={each} />

      {all.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {searchable && (
            <div className="relative min-w-[200px] flex-1">
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                type="search"
                className={`${FIELD} pl-9`}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setMoving(false);
                  setLimits({});
                }}
                onKeyDown={(e) => e.key === 'Escape' && setText('')}
                placeholder={`Search ${fmtNumber(all.length)} links`}
                aria-label="Search links"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <span className="sr-only" role="status">
                {query && `${count(found.length, 'link')} found`}
              </span>
            </div>
          )}
          <div className="tabs" role="group" aria-label="Show links as">
            {(Object.keys(VIEWS) as View[]).map((v) => (
              <Hint key={v} text={VIEWS[v]}>
                <Button
                  variant="raw"
                  size="raw"
                  type="button"
                  className={`tab link-view ${v === view ? 'tab-active' : ''}`}
                  aria-label={VIEWS[v]}
                  aria-pressed={v === view}
                  onClick={() => {
                    setView(v);
                    setMoving(false);
                    savePref(VIEW_PREF, v);
                  }}
                >
                  <Icon name={v} />
                </Button>
              </Hint>
            ))}
          </div>
        </div>
      )}

      {empty ? (
        <section className="card link-empty" aria-labelledby="links-empty">
          <div>
            <h2 id="links-empty" className="text-base font-semibold">
              See which post brings you customers
            </h2>
            <p className="mt-1 text-sm text-muted">Make a link for each place you share: a post, an ad, a newsletter or a QR code on a flyer. Its visitors, customers and revenue show up here.</p>
            <Button variant="raw" size="raw" type="button" className={`btn-dark mt-4 ${TAP}`} onClick={() => setCreating(true)}>
              Make your first link
            </Button>
          </div>
          <FlowSample />
        </section>
      ) : (
        <div className="card px-4 py-1" data-moving={moving ? '' : undefined}>
          {error && (
            <div className="py-3">
              <BlockError what={`Couldn't load links: ${error}.`} onRetry={changed} />
            </div>
          )}
          {loading && !data && !error && (
            <div aria-busy="true" className="py-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex h-11 items-center gap-4">
                  <div className="skeleton h-4 w-40 max-w-full" />
                  <div className="skeleton h-3 flex-1" />
                  <div className="skeleton h-4 w-16" />
                </div>
              ))}
            </div>
          )}
          {data && active.length === 0 && !query && (
            <div className="py-3">
              <EmptyRow>
                Every link is archived. Archived links still work.{' '}
                <Button variant="raw" size="raw" type="button" className="card-link -my-3 py-3 underline" onClick={() => setCreating(true)}>
                  Make a new link
                </Button>
              </EmptyRow>
            </div>
          )}
          {query && found.length === 0 && <p className="break-words py-3 text-sm text-muted">No links match &ldquo;{query}&rdquo;. Search looks at names, link tags and pages.</p>}

          {view === 'bars' && found.length > 0 && (
            <LinkRows
              groups={groups}
              searching={!!query}
              allTime={period === 'all'}
              isOpen={isOpen}
              limits={limits}
              onFold={onFold}
              onMore={onMore}
              open={open}
              onOpen={onOpen}
              hot={hot}
              onHot={setHot}
              maxVisitors={maxVisitors}
              maxRevenue={maxRevenue}
              each={each}
              {...rowActions}
            />
          )}
          {view === 'table' && tabled.length > 0 && <LinkTable rows={tabled.slice(0, tableRows)} positive={positive} {...rowActions} />}
          {view === 'table' && tabled.length > tableRows && <ShowMore left={tabled.length - tableRows} step={TABLE_ROWS} group="the table" onMore={() => setTableRows((n) => n + TABLE_ROWS)} />}
          {view === 'table' && groups.archived.length > 0 && (
            <section aria-labelledby={foldId('archived')} className={tabled.length ? 'border-t border-rule' : ''}>
              <GroupHead id={foldId('archived')} title="Archived" total={groups.archived.length} open={isOpen('archived')} onToggle={query ? undefined : (byPointer) => onFold('archived', byPointer)} />
              {isOpen('archived') && <p className="pb-2 text-xs text-muted">{ARCHIVED}</p>}
              {isOpen('archived') && <LinkTable rows={groups.archived} positive={positive} {...rowActions} />}
            </section>
          )}
        </div>
      )}

      <Modal open={creating} onClose={closeNew} title="New link" width="max-w-xl">
        {creating && (
          <NewLink
            site={site}
            known={all}
            onSaved={(id) => {
              after.current = { did: 'created', id };
              changed();
            }}
            onClose={closeNew}
          />
        )}
      </Modal>
      <Modal open={qr !== null} onClose={() => setQr(null)} title={qr ? `QR code for ${nameOf(qr)}` : ''} width="max-w-md">
        {qr && <QrPanel link={qr} />}
      </Modal>
      {toast.node}
    </div>
  );
}

function NewLink({ site, known, onSaved, onClose }: { site: Site; known: SavedLink[]; onSaved: (id: string) => void; onClose: () => void }) {
  const [page, setPage] = useState('/');
  const [place, setPlace] = useState(PLACES[0]);
  const [name, setName] = useState('');
  const [typed, setTyped] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: SavedLink; created: boolean; restored: boolean } | null>(null);

  const ref = typed ?? suggestRef(place, name);
  const refOk = REF_PATTERN.test(ref);
  const plan = planLink(site.domain, page, place);
  const pageError = 'error' in plan ? plan.error : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if ('error' in plan || !refOk || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // Without a label of its own, the link goes by its name in the list.
      const shown = label.trim() || name.trim();
      const r = await api<{ created: boolean; link: SavedLink }>(`/api/sites/${site.id}/links`, {
        method: 'POST',
        json: { ref, path: plan.path, ...(shown ? { label: shown } : {}) },
      });
      setDone({ ...r, restored: !r.created && known.some((l) => l.id === r.link.id && !!l.archived_at) });
      onSaved(r.link.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Ready
        {...done}
        onClose={onClose}
        onAnother={() => {
          setDone(null);
          setName('');
          setTyped(null);
          setLabel('');
        }}
      />
    );
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <Field label="Page it opens" id="nl-page" hint={pageError ? undefined : `A path like /pricing, or a full address on ${site.domain}.`}>
        <Input
          id="nl-page"
          className={FIELD}
          value={page}
          onChange={(e) => setPage(e.target.value)}
          maxLength={500}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-autofocus=""
          aria-invalid={!!pageError}
          aria-describedby={pageError ? 'nl-page-error' : 'nl-page-hint'}
        />
        {pageError && (
          <p id="nl-page-error" className="mt-1.5 text-xs text-negative" role="alert">
            {pageError}
          </p>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Where you'll post it"
          id="nl-place"
          hint={place.source ? `Visits count as ${place.label}, even when the app hides where they came from.` : 'Adds only the link tag below, no source.'}
        >
          <SelectField id="nl-place" className={FIELD} value={place.label} onValueChange={(v) => setPlace(PLACES.find((p) => p.label === v)!)} aria-describedby="nl-place-hint">
            {PLACES.map((p) => (
              <SelectItem value={p.label} key={p.label}>
                {p.label}
              </SelectItem>
            ))}
          </SelectField>
        </Field>
        <Field label="Name" id="nl-name" hint="What you're posting, in a word or two.">
          <Input id="nl-name" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Launch post" aria-describedby="nl-name-hint" />
        </Field>
        <Field label="Link tag" id="nl-ref" hint="Filled in from the name. Lowercase letters, digits and hyphens, 2 to 49 characters. Use each link tag once.">
          <Input
            id="nl-ref"
            className={`${FIELD} font-mono`}
            value={ref}
            onChange={(e) => setTyped(typedRef(e.target.value))}
            onBlur={() => typed === '' && setTyped(null)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={suggestRef(place, 'launch')}
            aria-invalid={ref !== '' && !refOk}
            aria-describedby="nl-ref-hint"
          />
        </Field>
        <Field label="Label (optional)" id="nl-label" hint="Shown in your list. Left empty, the name is used.">
          <Input id="nl-label" className={FIELD} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} aria-describedby="nl-label-hint" />
        </Field>
      </div>
      {!('error' in plan) && (
        <div>
          <p className="label">Preview</p>
          <UrlBox url={plan.url(ref || '…')} />
        </div>
      )}
      {err && (
        <p className="text-sm text-negative" role="alert">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="raw" size="raw" type="button" className={`btn ${TAP}`} onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="raw" size="raw" type="submit" className={`btn-dark ${TAP}`} disabled={busy || !refOk || !!pageError}>
          {busy ? 'Creating link' : 'Create link'}
        </Button>
      </div>
    </form>
  );
}

/** The saved link, ready to copy. */
function Ready({ link, created, restored, onClose, onAnother }: { link: SavedLink; created: boolean; restored: boolean; onClose: () => void; onAnother: () => void }) {
  const status = useRef<HTMLParagraphElement>(null);
  // The button that was pressed is gone with the form.
  useEffect(() => status.current?.focus(), []);
  return (
    <div className="space-y-4">
      <p ref={status} tabIndex={-1} role="status" className="text-sm outline-none">
        {created ? (
          <>
            <b className="font-medium">{nameOf(link)}</b> is ready to share.
          </>
        ) : (
          <>
            This link already existed as <b className="font-medium">{nameOf(link)}</b>, so no new one was made.{restored && ' It was archived and is back in your list.'}
          </>
        )}
      </p>
      <QrPanel link={link} />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="raw" size="raw" type="button" className={`btn ${TAP}`} onClick={onAnother}>
          Make another
        </Button>
        <Button variant="raw" size="raw" type="button" className={`btn-dark ${TAP}`} onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
