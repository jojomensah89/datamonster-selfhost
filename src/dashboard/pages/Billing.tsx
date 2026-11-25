import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMe } from '../App';
import { Hint } from '../components/CopyIcon';
import { Favicon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { Button } from '../components/primitives/button';
import { SpikeCharacter, type SpikeTrigger } from '../components/SpikeCharacter';
import { BlockError, Icon, TitleRow } from '../components/ui';
import { api, type BillingAccount, type BillingUsage, type Me } from '../lib/api';
import { fmtMoney } from '../lib/format';
import { useApi } from '../lib/useApi';
import { usePlan } from './Landing';

type User = NonNullable<Me['user']>;

const n = (x: number) => x.toLocaleString('en-US');
const day = (t: number) => new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
/** The month of usage is a UTC month, so its dates are read in UTC. */
const utcDay = (t: number) => new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const ERRORS: Record<string, string> = {
  portal: "We couldn't open your plan's page.",
  receipt: "We couldn't get that receipt.",
  checkout: "We couldn't start the checkout.",
};

/** A failed or paused payment is put right on the subscription they already have; a second one would be refused. */
const fixable = (u: User) => ['past_due', 'unpaid', 'paused'].includes(u.plan_status);

export function Billing() {
  const { me, refresh } = useMe();
  const plan = usePlan();
  const user = me.user!;
  const [reload, setReload] = useState(0);
  const { data: usage, error: usageError } = useApi<BillingUsage>('/api/billing/usage', reload);
  const { data: account, error: accountError } = useApi<BillingAccount>(user.admin ? null : '/api/billing/account', reload);
  const query = new URLSearchParams(window.location.search);
  const [waiting, setWaiting] = useState(query.get('paid') === '1' && !user.paid);
  const [justPro, setJustPro] = useState(query.get('paid') === '1' && user.paid);
  const [late, setLate] = useState(false);
  const [problem, setProblem] = useState(ERRORS[query.get('error') ?? ''] ?? '');
  const support = plan?.supportEmail ?? me.supportEmail ?? null;

  // Polar sends people back before its webhook may have arrived; keep checking for a minute or two.
  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      const m = await refresh();
      if (m.user?.paid || tries > 40) {
        clearInterval(t);
        setWaiting(false);
        if (m.user?.paid) setJustPro(true);
        setLate(!m.user?.paid);
        setReload((k) => k + 1);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, refresh]);

  // Reloading the page must not bring an old message back. A checkout's address stays: the tracker reads the payment from it.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('error')) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);

  const changed = async () => {
    await refresh();
    setReload((k) => k + 1);
  };

  return (
    <div>
      <TitleRow title="Billing" />
      <div className="grid gap-3 [&:not(:empty)]:mb-6">
        {waiting && (
          <Banner icon={<span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" />}>Confirming your payment…</Banner>
        )}
        {late && (
          <Banner tone="warn">
            Your payment isn't confirmed yet. Refresh in a minute{support ? <>, or email {<Mail to={support} />}</> : null}.
          </Banner>
        )}
        {problem && (
          <Banner tone="neg" onClose={() => setProblem('')}>
            {problem} Try again in a minute{support ? <>, or email {<Mail to={support} />}</> : null}.
          </Banner>
        )}
        <PlanNotice user={user} onChanged={changed} onProblem={setProblem} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_336px]">
        <section className="card min-w-0 p-5 max-lg:order-1 sm:p-6" aria-label="Usage this month">
          {usage ? <Month usage={usage} user={user} /> : usageError ? <BlockError what="Couldn't load this month." onRetry={() => setReload((k) => k + 1)} /> : <div className="skeleton h-[420px]" aria-busy="true" aria-label="Loading usage" />}
        </section>
        <div className="contents lg:grid lg:content-start lg:gap-4">
          <PlanCard user={user} price={plan?.price} limits={plan} canBuy={!!plan?.checkout && !waiting} celebrateOnce={justPro} onChanged={changed} onProblem={setProblem} />
          {accountError ? (
            <div className="max-lg:order-2">
              <BlockError what="Couldn't load your payments." onRetry={() => setReload((k) => k + 1)} />
            </div>
          ) : (
            account && <Payments account={account} user={user} />
          )}
        </div>
      </div>
      <p className="mt-10 flex gap-4 text-xs text-muted">
        <a className="hover:text-ink hover:underline" href="/terms">
          Terms
        </a>
        <a className="hover:text-ink hover:underline" href="/privacy">
          Privacy
        </a>
        <a className="hover:text-ink hover:underline" href="/refund">
          Refunds
        </a>
      </p>
    </div>
  );
}

