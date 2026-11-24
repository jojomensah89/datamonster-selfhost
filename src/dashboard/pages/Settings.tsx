import { ChevronDown as DisclosureChevron } from 'lucide-react';
import { Checkbox } from '../components/primitives/checkbox';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../components/primitives/collapsible';
import { Button } from '../components/primitives/button';
import { Input } from '../components/primitives/input';
import { Switch } from '../components/primitives/switch';
import { SelectField, SelectItem } from '../components/primitives/select-field';
import { useEffect, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { Favicon } from '../components/Icons';
import { CurrencySelect, TimezoneSelect } from '../components/SiteFields';
import { CopyIcon, CopyRow, Hint } from '../components/CopyIcon';
import { BlockError, Icon, TitleRow } from '../components/ui';
import { buildAiPrompt } from '../lib/aiPrompt';
import { api, ApiError, type Site } from '../lib/api';
import { fmtAgo, fmtMoney } from '../lib/format';
import { useApi } from '../lib/useApi';

/** The page's sections, in order. The in-page nav and each Section's id come from this one list. */
const SECTIONS = [
  { id: 'coding-agent', label: 'Coding agent' },
  { id: 'install', label: 'Install the script' },
  { id: 'widget', label: 'Online widget' },
  { id: 'goals', label: 'Goals' },
  { id: 'payments', label: 'Payments' },
  { id: 'general', label: 'General' },
  { id: 'delete', label: 'Delete website' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(null, '', `#${id}`);
  // Move focus to the heading so keyboard and screen-reader users land where they jumped.
  const h = document.getElementById(`${id}-title`);
  if (h) {
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
}

/** Which section is in view, for the nav's current item. */
function useCurrentSection(ready: boolean) {
  const [current, setCurrent] = useState<SectionId>(SECTIONS[0].id);
  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return;
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = SECTIONS.find((s) => seen.get(s.id));
        if (first) setCurrent(first.id);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ready]);
  return current;
}

/** Desktop: a short sticky list beside the page. Phone and tablet: one compact select that stays under the top bar. */
function SectionNav() {
  const current = useCurrentSection(true);
  return (
    <>
      <nav aria-label="Settings sections" className="hidden xl:block">
        <ul className="sticky top-6 space-y-0.5 text-sm">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                aria-current={current === s.id ? 'location' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  jump(s.id);
                }}
                className={`block rounded-lg px-2.5 py-1.5 transition-colors duration-150 ${
                  current === s.id ? 'bg-raised font-medium text-ink' : 'text-muted hover:bg-raised hover:text-ink'
                }`}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="sticky top-12 z-20 -mx-4 bg-surface px-4 py-2 frame:top-0 frame:-mx-6 frame:px-6 xl:hidden">
        <label className="sr-only" htmlFor="settings-jump">
          Jump to section
        </label>
        <SelectField id="settings-jump" className="input h-9" value={current} onValueChange={(value) => jump(value)}>
          {SECTIONS.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.label}
            </SelectItem>
          ))}
        </SelectField>
      </div>
    </>
  );
}

