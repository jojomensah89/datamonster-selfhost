import { Button } from './primitives/button';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { displayName } from '../../shared/names';
import { useDash } from '../lib/context';
import { countryName, fmtAgo, fmtMoney, fmtNumber } from '../lib/format';
import { groupByCity, groupKeyOf, placeName, snapshotText, useRealtime, type FeedItem, type LiveVisitor, type Realtime } from '../lib/realtime';
import { playPayment, playVisitor, unlockAudio } from '../lib/sounds';
import { resolvedTheme } from '../lib/theme';
import { Dialog, useReducedMotion } from './Dialog';
import { Favicon, Flag, SourceIcon } from './Icons';
import { LiveMap, type MapPlace, type MapSelection, type Ripple } from './live/LiveMap';
import { copyText, Icon } from './ui';
import type { MapMode } from './live/geo';

const POLL_MS = 5000;
const ROWS = 50;
const FEW = 8;

function pref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** The live map as a full-screen dialog. Its contents mount once the dialog is on the page. */
export default function LiveView({ onClose }: { onClose: () => void }) {
  const { site } = useDash();
  const [covered, setCovered] = useState(false);
  // The view is opaque and full-screen: the dashboard under it stops painting. Restored before the dialog hands
  // focus back to its trigger (this cleanup runs before the Dialog's own).
  useLayoutEffect(() => {
    document.documentElement.classList.add('live-open');
    return () => document.documentElement.classList.remove('live-open');
  }, []);
  return (
    <Dialog
      open
      onClose={onClose}
      label={`Live view of ${site.domain}`}
      className="fixed inset-0 z-50"
      // Escape inside a merged pin's city list lets go of the selection there, not the whole view.
      canEscape={() => !document.fullscreenElement && !document.activeElement?.closest('[data-map-card]')}
      onCoveredChange={setCovered}
    >
      <Live onClose={onClose} covered={covered} />
    </Dialog>
  );
}

type Selection = MapSelection & { visitorIds: string[] };

