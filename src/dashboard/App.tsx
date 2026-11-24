import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useState } from 'react';
import { AppShell } from './components/AppShell';
import { NotFound } from './components/NotFound';
import { api, type Me } from './lib/api';
import { Agents } from './pages/Agents';
import { Billing } from './pages/Billing';
import { Consent } from './pages/Consent';
import { Dashboard } from './pages/Dashboard';
import { Landing } from './pages/Landing';
import { Launches } from './pages/Launches';
import { Legal } from './pages/Legal';
import { Links } from './pages/Links';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Sites } from './pages/Sites';
import { syncTheme, useLightOnly } from './lib/theme';

const Directories = lazy(() => import('./pages/Directories').then((m) => ({ default: m.Directories })));

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  // A replaced entry keeps its state, so a page opened from a bookmark still knows there is no in-app page behind it.
  if (replace) window.history.replaceState(window.history.state, '', to);
  else window.history.pushState({ app: true }, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

const SITE = 'https://datamonster.dev';
const HOME_TITLE = 'DataMonster: know which post brought you customers';
const HOME_DESCRIPTION =
  'Website analytics for any business. See which post, ad, launch or link brought you customers, and what they spent.';
const LEGAL_META = {
  terms: { title: 'Terms of Service | DataMonster', description: 'The terms for using DataMonster revenue analytics.' },
  privacy: { title: 'Privacy Policy | DataMonster', description: 'What data DataMonster collects, why, and how long it is kept.' },
  refund: { title: 'Refund Policy | DataMonster', description: 'How refunds work for DataMonster, including the 14-day money-back guarantee.' },
};
const LEGAL = /^\/(terms|privacy|refund)\/?$/;
const DIRECTORIES_ROUTE = /^\/directories\/?$/;
const DIRECTORIES_TITLE = 'Launch directories | DataMonster';
const DIRECTORIES_DESCRIPTION =
  'A list of places to launch your product, for you and your agent.';
const APP_PAGE = /^\/(agents\/?|launches\/?|links\/?|billing(\/.*)?|site\/[\w-]+(\/settings)?\/?)$/;

function setTag(selector: string, create: () => HTMLElement, attr: string, value: string) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}
const meta = (name: string) => () => Object.assign(document.createElement('meta'), { name });

// index.html carries the homepage tags; other pages swap in their own title, canonical URL and robots rule.
function usePageMeta(path: string) {
  useEffect(() => {
    const legal = LEGAL.exec(path)?.[1] as keyof typeof LEGAL_META | undefined;
    const dirs = DIRECTORIES_ROUTE.test(path);
    // Self-hosted copies are private dashboards: only datamonster.dev itself should be in search results.
    const indexable = /(^|\.)datamonster\.dev$/.test(window.location.hostname) && (path === '/' || !!legal || dirs);
    document.title = legal ? LEGAL_META[legal].title : dirs ? DIRECTORIES_TITLE : path === '/' ? HOME_TITLE : 'DataMonster';
    setTag(
      'meta[name="description"]',
      meta('description'),
      'content',
      legal ? LEGAL_META[legal].description : dirs ? DIRECTORIES_DESCRIPTION : HOME_DESCRIPTION,
    );
    setTag('meta[name="robots"]', meta('robots'), 'content', indexable ? 'index, follow, max-image-preview:large' : 'noindex');
    const canonicalPath = legal ? `/${legal}` : dirs ? '/directories' : '/';
    setTag('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }), 'href', SITE + canonicalPath);
  }, [path]);
}

function DirectoriesRoute({ me }: { me: Me }) {
  useLightOnly();
  return (
    <Suspense fallback={<div className="min-h-svh bg-white" />}>
      <Directories hosted={me.hosted} loggedIn={me.loggedIn} supportEmail={me.supportEmail ?? null} />
    </Suspense>
  );
}

const MeContext = createContext<{ me: Me; refresh: () => Promise<Me> } | null>(null);
export function useMe() {
  const m = useContext(MeContext);
  if (!m) throw new Error('useMe outside App');
  return m;
}

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  usePageMeta(path);

  const refresh = useCallback(async () => {
    const r = await api<Me>('/api/auth/me').catch(() => ({ loggedIn: false, hosted: false, user: null }) as Me);
    setMe(r);
    return r;
  }, []);

  useEffect(() => {
    refresh();
    const out = () => setMe((m) => (m ? { ...m, loggedIn: false, user: null } : m));
    window.addEventListener('dm:logout', out);
    return () => window.removeEventListener('dm:logout', out);
  }, [refresh]);

  // Tell DataMonster (when this site tracks itself) who is signed in, and record brand-new signups.
  const userId = me?.user?.id;
  useEffect(() => {
    if (!me?.user || me.user.id === 'admin') return;
    window.datamonster?.('identify', { user_id: me.user.id, email: me.user.email, name: me.user.name });
    const q = new URLSearchParams(window.location.search);
    if (q.get('signup') === '1') {
      window.datamonster?.('goal', 'signup_completed');
      q.delete('signup');
      window.history.replaceState(window.history.state, '', window.location.pathname + (q.toString() ? `?${q}` : ''));
    }
    // Only when the signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // "/" is the always-light landing page only for a signed-out visitor to the hosted service.
  const rootIsLanding = !!me && me.hosted && !me.loggedIn;
  useEffect(() => {
    if (me) syncTheme(rootIsLanding);
  }, [me, rootIsLanding]);

  if (!me) return null;

  const legal = LEGAL.exec(path);
  if (legal) return <Legal page={legal[1] as 'terms' | 'privacy' | 'refund'} />;

  if (DIRECTORIES_ROUTE.test(path)) return <DirectoriesRoute me={me} />;

  if (/^\/oauth\/consent\/?$/.test(path)) return <Consent me={me} onLogin={refresh} />;
  if (path !== '/' && !APP_PAGE.test(path)) return <NotFound />;

  let page;
  if (!me.loggedIn) {
    page = me.hosted ? <Landing /> : <Login onLogin={refresh} />;
  } else if (me.hosted && path.startsWith('/billing')) {
    page = (
      <AppShell page="Billing">
        <Billing />
      </AppShell>
    );
  } else if (/^\/launches\/?$/.test(path)) {
    page = (
      <AppShell page="Launches">
        <Launches />
      </AppShell>
    );
  } else if (/^\/links\/?$/.test(path)) {
    page = (
      <AppShell page="Links">
        <Links />
      </AppShell>
    );
  } else if (/^\/agents\/?$/.test(path)) {
    page = (
      <AppShell page="Agents and MCP">
        <Agents />
      </AppShell>
    );
  } else {
    const settings = /^\/site\/([\w-]+)\/settings\/?$/.exec(path);
    const site = /^\/site\/([\w-]+)\/?$/.exec(path);
    page = settings ? (
      <AppShell page="Install and settings" siteId={settings[1]}>
        <Settings key={settings[1]} siteId={settings[1]} />
      </AppShell>
    ) : site ? (
      <AppShell page="Overview" siteId={site[1]}>
        <Dashboard siteId={site[1]} />
      </AppShell>
    ) : (
      <AppShell page="All websites">
        <Sites />
      </AppShell>
    );
  }
  return <MeContext.Provider value={{ me, refresh }}>{page}</MeContext.Provider>;
}