const Mail = ({ to }: { to: string }) => (
  <a className="underline" href={`mailto:${to}`}>
    {to}
  </a>
);

function Banner({ tone = 'plain', icon, action, onClose, children }: { tone?: 'plain' | 'warn' | 'neg'; icon?: ReactNode; action?: ReactNode; onClose?: () => void; children: ReactNode }) {
  const tones = { plain: 'border-line bg-raised text-ink', warn: 'border-warnLine bg-warnSoft text-warnInk', neg: 'border-negLine bg-negSoft text-negInk' };
  return (
    <div role={tone === 'neg' ? 'alert' : 'status'} className={`flex min-h-[52px] flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl border py-2 pl-4 pr-2.5 ${tones[tone]}`}>
      <span className="flex min-w-0 items-center gap-2.5">
        {icon ?? <Icon name="alert" />}
        <span>{children}</span>
      </span>
      {action}
      {onClose && (
        <Button variant="raw" size="raw" type="button" className="icon-btn" aria-label="Dismiss" onClick={onClose}>
          <Icon name="close" />
        </Button>
      )}
    </div>
  );
}

const Portal = ({ children }: { children: ReactNode }) => (
  <Button asChild variant="raw" size="raw" className="btn-dark">
    <a href="/api/billing/portal">{children}</a>
  </Button>
);