function Live({ onClose, covered }: { onClose: () => void; covered: boolean }) {
  const { site, openVisitor } = useDash();
  const rootRef = useRef<HTMLDivElement>(null);
  const { data, error, fetchedAt, reload } = useRealtime(site.id, POLL_MS);
  const money = (m: number) => fmtMoney(m, data?.currency ?? site.currency, data?.decimals);

  // Opens in the app's theme; the sun/moon button flips it for this visit.
  const [theme, setTheme] = useState(() => resolvedTheme());
  const [mode, setMode] = useState<MapMode>(() => (pref('dm_live_projection', 'globe') === 'globe' ? 'globe' : 'flat'));
  const [sound, setSound] = useState(() => pref<string>('dm_live_sound', 'off') === 'on');
  // Motion runs unless reduced motion is set, the viewer paused it, the tab is hidden, or a dialog covers this one.
  const reduced = useReducedMotion();
  const [motionOn, setMotionOn] = useState(() => pref<string>('dm_live_rotate', 'on') === 'on');
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const animate = motionOn && !reduced && visible && !covered;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [announce, setAnnounce] = useState('');
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => savePref('dm_live_projection', mode), [mode]);
  useEffect(() => savePref('dm_live_sound', sound ? 'on' : 'off'), [sound]);
  useEffect(() => savePref('dm_live_rotate', motionOn ? 'on' : 'off'), [motionOn]);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  // "x min ago" stays current between polls.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  // New payments ripple once from their city (never the ones already there when the view opened); sounds as before.
  const known = useRef<{ visitors: Set<string>; events: Set<string> } | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  useEffect(() => {
    if (!data) return;
    const visitors = new Set(data.visitors.map((v) => v.visitor_id));
    const money = data.feed.filter((f) => f.type === 'payment' || f.type === 'refund');
    const events = new Set(money.map((f) => f.id));
    const prev = known.current;
    if (prev) {
      const fresh = money.filter((f) => !prev.events.has(f.id));
      const now = Date.now();
      const placed = fresh.filter((f) => f.lat !== null && f.lon !== null).map((f) => ({ id: f.id, lat: f.lat!, lon: f.lon!, kind: f.type as Ripple['kind'], at: now }));
      setRipples((r) => [...r.filter((x) => now - x.at < 8000), ...placed]);
      if (sound) {
        if (fresh.some((f) => f.type === 'payment')) playPayment();
        else if ([...visitors].some((id) => !prev.visitors.has(id))) playVisitor();
      }
    }
    known.current = { visitors, events };
  }, [data, sound]);

  const groups = useMemo(() => groupByCity(data?.visitors ?? []), [data]);
  const places: MapPlace[] = useMemo(() => groups.map((g) => ({ key: g.key, lat: g.lat, lon: g.lon, country: g.country, city: g.city, count: g.visitors.length })), [groups]);

  /**
   * Selects places: one city, or (from a merged pin) several, with `group` naming every place in that pin so the map
   * can list them. The label always describes what is selected, so it matches the pin: "Accra +1 city · 3 here".
   * Selecting exactly what is already selected lets it go.
   */
  const selectPlaces = (keys: string[], group?: string[]) => {
    const picked = keys.map((k) => groups.find((g) => g.key === k)).filter((g): g is NonNullable<typeof g> => !!g);
    if (!picked.length) return;
    if (selection && !group === !selection.group && sameKeys(selection.keys, picked.map((g) => g.key))) return clearSelection();
    picked.sort((a, b) => b.visitors.length - a.visitors.length);
    const top = picked[0];
    const visitors = picked.flatMap((g) => g.visitors);
    const where = (g: (typeof picked)[number]) => g.city ?? (g.country ? countryName(g.country) : 'Here');
    const n = visitors.length;
    let label: string;
    let spoken: string;
    if (picked.length === 1) {
      const pages = new Set(visitors.map((v) => v.page ?? '/'));
      label = `${where(top)} · ${pages.size === 1 ? [...pages][0] : `${n} here`}`;
      spoken = `${placeName(top.city, top.country) ?? 'Selected place'}: ${n} active ${n === 1 ? 'visitor' : 'visitors'}`;
    } else {
      const more = picked.length - 1;
      const noun = picked.every((g) => g.city) ? (more === 1 ? 'city' : 'cities') : more === 1 ? 'place' : 'places';
      label = `${where(top)} +${more} ${noun} · ${n} here`;
      spoken = `${placeName(top.city, top.country) ?? 'Selected place'} and ${more} more ${noun}: ${n} active visitors. The list after the pin picks one.`;
    }
    setSelection({ key: top.key, keys: picked.map((g) => g.key), group: group && group.length > 1 ? group : undefined, lat: top.lat, lon: top.lon, label, visitorIds: visitors.map((v) => v.visitor_id) });
    setAnnounce(spoken);
  };
  const selectGroup = (key: string) => selectPlaces([key]);
  const clearSelection = () => {
    setSelection(null);
    setAnnounce('Selection cleared');
  };
  const selectFeed = (f: FeedItem) => {
    const v = f.visitor_id ? data?.visitors.find((x) => x.visitor_id === f.visitor_id) : undefined;
    const key = v ? groupKeyOf(v) : null;
    if (key) return selectGroup(key);
    if (f.lat === null || f.lon === null) {
      setAnnounce('This activity has no location');
      return;
    }
    setSelection({ key: `feed:${f.id}`, keys: [], lat: f.lat, lon: f.lon, label: `${f.city ?? (f.country ? countryName(f.country) : 'Here')} · ${feedVerb(f, money)}`, visitorIds: f.visitor_id ? [f.visitor_id] : [] });
    setAnnounce(`${placeName(f.city, f.country) ?? 'Place'}: ${feedVerb(f, money)}`);
  };
  // A selected place whose visitors all left is let go (for a merged pin: once every one of its places is empty).
  useEffect(() => {
    if (selection?.keys.length && data && !selection.keys.some((k) => groups.some((g) => g.key === k))) setSelection(null);
  }, [groups, data, selection]);

  const copySnapshot = async () => {
    if (!data) return;
    const ok = await copyText(snapshotText(site, data));
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied(null), 2000);
  };

  const latestMoney = data?.feed.find((f) => f.type === 'payment' || f.type === 'refund');
  const stale = error && fetchedAt ? `Couldn't refresh: ${error}. Showing ${fmtAgo(Date.now() - fetchedAt)} old data.` : '';
  const btn = 'icon-btn';

  return (
    <div ref={rootRef} data-theme={theme} style={{ colorScheme: theme }} className="absolute inset-0 overflow-y-auto bg-ground text-ink lg:overflow-hidden">
      <div className="mx-auto flex min-h-full max-w-[1600px] flex-col gap-4 px-4 py-3 sm:px-6 sm:py-4 lg:h-full">
        {/* Bar: the site, live state, utilities. */}
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Favicon domain={site.domain} size={20} />
            <h2 className="truncate text-lg font-semibold leading-tight">{site.name}</h2>
            <span className="flex flex-none items-center gap-1.5 text-sm text-muted">
              <span className={`live-dot ${animate ? 'breathe' : ''}`} aria-hidden="true" /> Live
            </span>
          </div>
          <div className="flex flex-none items-center">
            <Button variant="raw" size="raw"
              type="button"
              className={btn}
              title={sound ? 'Sound on' : 'Sound off'}
              aria-label={sound ? 'Turn sound off' : 'Turn sound on'}
              aria-pressed={sound}
              onClick={() => {
                unlockAudio();
                setSound((s) => !s);
              }}
            >
              <Icon name={sound ? 'bell' : 'bellOff'} />
            </Button>
            <Button variant="raw" size="raw" type="button" className={btn} title={theme === 'dark' ? 'Light' : 'Dark'} aria-label={theme === 'dark' ? 'Use the light theme here' : 'Use the dark theme here'} onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </Button>
            <Button variant="raw" size="raw" type="button" className={`${btn} hidden sm:inline-grid`} title="Fullscreen" aria-label="Fullscreen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen())}>
              <Icon name="expand" />
            </Button>
            <Button variant="raw" size="raw" type="button" className={btn} title="Close (Esc)" aria-label="Close live view" onClick={onClose} data-autofocus>
              <Icon name="close" />
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px]">
          {/* Figures and the map. On a phone the figures lead, then the people and the feed, then the map. */}
          <div className="contents lg:flex lg:min-h-0 lg:flex-col lg:gap-4">
            <Figures data={data} money={money} />

            <section className="order-3 flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-line bg-surface md:order-2 lg:order-none lg:flex-1" aria-labelledby="live-map-title">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-3 sm:px-5">
                <h2 id="live-map-title" title="Locations are approximate. Lines show arrivals, not network routes." className="flex items-center gap-2 text-sm text-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${data?.active.visitors === 0 ? 'bg-control' : 'bg-accent'}`} aria-hidden="true" />
                  {data?.active.visitors === 0 ? 'Nobody on the site in the last 5 minutes' : 'Active visitors'}
                </h2>
                <div className="flex items-center gap-1">
                  <Button variant="raw" size="raw" type="button" className="icon-btn" title={copied === 'ok' ? 'Copied' : copied === 'fail' ? "Couldn't copy" : 'Copy snapshot for agent'} aria-label="Copy snapshot for agent" disabled={!data} onClick={copySnapshot}>
                    {copied === 'ok' ? <span className="copy-done"><Icon name="check" /></span> : <Icon name={copied === 'fail' ? 'alert' : 'copy'} />}
                  </Button>
                  <span className="sr-only" aria-live="polite">{copied === 'ok' ? 'Copied' : copied === 'fail' ? "Couldn't copy" : ''}</span>
                  {!reduced && (
                    <Button variant="raw" size="raw" type="button" className="icon-btn" title={motionOn ? 'Pause motion' : 'Resume motion'} aria-label={motionOn ? 'Pause motion' : 'Resume motion'} aria-pressed={!motionOn} onClick={() => setMotionOn((m) => !m)}>
                      <Icon name={motionOn ? 'pause' : 'play'} />
                    </Button>
                  )}
                  <div className="tabs" role="group" aria-label="Map view">
                    {(['flat', 'globe'] as const).map((m) => (
                      <Button variant="raw" size="raw" key={m} type="button" className={`tab ${mode === m ? 'tab-active' : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
                        {m === 'flat' ? 'Flat' : 'Globe'}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="relative mx-2 mt-2 min-h-[280px] flex-1 overflow-hidden rounded-[14px] bg-[rgb(var(--c-map-stage))] sm:min-h-[360px] lg:min-h-0">
                <LiveMap
                  mode={mode}
                  places={places}
                  selected={selection}
                  onSelect={selectPlaces}
                  onClear={clearSelection}
                  ripples={ripples}
                  hub={site.domain}
                  animate={animate}
                  reduced={reduced}
                  themeKey={theme}
                  label="Globe of active visitors. Drag or use the arrow keys to turn it."
                  className="absolute inset-0"
                />
                {/* On a phone the map is short: the payment note steps aside while a place is selected, so it never covers the pin. */}
                {latestMoney && <LatestPayment f={latestMoney} money={money} selecting={!!selection} />}
              </div>
              {data && data.active.unlocated > 0 && <p className="px-4 py-2.5 text-xs text-muted sm:px-5">{fmtNumber(data.active.unlocated)} without a location</p>}
            </section>
          </div>

          <div className="order-2 flex min-h-0 flex-col gap-4 md:order-3 lg:order-none">
            <HereNow data={data} money={money} selection={selection} onSelect={(v) => (groupKeyOf(v) ? selectGroup(groupKeyOf(v)!) : setAnnounce('This visitor has no location'))} onProfile={openVisitor} />
            <Activity data={data} money={money} selection={selection} onSelect={selectFeed} />
          </div>
        </div>

        {(stale || (error && !data)) && (
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted" role="status">
            <Icon name="alert" size={14} className="text-negative" />
            {stale || `Couldn't load live data: ${error}.`}
            <Button variant="raw" size="raw" type="button" className="card-link" onClick={reload}>
              Retry
            </Button>
          </p>
        )}
        <div className="sr-only" aria-live="polite">
          {announce}
        </div>
      </div>
    </div>
  );
}

