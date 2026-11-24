import { Button } from '../components/primitives/button';
import { Checkbox } from '../components/primitives/checkbox';
import { useEffect, useState, type ReactNode } from 'react';
import { WRITE_CAPABILITIES } from '../../agent/write-capabilities';
import { GoogleMark } from '../components/GoogleMark';
import { Logo } from '../components/Logo';
import { Icon } from '../components/ui';
import { api, ApiError, type Me } from '../lib/api';
import { Login } from './Login';

/** What the worker tells the consent screen about the app asking to connect (GET /api/oauth/consent). */
interface ConsentInfo {
  client: { id: string; name: string; redirect_host: string };
  scopes: ('read' | 'write')[];
  /** How the server reads site_ids: null means every current and future site. Shown to the owner in plain words. */
  scope_note?: string;
  sites: { id: string; name: string; domain: string }[];
  account: string | null;
  csrf: string;
}

/**
 * "Allow <app> to use your DataMonster analytics?" The page an MCP client (Claude.ai, ChatGPT, ...) sends the owner to
 * from /oauth/authorize. It signs the owner in first when needed, then Allow or Deny goes back to the app.
 */
export function Consent({ me, onLogin }: { me: Me; onLogin: () => void }) {
  const query = window.location.search;
  if (!me.loggedIn) {
    if (!me.hosted) return <Login onLogin={onLogin} />;
    return (
      <Card>
        <h1 className="mt-8 text-2xl font-semibold tracking-[-0.01em]">Sign in to connect</h1>
        <p className="mt-1 text-muted">An app wants to use your DataMonster analytics. Sign in first; you choose what it may see next.</p>
        <a className="btn mt-6 h-10 w-full" href={`/oauth/login?return=${encodeURIComponent('/oauth/consent' + query)}`}>
          <GoogleMark />
          Continue with Google
        </a>
      </Card>
    );
  }
  return <ConsentForm query={query} />;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ground px-4 py-10">
      <div className="anim-sheet w-full max-w-md rounded-2xl border border-sheetEdge bg-surface p-8">
        <Logo />
        {children}
      </div>
    </div>
  );
}

