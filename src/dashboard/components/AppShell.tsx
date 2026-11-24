import { Button } from './primitives/button';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { navigate, useMe } from '../App';
import { api, type Site } from '../lib/api';
import { loadPref, savePref, usePref } from '../lib/prefs';
import { useTheme, type ThemePref } from '../lib/theme';
import { useApi } from '../lib/useApi';
import { Dialog } from './Dialog';
import { Favicon } from './Icons';
import { Logo } from './Logo';
import { LAST_SITE } from './SitePage';
import { AppLink, Icon } from './ui';

/**
 * The framed sheet: a tinted L-frame holds the sidebar and a 48px top bar; the page sits on a white sheet
 * inset 8px. Below 861px the sidebar folds into the top bar's menu, opened as a full-screen sheet.
 */
export function AppShell({ page, siteId, children }: { page: string; siteId?: string; children: ReactNode }) {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = usePref('dm_sidebar_collapsed', false);
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width:861px)').matches);
  useEffect(() => {
    const mq = matchMedia('(min-width:861px)');
    const on = () => setDesktop(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const { data: sites } = useApi<Site[]>('/api/sites');
  // Picking a site on a page that is not under /site/ (Launches, Links) keeps the path, so the sidebar is told to redraw.
  const [, setPicks] = useState(0);
  const path = window.location.pathname;

  useEffect(() => {
    if (siteId) savePref(LAST_SITE, siteId);
  }, [siteId]);
  // The site the sidebar is about: the one on screen (a Launches or Links address can name it), else the last one opened.
  const asked = /^\/(launches|links)\/?$/.test(path) ? new URLSearchParams(window.location.search).get('site') : null;
  const contextId = siteId ?? asked ?? loadPref<string | null>(LAST_SITE, null);
  const site = sites?.find((s) => s.id === contextId) ?? (sites?.length === 1 ? sites[0] : undefined);

  useEffect(() => {
    // App's page-meta effect (a parent, so it runs after this one) resets the title on every path change;
    // set ours after it.
    const t = setTimeout(() => (document.title = `${page} · DataMonster`), 0);
    return () => clearTimeout(t);
  }, [page, path]);

  // The menu sheet only exists below 861px; widening the window closes it rather than leaving the page inert.
  useEffect(() => {
    if (!open) return;
    const m = window.matchMedia('(min-width: 861px)');
    const on = () => m.matches && setOpen(false);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [open]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.dispatchEvent(new Event('dm:logout'));
    navigate('/');
  }

  const close = () => setOpen(false);
  const item = (to: string, icon: string, label: ReactNode, current: boolean, extra?: ReactNode) => (
    <AppLink
      to={to}
      current={current}
      onNavigate={close}
      className={`flex h-9 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors duration-150 frame:h-8 ${
        current ? 'bg-active font-medium text-ink' : 'text-muted hover:bg-hover hover:text-ink'
      }`}
    >
      <Icon name={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra}
    </AppLink>
  );

  const onSiteRoute = /^\/site\/[\w-]+(\/settings)?\/?$/.test(path);
  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-0.5 overflow-y-auto px-3 pb-4 pt-3.5">
      <div className="flex items-center justify-between">
        <AppLink to="/" onNavigate={close} className="flex h-8 items-center rounded-lg px-1.5">
          <Logo small />
        </AppLink>
        <Button variant="raw" size="raw" type="button" className="icon-btn frame:hidden" onClick={close} aria-label="Close menu" data-autofocus="">
          <Icon name="close" />
        </Button>
      </div>

      {sites && sites.length > 0 && (
        <SiteSwitcher
          sites={sites}
          site={site}
          onPick={(s) => {
            close();
            // On a site's own page, switch in place and keep the view (period, filters); the back button
            // still returns to the page before, not through every site viewed.
            const ledger = /^\/(launches|links)\/?$/.exec(path);
            if (ledger) {
              savePref(LAST_SITE, s.id);
              setPicks((n) => n + 1);
              navigate(`/${ledger[1]}?site=${s.id}`, { replace: true });
            } else if (onSiteRoute) navigate(path.replace(/^\/site\/[\w-]+/, `/site/${s.id}`) + window.location.search, { replace: true });
            else navigate(`/site/${s.id}`);
          }}
        />
      )}

      {item('/', 'sites', 'All websites', path === '/')}
      {site && (
        <>
          {item(`/site/${site.id}`, 'overview', 'Overview', path === `/site/${site.id}` || path === `/site/${site.id}/`)}
          {item(`/launches?site=${site.id}`, 'target', 'Launches', path.startsWith('/launches'))}
          {item(`/links?site=${site.id}`, 'link', 'Links', path.startsWith('/links'))}
          {item(`/site/${site.id}/settings`, 'settings', 'Install and settings', path.startsWith(`/site/${site.id}/settings`))}
        </>
      )}

      <p className="mx-2 mb-1.5 mt-5 text-xs text-faint">Agents</p>
      {item('/agents', 'agents', 'Agents and MCP', path.startsWith('/agents'))}

      <div className="mt-auto flex flex-col gap-0.5 pt-6">
        <ThemeSwitch />
        {me.hosted && me.user && item('/billing', 'billing', 'Billing', path.startsWith('/billing'))}
        <Button variant="raw" size="raw"
          type="button"
          onClick={logout}
          className="flex h-9 items-center gap-2.5 rounded-lg px-2 text-left text-sm text-muted transition-colors duration-150 hover:bg-hover hover:text-ink frame:h-8"
        >
          <Icon name="logout" />
          Log out
        </Button>
      </div>
    </nav>
  );

  const account = me.user ? (
    <AppLink to={me.hosted ? '/billing' : '/'} className="flex items-center gap-2 rounded-full py-1 pl-1 pr-1 text-sm text-muted transition-colors hover:bg-hover hover:text-ink frame:pr-3">
      {me.user.avatar ? (
        <img src={me.user.avatar} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" />
      ) : (
        <span className="grid h-7 w-7 place-items-center rounded-full bg-accentSoft text-xs font-semibold text-accentInk">
          {me.user.name || me.user.email ? initials(me.user.name ?? me.user.email) : <Icon name="person" size={14} />}
        </span>
      )}
      <span className="sr-only frame:hidden">{me.hosted ? 'Account' : 'All websites'}</span>
      <span className="hidden max-w-[220px] truncate frame:inline">{me.user.email ?? me.user.name ?? (me.hosted ? 'Account' : 'Owner')}</span>
    </AppLink>
  ) : (
    <span className="grid h-7 w-7 place-items-center rounded-full bg-accentSoft text-xs font-semibold text-accentInk" aria-label="Owner">
      You
    </span>
  );

  return (
    <div data-sidebar-collapsed={collapsed} className="v3-shell min-h-screen bg-ground frame:grid frame:grid-cols-[232px_minmax(0,1fr)] frame:grid-rows-[48px_minmax(0,1fr)]">
      {/* Desktop: the sidebar is the left arm of the frame. */}
      <aside id="v3-sidebar" className="sticky top-0 hidden h-screen frame:row-span-2 frame:block" aria-label="Navigation">
        {sidebar}
      </aside>
      {/* Phone and tablet: the same navigation as a full-screen sheet. */}
      <Dialog open={open} onClose={close} label="Menu" className="anim-fade fixed inset-0 z-50 bg-ground frame:hidden">
        {sidebar}
      </Dialog>

      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 bg-ground px-2 frame:static frame:col-start-2 frame:px-0 frame:pr-4">
        <Button variant="raw" size="raw"
          type="button"
          className="icon-btn v3-sidebar-toggle"
          onClick={() => (desktop ? setCollapsed((c) => !c) : setOpen(true))}
          aria-label={desktop ? (collapsed ? 'Expand sidebar' : 'Collapse sidebar') : 'Open menu'}
          aria-expanded={desktop ? !collapsed : open}
          aria-controls={desktop ? 'v3-sidebar' : undefined}
          aria-haspopup={desktop ? undefined : 'dialog'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M9 4v16" />
          </svg>
        </Button>
        <nav aria-label="Breadcrumb" className="v3-breadcrumb">
          {site && siteId && (
            <>
              <a
                href={`https://${site.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="v3-site-link"
                aria-label={`Visit ${site.domain} (opens in a new tab)`}
                title={`Visit ${site.domain} (opens in a new tab)`}
              >
                <span className="truncate">{site.domain}</span>
                <Icon name="external" size={14} className="shrink-0" />
              </a>
              <span aria-hidden="true">/</span>
            </>
          )}
          <span className="text-ink">{page}</span>
        </nav>
        {account}
      </header>

      <main className="min-h-[calc(100vh-48px)] min-w-0 bg-surface frame:col-start-2 frame:mb-2 frame:mr-2 frame:min-h-0 frame:rounded-2xl frame:border frame:border-sheetEdge">
        <div className="mx-auto w-full max-w-[1200px] p-4 frame:p-6">
          <UsageBanner path={path} />
          {children}
        </div>
      </main>
    </div>
  );
}

/** Calm app-wide warning when a hosted account nears or exceeds its monthly event limit. */
export function UsageBanner({ path }: { path: string }) {
  const { me } = useMe();
  const user = me.user;
  if (!me.hosted || !user || user.admin || !user.events_limit || user.events_used == null) return null;
  const ratio = user.events_used / user.events_limit;
  if (ratio < 0.8) return null;

  const over = user.events_used >= user.events_limit;
  const pct = Math.floor(ratio * 100);
  const free = !user.hard_limit || user.hard_limit <= user.events_limit;
  const mult = user.hard_limit ? +(user.hard_limit / user.events_limit).toFixed(1) : 3;
  const supportEmail = me.supportEmail;

  return (
    <div
      role="status"
      className={
        over
          ? 'mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-negLine bg-negSoft px-4 py-3 text-sm text-negInk'
          : 'notice mb-4 flex flex-wrap items-center justify-between gap-2'
      }
    >
      <div className="flex items-start gap-2">
        <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
        <span>
          {over && free ? (
            <>You&apos;ve used this month&apos;s {user.events_limit.toLocaleString('en-US')} events. Recording is paused until {new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })}.</>
          ) : over ? (
            <>
              You&apos;re over this month&apos;s limit. Tracking continues up to {mult}× the limit; email{' '}
              {supportEmail ? (
                <a className="underline" href={`mailto:${supportEmail}`}>
                  {supportEmail}
                </a>
              ) : (
                'support'
              )}{' '}
              to raise it.
            </>
          ) : (
            <>You&apos;ve used {pct}% of this month&apos;s events.</>
          )}
        </span>
      </div>
      {!path.startsWith('/billing') && (
        <AppLink to="/billing" className="shrink-0 font-medium underline">
          {free && !user.paid ? 'Go Pro' : 'View usage'}
        </AppLink>
      )}
    </div>
  );
}

function initials(s: string | null) {
  if (!s) return '·';
  const parts = s
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || s[0].toUpperCase();
}

function SiteSwitcher({ sites, site, onPick }: { sites: Site[]; site?: Site; onPick: (s: Site) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: globalThis.MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', on);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', on);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="relative mb-2 mt-3.5" ref={ref}>
      <Button variant="raw" size="raw"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={site ? `Switch site, current site ${site.domain}` : 'Choose a site'}
        className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface p-2 text-left transition-colors duration-150 hover:border-control"
      >
        {site ? (
          <>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-raised">
              <Favicon domain={site.domain} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <b className="block truncate font-medium">{site.name}</b>
              <span className="block truncate text-xs leading-4 text-faint">{site.domain}</span>
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 px-1 text-muted">Choose a site</span>
        )}
        <Icon name="updown" size={14} className="text-faint" />
      </Button>
      {open && (
        <div role="listbox" aria-label="Sites" className="anim-sheet absolute left-0 right-0 top-full z-40 mt-1.5 max-h-80 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-float">
          {sites.map((s) => (
            <Button variant="raw" size="raw"
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === site?.id}
              onClick={() => {
                setOpen(false);
                onPick(s);
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-raised ${s.id === site?.id ? 'font-medium text-ink' : 'text-muted'}`}
            >
              <Favicon domain={s.domain} size={16} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.id === site?.id && <Icon name="check" size={14} className="text-accent" />}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

const THEMES: { value: ThemePref; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

/** Light / Dark / System, remembered in this browser. Arrow keys move between the three. */
function ThemeSwitch() {
  const { pref, setPref } = useTheme();
  const move = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = THEMES[(i + d + THEMES.length) % THEMES.length];
    setPref(next.value);
    (e.currentTarget.parentElement?.children[THEMES.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="mb-1 flex h-9 items-center justify-between gap-2 pl-2 frame:h-8">
      <span id="theme-label" className="text-sm text-muted">
        Theme
      </span>
      <div role="radiogroup" aria-labelledby="theme-label" className="inline-flex rounded-full bg-raised p-0.5">
        {THEMES.map((t, i) => {
          const on = pref === t.value;
          return (
            <Button variant="raw" size="raw"
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={t.label}
              title={t.label}
              tabIndex={on ? 0 : -1}
              onClick={() => setPref(t.value)}
              onKeyDown={(e) => move(e, i)}
              className={`grid h-7 w-8 place-items-center rounded-full border transition-colors duration-150 ${
                on ? 'border-line bg-surface text-ink' : 'border-transparent text-faint hover:text-ink'
              }`}
            >
              <Icon name={t.icon} size={14} />
            </Button>
          );
        })}
      </div>
    </div>
  );
}