function Figures({ data, money }: { data: Realtime | null; money: (m: number) => string }) {
  const p = data?.payments;
  const cell = 'min-w-0 px-4 py-3 sm:px-5';
  const value = (v: React.ReactNode, lead = false) =>
    data ? <div className={`mt-1 truncate leading-tight tracking-[-0.01em] tabular-nums ${lead ? 'text-[30px] font-semibold' : 'text-2xl'}`}>{v}</div> : <div className={`skeleton mt-1.5 ${lead ? 'h-8 w-14' : 'h-7 w-12'}`} />;
  return (
    <section className="order-1 flex flex-col gap-px overflow-hidden rounded-[20px] border border-line bg-line lg:order-none xl:flex-row" aria-label="Live figures">
      <div className="grid flex-1 grid-cols-2 gap-px sm:grid-cols-3">
        <div className={`${cell} bg-surface`}>
          <div className="truncate text-muted">Active · last 5 min</div>
          {value(fmtNumber(data?.active.visitors ?? 0), true)}
        </div>
        <div className={`${cell} bg-surface`}>
          <div className="truncate text-muted">Countries</div>
          {value(fmtNumber(data?.active.countries ?? 0))}
        </div>
        <div className={`${cell} col-span-2 bg-surface sm:col-span-1`}>
          <div className="truncate text-muted">Payments · last 30 min</div>
          {value(<span className={p && p.amount > 0 ? 'text-revenue' : ''}>{money(p?.amount ?? 0)}</span>)}
          <div className="mt-1 text-xs text-muted">
            {data && p
              ? `${fmtNumber(p.count)} ${p.count === 1 ? 'payment' : 'payments'}${p.refunds ? ` · ${p.refunds} ${p.refunds === 1 ? 'refund' : 'refunds'} −${money(p.refunded)}` : ''}`
              : ' '}
            {data && data.other_currencies.length > 0 && ` · ${data.other_currencies.reduce((a, o) => a + o.payments, 0)} in ${data.other_currencies.map((o) => o.currency).join(', ')} not included`}
          </div>
        </div>
      </div>
    </section>
  );
}