function ConsentForm({ query }: { query: string }) {
  const params = Object.fromEntries(new URLSearchParams(query));
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [fatal, setFatal] = useState<{ message: string; redirect: string | null } | null>(null);
  // Write is off until the owner ticks it, even when the app asked for it.
  const [write, setWrite] = useState(false);
  // null until the owner picks: one site defaults to that site only, never "all, including future ones".
  const [limitChoice, setLimit] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/oauth/consent${query}`, { credentials: 'same-origin' })
      .then(async (r) => {
        const data: any = await r.json().catch(() => ({}));
        if (!r.ok) setFatal({ message: data.error ?? 'This connection request is not valid.', redirect: data.redirect ?? null });
        else setInfo(data as ConsentInfo);
      })
      .catch(() => setFatal({ message: 'Could not load this connection request. Check your connection and reload.', redirect: null }));
  }, [query]);

  const limit = limitChoice ?? info?.sites.length === 1;
  const siteIds = info?.sites.length === 1 ? [info.sites[0].id] : picked;

  async function decide(allow: boolean) {
    if (!info) return;
    setError('');
    if (allow && limit && !siteIds.length) return setError('Pick at least one site, or allow all current and future sites.');
    setBusy(allow ? 'allow' : 'deny');
    try {
      const r = await api<{ redirect: string }>('/api/oauth/consent', {
        method: 'POST',
        json: {
          ...params,
          allow,
          csrf: info.csrf,
          scopes: write ? info.scopes : ['read'],
          site_ids: limit ? siteIds : null,
        },
      });
      window.location.assign(r.redirect);
    } catch (e) {
      setBusy(null);
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  }

  if (fatal)
    return (
      <Card>
        <h1 className="mt-8 text-2xl font-semibold tracking-[-0.01em]">Can't connect this app</h1>
        <p className="mt-1 text-muted">{fatal.message}</p>
        {fatal.redirect ? (
          <a className="btn-dark mt-6 h-10 w-full" href={fatal.redirect}>
            Back to the app
          </a>
        ) : (
          <a className="btn mt-6 h-10 w-full" href="/">
            Go to DataMonster
          </a>
        )}
      </Card>
    );

  if (!info)
    return (
      <Card>
        <div aria-busy="true" aria-label="Loading">
          <div className="skeleton mt-8 h-7 w-3/4" />
          <div className="skeleton mt-3 h-4 w-full" />
          <div className="skeleton mt-6 h-16 w-full" />
        </div>
      </Card>
    );

  const asksWrite = info.scopes.includes('write');
  return (
    <Card>
      <h1 className="mt-8 text-2xl font-semibold tracking-[-0.01em]">
        Allow <span className="break-words">{info.client.name}</span> to use your analytics?
      </h1>
      <p className="mt-1 text-muted">
        It will return to <b className="font-medium text-ink">{info.client.redirect_host}</b>
        {info.account ? (
          <>
            {' '}
            and act for <b className="font-medium text-ink">{info.account}</b>
          </>
        ) : null}
        . Only allow apps you started connecting yourself.
      </p>

      <p className="label mt-6">It may</p>
      <ul className="well px-4 py-1">
        <Row title="Read your analytics" pill={<span className="pill">Always</span>}>
          Visitors, sources, revenue, customers, funnels, tracked links, notes and launches.
        </Row>
        <Row title="Never" pill={<span className="pill pill-neg">Admin</span>}>
          Payment keys, API keys, tokens, site settings and deleting data stay with you.
        </Row>
      </ul>

      {asksWrite && (
        <div className={`mt-3 rounded-xl border p-3 transition-colors duration-150 ${write ? 'border-accent' : 'border-line'}`}>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox  className="mt-1 h-4 w-4 shrink-0 accent-accent" checked={write} onCheckedChange={(checked) => setWrite((checked === true))} />
            <span className="min-w-0">
              <b className="block font-medium">Also let it make changes</b>
              <span className="block text-sm text-muted">This app asked for write access. It stays off unless you tick this. With it, the app may:</span>
            </span>
          </label>
          <ul className="mt-2 list-disc space-y-0.5 pl-[46px] text-sm text-muted marker:text-faint">
            {WRITE_CAPABILITIES.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          {write && (
            <p className="mt-2 pl-[26px] text-sm text-muted" role="note">
              It makes these without asking you each time. Every change is in the activity log on the Agents page.
            </p>
          )}
        </div>
      )}

      <p className="label mt-5" id="consent-sites">
        Sites it may see
      </p>
      <div role="radiogroup" aria-labelledby="consent-sites" className="grid gap-1.5">
        {info.sites.length === 1 ? (
          <Choice on={limit} onClick={() => setLimit(true)} title="This site only" desc={`${info.sites[0].name} (${info.sites[0].domain}).`} />
        ) : info.sites.length > 1 ? (
          <Choice on={limit} onClick={() => setLimit(true)} title="Only some sites" desc="Pick the sites this app may see." />
        ) : null}
        <Choice
          on={!limit}
          onClick={() => setLimit(false)}
          title="All current and future sites"
          desc={
            info.sites.length
              ? `${info.sites.length === 1 ? info.sites[0].name : `All ${info.sites.length} sites`} now, and every site you add later, without asking again.`
              : 'You have no sites yet. Every site you add later is included without asking again.'
          }
        />
      </div>
      {limit && info.sites.length > 1 && (
        <div className="mt-2 grid gap-1 rounded-xl border border-line bg-surface p-1.5">
          {info.sites.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-raised">
              <Checkbox

                className="h-4 w-4 accent-accent"
                checked={picked.includes(s.id)}
                onCheckedChange={(checked) => setPicked((p) => ((checked === true) ? [...p, s.id] : p.filter((x) => x !== s.id)))}
              />
              <span className="min-w-0 truncate">{s.name}</span>
              <span className="ml-auto truncate text-xs text-faint">{s.domain}</span>
            </label>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-4 text-sm text-negative" role="alert">
          {error}
        </p>
      )}
      <div className="mt-6 flex gap-2">
        <Button variant="raw" size="raw" type="button" className="btn h-10 flex-1" disabled={!!busy} onClick={() => decide(false)}>
          {busy === 'deny' ? 'Declining…' : 'Deny'}
        </Button>
        <Button variant="raw" size="raw" type="button" className="btn-dark h-10 flex-1" disabled={!!busy} onClick={() => decide(true)}>
          <Icon name="key" size={14} />
          {busy === 'allow' ? 'Connecting…' : 'Allow'}
        </Button>
      </div>
      <p className="mt-4 text-xs text-muted">You can disconnect it at any time on the Agents page.</p>
    </Card>
  );
}

function Row({ title, pill, children }: { title: ReactNode; pill: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 border-rule py-3 [&+&]:border-t">
      <div className="min-w-0">
        <b className="font-medium">{title}</b>
        <p className="mt-0.5 text-sm text-muted">{children}</p>
      </div>
      {pill}
    </li>
  );
}

function Choice({ on, onClick, title, desc }: { on: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <Button variant="raw" size="raw"
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`flex items-start gap-2.5 rounded-xl border bg-surface px-3 py-2.5 text-left transition-colors duration-150 ${
        on ? 'border-accent outline outline-1 -outline-offset-2 outline-accent' : 'border-line hover:border-control'
      }`}
    >
      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${on ? 'border-accent' : 'border-control'}`}>
        {on && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0">
        <b className="block font-medium">{title}</b>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </Button>
  );
}