/** Cancelling and keeping the plan are the same call, the other way round. */
function useRenewal(onChanged: () => Promise<void>, onProblem: (s: string) => void) {
  const [busy, setBusy] = useState(false);
  const set = async (renews: boolean) => {
    setBusy(true);
    onProblem('');
    try {
      await api(`/api/billing/${renews ? 'resume' : 'cancel'}`, { method: 'POST' });
      await onChanged();
      return true;
    } catch {
      onProblem(renews ? "We couldn't keep your plan." : "We couldn't cancel your plan.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, set };
}

/** What needs doing about the plan, if anything. */
function PlanNotice({ user, onChanged, onProblem }: { user: User; onChanged: () => Promise<void>; onProblem: (s: string) => void }) {
  const { busy, set } = useRenewal(onChanged, onProblem);
  if (user.admin) return null;
  if (user.paid && user.plan_status === 'cancelled')
    return (
      <Banner
        tone="warn"
        action={
          <Button variant="raw" size="raw" type="button" className="btn-dark" disabled={busy} onClick={() => set(true)}>
            Keep Pro
          </Button>
        }
      >
        Pro ends {day(user.plan_until!)}. Your data stays.
      </Banner>
    );
  if (user.paid && user.plan_status === 'past_due') return <Banner tone="neg" action={<Portal>Update card</Portal>}>Your last payment failed. Pro stays on until {day(user.plan_until!)}.</Banner>;
  if (!user.paid && user.renewing && user.plan_status === 'refunded')
    return (
      <Banner
        tone="warn"
        action={
          <Button variant="raw" size="raw" type="button" className="btn-dark" disabled={busy} onClick={() => set(false)}>
            Stop renewing
          </Button>
        }
      >
        Your payment was refunded, but Pro still renews.
      </Banner>
    );
  if (!user.paid && fixable(user))
    return user.plan_status === 'paused' ? (
      <Banner tone="warn" action={<Portal>Resume Pro</Portal>}>Pro is paused, so you're on Free.</Banner>
    ) : (
      <Banner tone="neg" action={<Portal>Update card</Portal>}>Your last payment failed, so you're on Free.</Banner>
    );
  return null;
}

function Meter({ used, limit }: { used: number; limit: number }) {
  const r = used / limit;
  return (
    <div role="meter" aria-label="Events this month" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} aria-valuetext={`${n(used)} of ${n(limit)}`} className="h-1.5 overflow-hidden rounded-full bg-line">
      <div className={`h-full rounded-full transition-[width] duration-500 ease-out ${r >= 0.8 ? 'bg-warnInk' : 'bg-accent'}`} style={{ width: `${Math.min(100, r * 100)}%` }} />
    </div>
  );
}

function Month({ usage, user }: { usage: BillingUsage; user: User }) {
  const start = Date.parse(`${usage.month}-01`);
  const [y, m] = usage.month.split('-').map(Number);
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const limit = user.admin ? null : user.events_limit ?? null;
  const today = usage.days.length;
  // The full days so far, carried to the month's end. Today is still running, and two days say nothing yet.
  const full = usage.days.slice(0, -1);
  const pace = full.length >= 3 ? Math.round((full.reduce((a, b) => a + b, 0) / full.length) * length) : null;
  const rounded = pace === null ? null : pace >= 1000 ? Math.round(pace / 100) * 100 : pace;
  const over = limit !== null && usage.total >= limit;
  const name = new Date(start).toLocaleDateString('en', { month: 'long', timeZone: 'UTC' });
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2 className="!tracking-normal text-muted">Events in {name}</h2>
          <div className="mt-1.5 tabular-nums">
            <b className="text-[34px] font-semibold leading-none tracking-[-0.02em]">{n(usage.total)}</b>
            {limit !== null && <span className="ml-1.5 text-muted">of {n(limit)}</span>}
          </div>
        </div>
        <div className={`tabular-nums ${over || (limit !== null && (rounded ?? 0) > limit) ? 'text-warnInk' : 'text-muted'}`}>
          {over && !user.paid ? `Paused until ${utcDay(Date.UTC(y, m, 1))}` : rounded !== null && usage.total > 0 ? `On pace for ${n(Math.max(rounded, usage.total))}` : null}
        </div>
      </div>
      {limit !== null && (
        <div className="mt-5">
          <Meter used={usage.total} limit={limit} />
        </div>
      )}
      <Bars days={usage.days} length={length} start={start} today={today} />
      <div className="mt-7 border-t border-rule pt-5">
        <div className="mb-2 flex justify-between gap-3">
          <h2 className="!tracking-normal text-muted">Websites</h2>
          {user.sites_limit != null && (
            <span className={`tabular-nums ${usage.sites.length > user.sites_limit ? 'text-warnInk' : 'text-muted'}`}>
              {usage.sites.length} of {user.sites_limit}
            </span>
          )}
        </div>
        <ul>
          {usage.sites.map((s) => (
            <li key={s.id} className="flex h-11 items-center gap-3">
              <Favicon domain={s.domain} size={20} />
              <span className="min-w-0 flex-1 truncate">{s.domain}</span>
              {!s.recording && (
                <span className="pill pill-warn" title="Free records one website. This one keeps its data.">
                  Paused
                </span>
              )}
              <span className="tabular-nums">{n(s.events)}</span>
            </li>
          ))}
          {usage.other > 0 && (
            <li className="flex h-11 items-center gap-3 text-muted">
              <span className="grid w-5 place-items-center">
                <Icon name="archive" />
              </span>
              <span className="flex-1">Deleted websites</span>
              <span className="tabular-nums">{n(usage.other)}</span>
            </li>
          )}
          {!usage.sites.length && !usage.other && <li className="py-2 text-muted">No websites yet.</li>}
        </ul>
      </div>
    </>
  );
}

/** The month by day. Days to come keep their place. */
function Bars({ days, length, start, today }: { days: number[]; length: number; start: number; today: number }) {
  const [at, setAt] = useState<number | null>(null);
  const top = Math.max(...days, 1);
  const busiest = days.indexOf(Math.max(...days));
  const label = (i: number) => utcDay(start + i * 86_400_000);
  const centre = (i: number) => `${((i + 0.5) / length) * 100}%`;
  return (
    <div className="mt-8">
      <div className="relative" onPointerLeave={() => setAt(null)}>
        <div className="flex h-40 items-stretch" role="img" aria-label={days.some(Boolean) ? `Events by day, ${label(0)} to ${label(today - 1)}. Busiest: ${label(busiest)}, ${n(days[busiest])}.` : 'No events this month yet.'}>
          {Array.from({ length }, (_, i) => (
            // The whole column answers the pointer, not only the bar.
            <div key={i} className="flex min-w-0 flex-1 items-end px-[1px] sm:px-0.5" onPointerEnter={() => setAt(i < today ? i : null)}>
              <div
                className={`bill-bar w-full rounded-[3px] ${i >= today || !days[i] ? 'bg-line' : at === i ? 'bg-accentInk' : i === today - 1 ? 'bg-accent/50' : 'bg-accent'}`}
                style={{ height: i >= today || !days[i] ? 3 : `${Math.max(2.5, (days[i] / top) * 100)}%`, '--i': i } as React.CSSProperties}
              />
            </div>
          ))}
        </div>
        {at !== null && (
          <div className="bill-tip" style={{ left: `clamp(56px, ${centre(at)}, calc(100% - 56px))` }} aria-hidden="true">
            {label(at)} <b className="font-semibold">{n(days[at])}</b>
          </div>
        )}
      </div>
      <div className="relative mt-2 h-4 text-xs text-faint">
        {today > 4 && <span className="absolute left-0">{label(0)}</span>}
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `clamp(16px, ${centre(today - 1)}, calc(100% - 16px))` }}>
          Today
        </span>
        {length - today > 3 && <span className="absolute right-0">{length}</span>}
      </div>
    </div>
  );
}