function LatestPayment({ f, money, selecting }: { f: FeedItem; money: (m: number) => string; selecting: boolean }) {
  const refund = f.type === 'refund';
  return (
    <div className={`pointer-events-none absolute ${selecting ? 'max-sm:hidden' : ''} bottom-3 left-3 max-w-[min(260px,calc(100%-24px))] rounded-[14px] border border-line bg-surface px-4 py-3`}>
      <div className="text-xs text-muted">{refund ? 'Latest refund' : 'Latest payment'}</div>
      <div className={`mt-0.5 text-2xl font-semibold leading-tight tabular-nums ${refund ? 'text-negative' : 'text-revenue'}`}>
        {refund ? '−' : '+'}
        {money(Math.abs(f.amount ?? 0))}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted">
        {placeName(f.city, f.country) ?? 'Not linked to a visit'} · {fmtAgo(Date.now() - f.ts)} ago
      </div>
    </div>
  );
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));

const feedVerb = (f: FeedItem, money: (m: number) => string) =>
  f.type === 'pageview' ? `viewed ${f.label}` : f.type === 'goal' ? `completed ${f.label}` : f.type === 'payment' ? `paid ${money(f.amount ?? 0)}` : `was refunded ${money(Math.abs(f.amount ?? 0))}`;

function Panel({ title, meta, children, className = '' }: { title: string; meta?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const id = `live-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-line bg-surface ${className}`} aria-labelledby={id}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3.5 sm:px-5">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {meta && <span className="text-xs text-muted">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function HereNow({
  data,
  money,
  selection,
  onSelect,
  onProfile,
}: {
  data: Realtime | null;
  money: (m: number) => string;
  selection: Selection | null;
  onSelect: (v: LiveVisitor) => void;
  onProfile: (id: string) => void;
}) {
  const sel = new Set(selection?.visitorIds ?? []);
  // The selected place's people first, then everyone by most recent activity.
  const rows = (data?.visitors ?? []).slice().sort((a, b) => Number(sel.has(b.visitor_id)) - Number(sel.has(a.visitor_id)) || b.last_seen_at - a.last_seen_at);
  const shown = rows.slice(0, ROWS);
  const total = data?.active.visitors ?? 0;
  // On phones and tablets the page scrolls, so the list stops at a few rows until asked for the rest.
  const [all, setAll] = useState(false);
  return (
    <Panel title="Here now" meta="Active in the last 5 min" className="lg:max-h-[52%] lg:flex-none">
      {!data ? (
        <div className="space-y-3 px-4 pb-4 sm:px-5" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-9" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="mx-4 mb-4 rounded-[10px] border border-dashed border-control px-3.5 py-3 text-sm text-muted sm:mx-5">Nobody is on the site right now.</p>
      ) : (
        <>
          <div className="min-h-0 overflow-y-auto px-4 sm:px-5">
            <table className="data-table table-fixed">
              <caption className="sr-only">Visitors on the site now, with their current page, source and lifetime spend</caption>
              <thead className="sticky top-0 z-[1] bg-surface">
                <tr>
                  <th scope="col">Visitor / location</th>
                  <th scope="col" className="w-[38%]">
                    Page / source
                  </th>
                  <th scope="col" className="n w-[22%]">
                    Spend
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((v, i) => {
                  const on = sel.has(v.visitor_id);
                  const where = v.city ?? (v.country ? countryName(v.country) : null);
                  return (
                    <tr key={v.visitor_id} className={`${on ? 'bg-active/60' : ''} ${i >= FEW && !all ? 'max-lg:hidden' : ''}`}>
                      <td className="!py-2.5">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Flag cc={v.country} size={18} />
                          <div className="min-w-0">
                            <Button variant="raw" size="raw" type="button" className="block max-w-full truncate text-left font-medium hover:underline" aria-pressed={on} onClick={() => onSelect(v)} title={v.lat === null ? 'No location to show on the map' : 'Show on the map'}>
                              {displayName(v.visitor_id, v.name)}
                            </Button>
                            <div className="flex items-center gap-1.5 truncate text-xs text-muted">
                              <span className="truncate">{where ?? 'Location unknown'}</span>
                              {on && (
                                <Button variant="raw" size="raw" type="button" className="card-link flex-none text-xs" onClick={() => onProfile(v.visitor_id)}>
                                  Profile
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="!py-2.5">
                        <code className="block truncate text-[13px]" title={v.page ?? undefined}>
                          {v.page ?? '/'}
                        </code>
                        <div className="flex items-center gap-1 truncate text-xs text-muted">
                          <SourceIcon source={v.source} domain={v.referrer_domain} size={12} />
                          <span className="truncate">{v.source === 'Direct/None' ? 'Direct' : v.source}</span>
                        </div>
                      </td>
                      <td className="n !py-2.5 tabular-nums">{v.spent ? <span className="font-medium text-revenue">{money(v.spent)}</span> : <span className="text-faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length > FEW && (
              <Button variant="raw" size="raw" type="button" className="btn-ghost -ml-3 mb-1 lg:hidden" aria-expanded={all} onClick={() => setAll((x) => !x)}>
                {all ? 'Show fewer' : `Show all ${fmtNumber(shown.length)}`}
              </Button>
            )}
          </div>
          <p className="border-t border-rule px-4 py-2.5 text-xs text-muted sm:px-5">
            {shown.length < total ? `Showing ${fmtNumber(shown.length)} of ${fmtNumber(total)} active visitors` : `${fmtNumber(total)} active ${total === 1 ? 'visitor' : 'visitors'}`}
            {' · '}Spend is lifetime, in {data.currency}
          </p>
        </>
      )}
    </Panel>
  );
}

function Activity({ data, money, selection, onSelect }: { data: Realtime | null; money: (m: number) => string; selection: Selection | null; onSelect: (f: FeedItem) => void }) {
  const cut = data && (data.truncated.events || data.truncated.payments);
  const [all, setAll] = useState(false);
  return (
    <Panel title="Recent activity" meta="Last 30 minutes" className="flex-1 lg:min-h-[200px]">
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!data && <p className="px-5 pb-4 text-sm text-muted">Connecting…</p>}
        {data && data.feed.length === 0 && <p className="mx-4 mb-2 rounded-[10px] border border-dashed border-control px-3.5 py-3 text-sm text-muted sm:mx-5">No activity in the last 30 minutes.</p>}
        {data && data.feed.length > 0 && (
          <ol className="px-2 sm:px-3">
            {data.feed.map((f, i) => {
              const who = f.visitor_id ? displayName(f.visitor_id, f.name, f.email) : f.name ?? f.email ?? 'A buyer';
              const on = !!selection && ((f.visitor_id && selection.visitorIds.includes(f.visitor_id)) || selection.key === `feed:${f.id}`);
              const where = placeName(f.city, f.country);
              const kind = f.type === 'pageview' ? 'Pageview' : f.type === 'goal' ? 'Goal' : f.type === 'payment' ? 'Payment' : 'Refund';
              return (
                <li key={f.id} className={i >= FEW && !all ? 'max-lg:hidden' : undefined}>
                  <Button variant="raw" size="raw" type="button" onClick={() => onSelect(f)} aria-pressed={on} className={`flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-150 hover:bg-raised sm:px-2.5 ${on ? '!bg-active' : ''}`}>
                    <span className="mt-0.5 flex-none">{f.country ? <Flag cc={f.country} size={18} /> : <Icon name="globe" size={16} className="text-faint" />}</span>
                    <span className="min-w-0 flex-1 text-[13px] leading-snug">
                      <span className="font-semibold">{who}</span>{' '}
                      {f.type === 'pageview' && (
                        <>
                          viewed <code className="text-[12.5px]">{f.label}</code>
                        </>
                      )}
                      {f.type === 'goal' && (
                        <>
                          completed <span className="font-medium">{f.label}</span>
                        </>
                      )}
                      {f.type === 'payment' && (
                        <>
                          paid <span className="font-semibold text-revenue tabular-nums">{money(f.amount ?? 0)}</span>
                        </>
                      )}
                      {f.type === 'refund' && (
                        <>
                          was refunded <span className="font-semibold text-negative tabular-nums">−{money(Math.abs(f.amount ?? 0))}</span>
                        </>
                      )}
                      <span className="block truncate text-xs text-muted">
                        {kind} · {where ?? (f.type === 'payment' || f.type === 'refund' ? 'Not linked to a visit' : 'Location unknown')} · {fmtAgo(Date.now() - f.ts)} ago
                      </span>
                    </span>
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        {data && data.feed.length > FEW && (
          <Button variant="raw" size="raw" type="button" className="btn-ghost mx-1 sm:mx-2 lg:hidden" aria-expanded={all} onClick={() => setAll((x) => !x)}>
            {all ? 'Show fewer' : `Show all ${fmtNumber(data.feed.length)}`}
          </Button>
        )}
      </div>
      {cut && <p className="border-t border-rule px-4 py-2.5 text-xs text-muted sm:px-5">Showing the most recent activity only. The payment figures above count every payment.</p>}
    </Panel>
  );
}