/** Settings layout: a label column on the left, the work on the right; stacked below 1024px. */
function Section({ id, title, desc, children, first }: { id: SectionId; title: string; desc?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`grid scroll-mt-28 gap-3 py-7 frame:scroll-mt-6 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)] lg:gap-8 ${first ? 'pt-2' : 'border-t border-line'}`}
    >
      <div>
        <h2 id={`${id}-title`} className="text-base font-semibold outline-none lg:mt-1">
          {title}
        </h2>
        {desc && <p className="mt-1 max-w-[42ch] text-muted">{desc}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** A code block with a small header bar, so the copy button never covers the code. */
function Code({ label, children }: { label?: string; children: string }) {
  return (
    <div className="rounded-xl bg-code dark:border dark:border-line">
      <div className="flex items-center justify-between border-b border-codeInk/10 py-1.5 pl-4 pr-1.5">
        <span className="font-mono text-xs text-codeMuted">{label}</span>
        <CopyIcon text={children} what={label ?? 'the code'} className="icon-btn-code" />
      </div>
      <code className="code rounded-t-none" tabIndex={0} aria-label={label ?? 'Code snippet'}>{children}</code>
    </div>
  );
}

/** A single line to copy, e.g. a webhook URL. */
function CopyField({ value }: { value: string }) {
  return (
    <CopyRow value={value} what="the webhook URL" />
  );
}

function SecretField({ name, value, configured, status, onChange, onSave }: { name: string; value: string; configured: boolean; status: WebhookState; onChange: (v: string) => void; onSave: () => void }) {
  return (
    <div>
      <div className="flex gap-2">
        <Input className="input font-mono" type="password" aria-label={`${name} signing secret`} placeholder="whsec_..." value={value} onChange={(e) => onChange(e.target.value)} />
        <Button variant="raw" size="raw" type="button" className="btn-dark h-9" onClick={onSave}>
          Save
        </Button>
      </div>
      {configured && <WebhookStatus name={name} {...status} className="mt-3" />}
    </div>
  );
}

/** What the payment connection really looks like: a saved secret only proves the setup, a recorded payment proves the webhook. */
interface WebhookState {
  /** Newest payment or refund recorded from this provider for the site; null while none has arrived. undefined while loading. */
  last: number | null | undefined;
  checking: boolean;
  onCheck: () => void;
  failed?: boolean;
}

function WebhookStatus({ name, last, checking, onCheck, failed, className = '' }: WebhookState & { name: string; className?: string }) {
  if (last === undefined && !failed) return <p className={`text-sm text-muted ${className}`}>Secret saved. Checking for webhooks…</p>;
  if (failed && last === undefined)
    return (
      <p className={`text-sm text-muted ${className}`}>
        Secret saved. Couldn't check whether a webhook has arrived.{' '}
        <Button variant="raw" size="raw" type="button" className="card-link" onClick={onCheck}>
          Retry
        </Button>
      </p>
    );
  if (last)
    return (
      <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${className}`}>
        <span className="pill pill-pos">Webhook received</span>
        <span className="text-muted" title={new Date(last).toLocaleString()}>
          Last {name} payment {fmtAgo(Math.max(0, Date.now() - last))} ago.
        </span>
      </p>
    );
  return (
    <div className={`text-sm ${className}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="pill pill-warn">Waiting for the first webhook</span>
        <span className="text-muted">Secret saved.</span>
      </p>
      <p className="mt-1.5 max-w-[60ch] text-muted">
        This turns to received once {name} sends a payment or refund for this website. A test payment in {name} is the quickest way to check.{' '}
        <Button variant="raw" size="raw" type="button" className="card-link" onClick={onCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </p>
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-5 text-sm">{children}</ol>;
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-medium text-muted" aria-hidden="true">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p>{title}</p>
        {children}
      </div>
    </li>
  );
}

type LoadFailure = 'not-found' | 'network' | 'session' | 'server';

function failureOf(e: unknown): { kind: LoadFailure; message: string } {
  if (e instanceof ApiError) {
    if (e.status === 401) return { kind: 'session', message: e.message };
    if (e.status === 404 || e.status === 403) return { kind: 'not-found', message: e.message };
    return { kind: 'server', message: e.message };
  }
  return { kind: 'network', message: (e as Error)?.message ?? 'Network error' };
}

/** The site couldn't be loaded: say why, offer Retry where it can help, and always a way back to All websites. */
function LoadError({ failure, siteId, onRetry, retrying }: { failure: { kind: LoadFailure; message: string }; siteId: string; onRetry: () => void; retrying: boolean }) {
  const copy: Record<LoadFailure, { title: string; body: string }> = {
    'not-found': { title: "This website isn't here", body: `No website with the id ${siteId} belongs to this account. It may have been deleted, or the link is from another account.` },
    network: { title: "Couldn't reach DataMonster", body: "The request didn't get through. Check your connection, then retry." },
    session: { title: 'Your session expired', body: 'Sign in again to keep working. Taking you to the sign-in page.' },
    server: { title: "Couldn't load this website's settings", body: `The server answered with an error: ${failure.message.replace(/\.$/, '')}. Retry in a moment.` },
  };
  const c = copy[failure.kind];
  return (
    <div>
      <TitleRow title="Install and settings" />
      <div className="max-w-xl rounded-2xl border border-line p-5" role="alert">
        <div className="flex items-start gap-2.5">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-negative" />
          <div className="min-w-0">
            <h2 className="font-semibold">{c.title}</h2>
            <p className="mt-1 text-muted">{c.body}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 pl-[26px]">
          {(failure.kind === 'network' || failure.kind === 'server') && (
            <Button variant="raw" size="raw" type="button" className="btn-dark" onClick={onRetry} disabled={retrying}>
              <Icon name="refresh" size={14} className={retrying ? 'animate-spin' : ''} />
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          )}
          <Button variant="raw" size="raw" type="button" className={failure.kind === 'not-found' ? 'btn-dark' : 'btn'} onClick={() => navigate('/')}>
            All websites
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Settings({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [form, setForm] = useState<Partial<Site>>({});
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [failure, setFailure] = useState<{ kind: LoadFailure; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const origin = window.location.origin;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<Site>(`/api/sites/${siteId}`)
      .then((s) => {
      if (!alive) return;
      setFailure(null);
      setSite(s);
      setForm({
        name: s.name,
        domain: s.domain,
        timezone: s.timezone,
        currency: s.currency,
        dodo_webhook_secret: s.dodo_webhook_secret ?? '',
        dodo_product_ids: s.dodo_product_ids ?? '',
        stripe_webhook_secret: s.stripe_webhook_secret ?? '',
      });
      })
      .catch((e) => alive && setFailure(failureOf(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [siteId, attempt]);

  // Arriving with #payments (or any section) in the URL: go there once the page has rendered.
  const ready = !!site;
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (ready && SECTIONS.some((x) => x.id === id)) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, [ready]);

  async function save(patch: Partial<Site>, msg = 'Saved') {
    setError('');
    try {
      const s = await api<Site>(`/api/sites/${siteId}`, { method: 'PATCH', json: patch });
      setSite(s);
      setSaved(msg);
      setTimeout(() => setSaved(''), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function flash(msg: string, isError = false) {
    if (isError) return setError(msg);
    setError('');
    setSaved(msg);
    setTimeout(() => setSaved(''), 2000);
  }

  if (!site && failure) return <LoadError failure={failure} siteId={siteId} retrying={loading} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!site)
    return (
      <div aria-busy="true" aria-label="Loading settings">
        <div className="skeleton h-7 w-56" />
        <div className="skeleton mt-2 h-4 w-80" />
        <div className="skeleton mt-8 h-40 rounded-2xl" />
      </div>
    );
  const set = (patch: Partial<Site>) => setForm({ ...form, ...patch });

  return (
    <div>
      <TitleRow
        title="Install and settings"
        sub={
          <span className="inline-flex items-center gap-1.5">
            <Favicon domain={site.domain} size={14} /> {site.name} · {site.domain}
          </span>
        }
        actions={
          <Button variant="raw" size="raw" type="button" className="btn" onClick={() => navigate(`/site/${site.id}`)}>
            <Icon name="overview" size={14} />
            Open overview
          </Button>
        }
      />

      <div className="xl:grid xl:grid-cols-[168px_minmax(0,1fr)] xl:gap-8">
        <SectionNav />
        <div className="min-w-0">
      <AiSetup site={site} origin={origin} />

      <Section id="install" title="Install the script" desc={<>Add this line to the <code className="text-[13px] text-ink">&lt;head&gt;</code> of every page on {site.domain}. Many website builders have a box for it, called custom code or header code.</>}>
        <Code label="HTML">{`<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`}</Code>
        <Collapsible className="mt-4 text-sm">
          <CollapsibleTrigger asChild><Button variant="raw" size="raw" type="button" className="cursor-pointer font-medium text-ink">Next.js, and beating ad blockers<DisclosureChevron className="disclosure-chevron ml-2 inline-block h-4 w-4" aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent>
          <div className="mt-3 space-y-3">
            <Code label="app/layout.tsx">{`import Script from 'next/script';

<Script defer data-website-id="${site.id}" src="${origin}/js/script.js" />`}</Code>
            <p className="text-muted">Serve the script from your own domain so ad blockers don't stop it:</p>
            <Code label="next.config.js">{`async rewrites() {
  return [
    { source: '/stats/script.js', destination: '${origin}/js/script.js' },
    { source: '/stats/event', destination: '${origin}/api/event' },
  ];
}
// then: <script defer data-website-id="${site.id}" data-api="/stats/event" src="/stats/script.js"></script>`}</Code>
            <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-raised p-4">
              <label htmlFor="proxy-location" className="min-w-0">
                <span className="block font-medium text-ink">My website serves the script itself</span>
                <span className="mt-0.5 block text-muted">Turn this on if you use the setup above. Your visitors all arrive through your server, so this allows more events from one address and uses the visitor locations Vercel sends. Leave it off otherwise: anyone can send those headers.</span>
              </label>
              <Switch id="proxy-location" checked={!!site.proxy_location} onCheckedChange={(on) => save({ proxy_location: on })} />
            </div>
          </div>
        </CollapsibleContent></Collapsible>
        <div className="mt-3 space-y-2">
          <Button asChild variant="outline" size="sm">
            <a href={`https://${site.domain}/?dm_ignore=true`} target="_blank" rel="noopener noreferrer">Exclude this browser</a>
          </Button>
          <p className="text-sm text-muted">To stop counting your own visits, open {site.domain}/?dm_ignore=true once in each browser you use (undo with ?dm_ignore=false).</p>
        </div>
      </Section>

      <OnlineWidgetSettings key={site.id} siteId={site.id} />
      <Section id="goals" title="Track goals" desc="Count clicks on a button, such as Book now or Get started. This needs a small change to the button in your website's code.">
        <Code label="HTML / JS">{`<button data-dm-goal="signup">Get started</button>

window.datamonster('goal', 'signup', { plan: 'pro' });
window.datamonster('identify', { email: user.email, name: user.name });`}</Code>
      </Section>

      <Revenue site={site} origin={origin} form={form} set={set} save={save} flash={flash} onKeyRotated={(api_key) => setSite({ ...site, api_key })} />

      <Section id="general" title="General">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="site-name">
              Name
            </label>
            <Input id="site-name" className="input" value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="site-domain">
              Domain
            </label>
            <Input id="site-domain" className="input" value={form.domain ?? ''} onChange={(e) => set({ domain: e.target.value })} />
          </div>
          <div>
            <label className="label">Timezone</label>
            <TimezoneSelect value={form.timezone ?? 'UTC'} onChange={(timezone) => set({ timezone })} />
          </div>
          <div>
            <label className="label">Revenue currency</label>
            <CurrencySelect value={form.currency ?? 'USD'} onChange={(currency) => set({ currency })} />
          </div>
        </div>
        <Button variant="raw" size="raw" type="button" className="btn-dark mt-4" onClick={() => save({ name: form.name, domain: form.domain, timezone: form.timezone, currency: form.currency })}>
          Save changes
        </Button>
      </Section>

      {(saved || error) && (
        <div role="status" aria-live="polite" className={`toast ${error ? '!bg-negative' : ''}`}>
          {error || saved}
        </div>
      )}

      <Section id="delete" title="Delete this website" desc="Removes the website from DataMonster and everything stored for it: visits, payments, goals, funnels, links, notes and launches. This cannot be undone.">
        <Button variant="raw" size="raw"
          type="button"
          className="btn-danger"
          onClick={async () => {
            if (prompt(`Type ${site.domain} to delete this website and all of its data`) !== site.domain) return;
            await api(`/api/sites/${siteId}`, { method: 'DELETE' });
            navigate('/');
          }}
        >
          Delete website and all data
        </Button>
      </Section>
        </div>
      </div>
    </div>
  );
}

type Provider = 'dodo' | 'stripe' | 'polar' | 'api';

interface RevenueProps {
  site: Site;
  origin: string;
  form: Partial<Site>;
  set: (patch: Partial<Site>) => void;
  save: (patch: Partial<Site>, msg?: string) => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
  onKeyRotated: (key: string) => void;
}

/** GET/PATCH /api/sites/:id/providers: secrets come back masked, so only the connection state is shown. */
interface ProviderState {
  polar_webhook_secret: string | null;
  connected: { polar: boolean };
  /** Newest recorded payment per provider (ms), null when none has arrived yet. */
  last_payment?: Record<'dodo' | 'stripe' | 'polar', number | null>;
}
type ProviderSecretKey = 'polar_webhook_secret';

/** Revenue attribution: pick the payment provider, see only its setup. */
function Revenue(props: RevenueProps) {
  const { site } = props;
  const [retry, setRetry] = useState(0);
  const providers = useApi<ProviderState>(`/api/sites/${site.id}/providers`, retry);
  const connected = providers.data?.connected;
  const status = (p: 'dodo' | 'stripe' | 'polar'): WebhookState => ({
    last: providers.data ? (providers.data.last_payment?.[p] ?? null) : undefined,
    checking: providers.loading,
    failed: !!providers.error,
    onCheck: () => setRetry((n) => n + 1),
  });
  // Saving a Dodo or Stripe secret goes through the site; check the webhook state again afterwards.
  const save: RevenueProps['save'] = async (patch, msg) => {
    await props.save(patch, msg);
    setRetry((n) => n + 1);
  };
  const setupProps = { ...props, save };
  const [provider, setProvider] = useState<Provider>(site.stripe_webhook_secret && !site.dodo_webhook_secret ? 'stripe' : 'dodo');
  const [picked, setPicked] = useState(false);
  // Open on the provider that is already connected, once its state has loaded.
  useEffect(() => {
    if (picked || !connected || site.dodo_webhook_secret || site.stripe_webhook_secret) return;
    if (connected.polar) setProvider('polar');
  }, [connected]);

  async function saveSecret(key: ProviderSecretKey, value: string | null, msg: string) {
    try {
      const r = await api<ProviderState>(`/api/sites/${site.id}/providers`, { method: 'PATCH', json: { [key]: value } });
      providers.setData(r);
      props.flash(msg);
      return true;
    } catch (e) {
      props.flash((e as Error).message, true);
      return false;
    }
  }

  // Phone: two by two. 640px and up: one row of four.
  const last = providers.data?.last_payment;
  const tabs: { id: Provider; label: string; connected?: boolean; received?: boolean; span: string }[] = [
    { id: 'dodo', label: 'Dodo Payments', connected: !!site.dodo_webhook_secret, received: !!last?.dodo, span: '' },
    { id: 'stripe', label: 'Stripe', connected: !!site.stripe_webhook_secret, received: !!last?.stripe, span: '' },
    { id: 'polar', label: 'Polar', connected: connected?.polar, received: !!last?.polar, span: '' },
    { id: 'api', label: 'Other or API', span: '' },
  ];
  return (
    <Section id="payments" title="Connect payments" desc="So each sale can be linked to the visit that brought it.">
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4" role="tablist" aria-label="Payment provider">
        {tabs.map((t) => (
          <Button variant="raw" size="raw"
            key={t.id}
            type="button"
            role="tab"
            aria-selected={provider === t.id}
            onClick={() => {
              setProvider(t.id);
              setPicked(true);
            }}
            className={`${t.span} flex h-11 min-w-0 items-center justify-center gap-2 rounded-xl border bg-surface px-3 text-sm font-medium transition-[color,border-color,transform] duration-150 active:scale-[0.98] ${
              provider === t.id ? 'border-accent text-ink outline outline-1 -outline-offset-2 outline-accent' : 'border-line text-muted hover:border-control hover:text-ink'
            }`}
          >
            <span className="truncate">{t.label}</span>
            {t.connected &&
              (t.received ? (
                <>
                  <span className="live-dot" aria-hidden="true" />
                  <span className="sr-only">, webhook received</span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-faint" aria-hidden="true" />
                  <span className="sr-only">, secret saved, waiting for the first webhook</span>
                </>
              ))}
          </Button>
        ))}
      </div>
      {provider === 'dodo' && <DodoSetup {...setupProps} status={status('dodo')} />}
      {provider === 'stripe' && <StripeSetup {...setupProps} status={status('stripe')} />}
      {provider === 'polar' &&
        (providers.error ? (
          <BlockError what={`Couldn't load the connection state: ${providers.error}`} onRetry={() => setRetry((n) => n + 1)} />
        ) : !providers.data ? (
          <div aria-busy="true" className="skeleton h-48 rounded-2xl" />
        ) : (
          <PolarSetup {...props} connected={providers.data.connected.polar} saveSecret={saveSecret} status={status('polar')} />
        ))}
      {provider === 'api' && <ApiSetup {...props} />}
    </Section>
  );
}

interface HookedProps extends RevenueProps {
  connected: boolean;
  saveSecret: (key: ProviderSecretKey, value: string | null, msg: string) => Promise<boolean>;
  status: WebhookState;
}

/**
 * The signing secret for a provider whose secret the server never sends back. Not connected: a field and Save.
 * Connected: the state in words, Replace (opens the field again) and Disconnect.
 */
function StoredSecret({
  name,
  secretKey,
  connected,
  placeholder,
  saveSecret,
  status,
}: {
  name: string;
  secretKey: ProviderSecretKey;
  connected: boolean;
  placeholder: string;
  saveSecret: HookedProps['saveSecret'];
  status: WebhookState;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = `secret-${secretKey}`;

  async function run(next: string | null, msg: string) {
    setBusy(true);
    const ok = await saveSecret(secretKey, next, msg);
    setBusy(false);
    if (ok) {
      setValue('');
      setEditing(false);
      if (next) status.onCheck();
    }
  }

  if (connected && !editing)
    return (
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <WebhookStatus name={name} {...status} className="min-w-0 flex-1 basis-[260px]" />
        <span className="-ml-3 flex items-center gap-1 sm:ml-auto">
          <Button variant="raw" size="raw" type="button" className="btn-ghost" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button variant="raw" size="raw"
            type="button"
            className="btn-ghost !text-negative"
            disabled={busy}
            onClick={() => {
              if (confirm(`Disconnect ${name}? Its webhooks are refused until you save a secret again. Payments already recorded stay.`))
                run(null, `${name} disconnected`);
            }}
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </span>
      </div>
    );

  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) run(value.trim(), `${name} secret saved`);
      }}
    >
      <Input
        id={id}
        className="input font-mono placeholder:font-sans"
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`${name} signing secret`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button variant="raw" size="raw" className="btn-dark h-9" disabled={busy || !value.trim()}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      {editing && (
        <Button variant="raw" size="raw" type="button" className="btn-ghost h-9" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      )}
    </form>
  );
}

function PolarSetup({ site, origin, connected, saveSecret, status }: HookedProps) {
  return (
    <>
      <Steps>
        <Step
          n={1}
          title={
            <>
              In Polar → <b>Settings → Webhooks</b>, add this endpoint with format <b>Raw</b>, subscribed to <code>order.paid</code> and{' '}
              <code>order.refunded</code>:
            </>
          }
        >
          <CopyField value={`${origin}/api/webhooks/polar/${site.id}`} />
        </Step>
        <Step n={2} title={connected ? 'Signing secret:' : 'Paste the secret Polar shows for it:'}>
          <StoredSecret name="Polar" secretKey="polar_webhook_secret" connected={connected} placeholder="polar_whs_..." saveSecret={saveSecret} status={status} />
        </Step>
        <Step n={3} title="Pass the visitor to your checkout. Hosted checkout links need nothing, the script tags them.">
          <Code label="checkout.ts">{`const jar = await cookies(); // next/headers

await polar.checkouts.create({
  // ...your existing options
  successUrl: 'https://${site.domain}/thanks?checkout_id={CHECKOUT_ID}',
  metadata: {
    dm_visitor_id: jar.get('dm_vid')?.value ?? '',
  },
});`}</Code>
          <p className="text-muted">
            Checkouts without metadata are still matched when their success URL ends in <code>?checkout_id={'{CHECKOUT_ID}'}</code> and that page
            loads the script.
          </p>
        </Step>
      </Steps>
      <ProviderFooter note="Renewals follow the first customer; refunds, tax included, are subtracted once." />
    </>
  );
}

function DodoSetup({ site, origin, form, set, save, status }: RevenueProps & { status: WebhookState }) {
  return (
    <>
      <Steps>
        <Step
          n={1}
          title={
            <>
              In Dodo → <b>Developer → Webhooks</b>, add this endpoint with <code>payment.succeeded</code> and <code>refund.succeeded</code>:
            </>
          }
        >
          <CopyField value={`${origin}/api/webhooks/dodo/${site.id}`} />
        </Step>
        <Step n={2} title="Paste its signing secret:">
          <SecretField
            name="Dodo"
            status={status}
            value={form.dodo_webhook_secret ?? ''}
            configured={!!site.dodo_webhook_secret}
            onChange={(v) => set({ dodo_webhook_secret: v })}
            onSave={() => save({ dodo_webhook_secret: form.dodo_webhook_secret ?? '' }, 'Dodo secret saved')}
          />
        </Step>
        <Step n={3} title="Pass the visitor to your checkout. Payment links need nothing, the script tags them.">
          <Code label="checkout.ts">{`const jar = await cookies(); // next/headers

await dodo.checkoutSessions.create({
  // ...your existing options
  return_url: 'https://${site.domain}/thanks',
  metadata: {
    dm_visitor_id: jar.get('dm_vid')?.value ?? '',
    dm_session_id: jar.get('dm_sid')?.value ?? '',
  },
});`}</Code>
        </Step>
      </Steps>
      <Collapsible className="mt-5 text-sm">
        <CollapsibleTrigger asChild><Button variant="raw" size="raw" type="button" className="cursor-pointer font-medium text-ink">Selling other products from the same Dodo account?<DisclosureChevron className="disclosure-chevron ml-2 inline-block h-4 w-4" aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent>
        <p className="mt-2 text-muted">List this website's product ids so only their payments count.</p>
        <div className="mt-2 flex gap-2">
          <Input
            className="input font-mono"
            aria-label="Dodo product ids"
            placeholder="pdt_abc123, pdt_def456"
            value={form.dodo_product_ids ?? ''}
            onChange={(e) => set({ dodo_product_ids: e.target.value })}
          />
          <Button variant="raw" size="raw" type="button" className="btn-dark h-9" onClick={() => save({ dodo_product_ids: form.dodo_product_ids ?? '' }, 'Products saved')}>
            Save
          </Button>
        </div>
      </CollapsibleContent></Collapsible>
      <PendingDodoPayments site={site} />
      <ProviderFooter />
    </>
  );
}

const currencyDecimals = (c: string) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

interface PendingProduct {
  product_id: string | null;
  count: number;
  amount: number;
  currency: string | null;
}

/** Payments from a product DataMonster couldn't link to any site yet. Rare: most are placed automatically. */
function PendingDodoPayments({ site }: { site: Site }) {
  const [rows, setRows] = useState<PendingProduct[]>([]);
  const load = () => api<PendingProduct[]>(`/api/sites/${site.id}/pending-payments`).then(setRows);
  useEffect(() => {
    load();
  }, [site.id]);
  if (!rows.length) return null;
  return (
    <div className="notice mt-5 p-4">
      <p className="font-medium">Payments waiting for a website</p>
      <p className="mt-1">
        These came from a product that isn't linked to one of your websites yet, so they aren't counted anywhere. They're placed automatically
        once a payment for it arrives with a visitor from {site.name}. Know they're {site.name}'s? Count them now.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li key={r.product_id ?? ''} className="flex items-center justify-between gap-3">
            <span>
              <code>{r.product_id ?? 'unknown product'}</code> · {r.count} payment{r.count === 1 ? '' : 's'},{' '}
              {fmtMoney(r.amount, r.currency ?? site.currency, currencyDecimals(r.currency ?? site.currency))}
            </span>
            {r.product_id && (
              <Button variant="raw" size="raw"
                type="button"
                className="btn shrink-0"
                onClick={() => api(`/api/sites/${site.id}/pending-payments`, { method: 'POST', json: { product_id: r.product_id } }).then(load)}
              >
                Count for {site.name}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StripeSetup({ site, origin, form, set, save, status }: RevenueProps & { status: WebhookState }) {
  return (
    <>
      <Steps>
        <Step
          n={1}
          title={
            <>
              In Stripe → <b>Developers → Webhooks</b>, add this endpoint with <code>checkout.session.completed</code>,{' '}
              <code>invoice.paid</code> and <code>charge.refunded</code>:
            </>
          }
        >
          <CopyField value={`${origin}/api/webhooks/stripe/${site.id}`} />
        </Step>
        <Step n={2} title="Paste its signing secret:">
          <SecretField
            name="Stripe"
            status={status}
            value={form.stripe_webhook_secret ?? ''}
            configured={!!site.stripe_webhook_secret}
            onChange={(v) => set({ stripe_webhook_secret: v })}
            onSave={() => save({ stripe_webhook_secret: form.stripe_webhook_secret ?? '' }, 'Stripe secret saved')}
          />
        </Step>
        <Step n={3} title="Pass the visitor to your checkout:">
          <Code label="checkout.ts">{`const jar = await cookies(); // next/headers

await stripe.checkout.sessions.create({
  // ...your existing options
  success_url: 'https://${site.domain}/thanks?session_id={CHECKOUT_SESSION_ID}',
  metadata: {
    dm_visitor_id: jar.get('dm_vid')?.value ?? '',
    dm_session_id: jar.get('dm_sid')?.value ?? '',
    dm_site_id: '${site.id}', // only needed if one Stripe account sells for several sites
  },
});`}</Code>
          <p className="text-muted">
            Using <b className="font-medium text-ink">Payment Links</b>? No code needed. Set the link's confirmation page to redirect to{' '}
            <code>https://{site.domain}/thanks?session_id={'{CHECKOUT_SESSION_ID}'}</code>.
          </p>
        </Step>
      </Steps>
      <ProviderFooter />
    </>
  );
}

function ApiSetup({ site, origin, onKeyRotated }: RevenueProps) {
  return (
    <>
      <p className="mb-3 text-sm text-muted">Any other provider: send payments from your backend with this website's API key.</p>
      <div className="mb-4 flex gap-2">
        <Input className="input font-mono" aria-label="Site API key" readOnly value={site.api_key} />
        <Button variant="raw" size="raw"
          type="button"
          className="btn h-9"
          onClick={async () => {
            if (!confirm('Rotate the API key? The old key stops working immediately.')) return;
            const r = await api<{ api_key: string }>(`/api/sites/${site.id}/rotate-key`, { method: 'POST' });
            onKeyRotated(r.api_key);
          }}
        >
          Rotate
        </Button>
      </div>
      <Code label="POST /api/v1/payments">{`curl -X POST ${origin}/api/v1/payments \\
  -H "Authorization: Bearer ${site.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "transaction_id": "txn_123",
    "amount": 29.99,
    "currency": "${site.currency}",
    "visitor_id": "<dm_vid cookie>",
    "email": "jane@acme.com"
  }'`}</Code>
      <ProviderFooter note={<>Refunds: send the same transaction with <code>"refunded": true</code>. Renewals: add <code>"renewal": true</code>. Server-side goals: <code>POST /api/v1/goals</code> with <code>visitor_id</code> and <code>name</code>.</>} />
    </>
  );
}

function ProviderFooter({ note = 'No metadata? Payments are still matched by return page, email or timing.' }: { note?: ReactNode }) {
  return (
    <p className="mt-5 border-t border-rule pt-4 text-sm text-muted">
      {note}
    </p>
  );
}

/** One-click prompt for the owner's coding AI, so it can install everything in their codebase. */
function AiSetup({ site, origin }: { site: Site; origin: string }) {
  const [open, setOpen] = useState(false);
  const { data: auth } = useApi<{ hosted: boolean }>('/api/auth/me');
  const prompt = buildAiPrompt(site, origin, auth?.hosted ?? true);
  return (
    <Section id="coding-agent" title="Let your coding agent do it" desc="Paste one prompt into Claude Code, Codex or Cursor where your website's code is. It sets up the script, goals and payments below. If someone else looks after your website, send them the prompt." first>
      <div className="well p-4">
        <CopyRow value={prompt} shown={prompt.split('\n')[0]} what="the prompt" mono={false}>
          <Hint text={open ? 'Hide prompt' : 'Preview prompt'}>
            <Button variant="raw" size="raw" type="button" className="icon-btn" aria-label={open ? 'Hide prompt' : 'Preview prompt'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="down" className="link-chevron" />
            </Button>
          </Hint>
        </CopyRow>
        {open && <pre className="code anim-fade mt-3 max-h-96 whitespace-pre-wrap">{prompt}</pre>}
      </div>
    </Section>
  );
}

function OnlineWidgetSettings({siteId}: {siteId:string}) {
  const [options,setOptions]=useState({enabled:false,visitors:false,threshold:3,rounding:true,theme:'auto',powered:true});
  const [ready,setReady]=useState(false), [message,setMessage]=useState('');
  useEffect(()=>{let alive=true;api(`/api/sites/${siteId}/widget`).then(o=>{if(alive){setOptions(o);setReady(true)}}).catch(e=>setMessage(e.message));return()=>{alive=false}},[siteId]);
  const snippet=`<script async src="${location.origin}/js/widget.js"></script>\n<datamonster-online site="${siteId}" theme="${options.theme}" powered="${options.powered}" style="display:inline-block;height:34px"></datamonster-online>`;
  const dark=options.theme==='dark';
  return <Section id="widget" title="Online widget" desc="Share public aggregate counts. Sharing starts off. Anyone can fetch and retain these counts.">
    <form className="space-y-4" onSubmit={async e=>{e.preventDefault();try{await api(`/api/sites/${siteId}/widget`,{method:'PUT',json:options});setMessage('Saved')}catch(e){setMessage(String(e))}}}>
      {(['enabled','visitors','rounding','powered'] as const).map(k=><label key={k} className="flex items-center gap-2"><Checkbox  checked={options[k]} disabled={!ready} onCheckedChange={checked=>setOptions({...options,[k]:(checked === true)})}/>{{enabled:'Share online count',visitors:'Also share distinct visitors in the last 30 days',rounding:'Round down to two significant digits',powered:'Show "Powered by DataMonster" on hover (default on, removable on every plan)'}[k]}</label>)}
      <label className="block">Minimum for each count<Input className="input" type="number" min="3" max="10000" value={options.threshold} onChange={e=>setOptions({...options,threshold:Number.isFinite(e.target.valueAsNumber)?e.target.valueAsNumber:3})}/></label>
      <label className="block">Theme<SelectField className="input" value={options.theme} onValueChange={value=>setOptions({...options,theme:value})}>{['auto','light','dark'].map(t=><SelectItem value={t} key={t}>{t}</SelectItem>)}</SelectField></label>
      <Button variant="raw" size="raw" type="submit" className="btn-dark" disabled={!ready}>Save widget settings</Button><p role="status">{message}</p>
      <p className="text-muted">Illustrative preview: 10 online; 1,000 visitors over the last 30 days. Online means active within five minutes. Each count is hidden below the minimum.</p>
      <iframe title="Widget preview (illustrative counts)" sandbox="allow-scripts" className="h-24 w-full border-0" srcDoc={`<body style="margin:8px;background:${dark?'#080f20':'#fff'}"><script>window.fetch=async()=>({ok:true,json:async()=>({online:${options.enabled&&options.threshold<=10?10:'null'},visitors:${options.enabled&&options.visitors&&options.threshold<=1000?1000:'null'}})});</script>${snippet}`} />
      <Code label="Embed">{snippet}</Code>
    </form>
  </Section>;
}