function PlanCard({
  user,
  price,
  limits,
  canBuy,
  celebrateOnce,
  onChanged,
  onProblem,
}: {
  user: User;
  price?: string;
  limits: { eventLimit?: number; siteLimit?: number; checkout: boolean; supportEmail: string | null } | null;
  canBuy: boolean;
  celebrateOnce: boolean;
  onChanged: () => Promise<void>;
  onProblem: (s: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [planTrigger, setPlanTrigger] = useState<SpikeTrigger | null>(null);
  const celebratedRef = useRef(false);
  useEffect(() => {
    if (celebrateOnce && !celebratedRef.current) {
      celebratedRef.current = true;
      setPlanTrigger({ kind: 'celebrate', key: 1 });
    }
  }, [celebrateOnce]);
  const { busy, set } = useRenewal(onChanged, onProblem);
  const free = !user.paid;
  const name = user.admin ? 'Owner' : free ? 'Free' : 'Pro';
  const line = user.admin
    ? 'Free, no limits'
    : free
      ? user.pro_limits_until
        ? `Pro's limits last until ${utcDay(user.pro_limits_until)}`
        : 'No card needed'
      : user.plan_status === 'cancelled'
        ? `Ends ${day(user.plan_until!)}`
        : user.plan_status === 'past_due'
          ? 'Payment failed'
          : user.renews_at
            ? user.renews_at > Date.now()
              ? `Renews ${day(user.renews_at)}`
              : 'Renewing now'
            : user.plan_until
              ? `Until ${day(user.plan_until)}`
              : '';
  return (
    <section className={`rounded-2xl p-5 ${free ? 'border border-line' : 'bg-accentSoft'}`} aria-label="Your plan">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[28px] font-semibold leading-none tracking-[-0.02em]">{name}</h2>
          <p className={`mt-2.5 ${free ? 'text-muted' : 'text-accentInk'}`}>
            {!free && !user.admin && price && (
              <>
                {price} a month
                <br />
              </>
            )}
            {line}
          </p>
        </div>
        <span className="shrink-0 text-accent">
          <SpikeCharacter size={64} mood="idle" energy={2} trigger={planTrigger} allowClickHop />
        </span>
      </div>
      {free && !fixable(user) && !user.renewing && limits && (
        <>
          <dl className="mt-5 grid gap-2 border-t border-rule pt-4 tabular-nums">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Events on Pro</dt>
              <dd>{n(limits.eventLimit ?? 50_000)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Websites on Pro</dt>
              <dd>{limits.siteLimit ?? 10}</dd>
            </div>
          </dl>
          {canBuy ? (
            <Button asChild variant="raw" size="raw" className="btn-dark mt-5 h-10 w-full">
              <a href="/api/billing/checkout" data-dm-goal="checkout_click" data-dm-goal-plan="monthly" data-dm-goal-price={price}>
                Go Pro for {price} a month
              </a>
            </Button>
          ) : (
            !limits.checkout && <p className="mt-5 text-muted">Pro isn't on sale yet.</p>
          )}
        </>
      )}
      {/* Polar's own page cancels one whose payment is being retried. */}
      {!user.admin && user.paid && user.plan_status === 'past_due' && (
        <Button asChild variant="raw" size="raw" className="btn-ghost -ml-3 mt-4 !text-accentInk hover:!bg-accent/10">
          <a href="/api/billing/portal">Cancel plan</a>
        </Button>
      )}
      {!user.admin && user.paid && user.plan_status === 'active' && user.renewing && (
        <Button variant="raw" size="raw" type="button" className="btn-ghost -ml-3 mt-4 !text-accentInk hover:!bg-accent/10" onClick={() => setAsking(true)}>
          Cancel plan
        </Button>
      )}
      <Modal open={asking} onClose={() => setAsking(false)} title="Cancel Pro?" width="max-w-sm">
        <p className="text-muted">
          {user.renews_at && user.renews_at > Date.now() ? `You keep Pro until ${day(user.renews_at)}, then move to Free.` : 'You move to Free when the time you paid for ends.'} Your data stays
          {(user.sites_used ?? 0) > 1 ? ', and your busiest website keeps recording' : ''}.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="raw" size="raw" type="button" className="btn h-9" onClick={() => setAsking(false)}>
            Keep Pro
          </Button>
          <Button
            variant="raw"
            size="raw"
            type="button"
            className="btn-danger h-9"
            disabled={busy}
            onClick={async () => {
              await set(false);
              setAsking(false);
            }}
          >
            {busy ? 'Cancelling…' : 'Cancel Pro'}
          </Button>
        </div>
      </Modal>
    </section>
  );
}

const IconLink = ({ icon, tip, href, newTab }: { icon: string; tip: string; href: string; newTab?: boolean }) => (
  <Hint text={tip}>
    <Button asChild variant="raw" size="raw" className="icon-btn">
      <a href={href} aria-label={tip} {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>
        <Icon name={icon} />
      </a>
    </Button>
  </Hint>
);

const STATUS: Record<string, string> = { pending: 'Unpaid', refunded: 'Refunded', partially_refunded: 'Part refunded', void: 'Void' };
const brandName = (s: string) => ({ visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', link: 'Link' })[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** How the account pays and what it paid. Nothing for one that never has. */
function Payments({ account, user }: { account: BillingAccount; user: User }) {
  const { method, orders } = account;
  if (!method && !orders.length) return null;
  const failed = user.plan_status === 'past_due' || user.plan_status === 'unpaid';
  const sub = failed ? 'Declined' : method?.expires ? `Expires ${method.expires}` : null;
  return (
    <>
      {method && (
        <section className="card flex items-center gap-3 p-5 max-lg:order-2" aria-label="Payment method">
          <span className="grid h-7 min-w-10 shrink-0 place-items-center rounded-md border border-line bg-raised px-1.5 text-[11px] font-semibold">{brandName(method.brand ?? method.type)}</span>
          <div className="min-w-0 flex-1">
            <div className="tabular-nums">{method.last4 ? `•••• ${method.last4}` : 'Saved payment method'}</div>
            {sub && <div className={`text-xs ${failed ? 'text-negative' : 'text-muted'}`}>{sub}</div>}
          </div>
          <IconLink icon="edit" tip="Change payment method" href="/api/billing/portal" />
        </section>
      )}
      {orders.length > 0 && (
        <section className="card px-5 pb-2 pt-4 max-lg:order-3" aria-label="Payments">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="!tracking-normal text-muted">Payments</h2>
            <span className="-mr-1">
              <IconLink icon="external" tip="Invoices and details" href="/api/billing/portal" />
            </span>
          </div>
          <ul>
            {orders.map((o) => (
              <li key={o.id} className="-mx-2 flex h-11 items-center gap-3 rounded-lg pl-2 pr-1 tabular-nums transition-colors hover:bg-raised">
                <span className="min-w-0 flex-1 truncate">{o.at ? day(o.at) : ''}</span>
                {STATUS[o.status] && <span className={`pill ${o.status === 'pending' ? 'pill-neg' : ''}`}>{STATUS[o.status]}</span>}
                <span>{fmtMoney(o.amount, o.currency)}</span>
                {o.status === 'pending' || o.status === 'void' ? <span className="w-8" /> : <IconLink icon="download" tip={`Receipt for ${o.at ? day(o.at) : 'this payment'}`} href={`/api/billing/receipts/${o.id}`} newTab />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
