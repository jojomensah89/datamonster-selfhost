import { BackButton } from '../components/BackButton';
import { Logo } from '../components/Logo';
import { usePlan } from './Landing';

// Plain-language starting points. Review them (or have a lawyer do it) before you rely on them.
const UPDATED = 'November 2026';

type Page = 'terms' | 'privacy' | 'refund';
const PAGES: { id: Page; label: string }[] = [
  { id: 'terms', label: 'Terms' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'refund', label: 'Refunds' },
];

export function Legal({ page }: { page: Page }) {
  const plan = usePlan();
  const contact = plan?.supportEmail ? (
    <a className="font-medium text-ink underline underline-offset-[3px]" href={`mailto:${plan.supportEmail}`}>
      {plan.supportEmail}
    </a>
  ) : (
    'the operator of this service'
  );

  return (
    <div className="min-h-svh bg-surface text-ink">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-6 sm:px-6">
        <a href="/" aria-label="DataMonster home">
          <Logo />
        </a>
        <BackButton />
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
        <nav aria-label="Legal pages" className="tabs mt-6">
          {PAGES.map((p) => (
            <a key={p.id} href={`/${p.id}`} aria-current={p.id === page ? 'page' : undefined} className={`tab inline-flex items-center ${p.id === page ? 'tab-active' : ''}`}>
              {p.label}
            </a>
          ))}
        </nav>

        <article className="mt-10 space-y-4 text-base leading-relaxed text-ink [&_h1]:text-4xl [&_h1]:font-semibold [&_h1]:leading-[1.05] [&_h1]:tracking-[-0.03em] sm:[&_h1]:text-5xl [&_h2]:pt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-[-0.01em] [&_p]:max-w-[65ch]">
          {page === 'terms' && (
            <>
              <h1>Terms of Service</h1>
              <p className="text-sm text-muted">Last updated {UPDATED}</p>
              <p>By using the hosted DataMonster service ("the service") you agree to these terms.</p>
              <h2>The service</h2>
              <p>
                DataMonster provides website analytics and revenue attribution. You add a tracking script to websites you own or are allowed to manage, connect a payment
                provider to see which traffic sources lead to payments, and can let AI agents read (and, with your permission, change) your analytics.
              </p>
              <h2>Your account</h2>
              <p>You sign in with Google and are responsible for activity under your account, including what agents you connect do with the access you grant them. One account per person or business.</p>
              <h2>Payment</h2>
              <p>
                The Free plan costs nothing and has the limits shown on the pricing page; when a month's events are used up, recording pauses until the next month. Pro is billed monthly through Polar, our merchant of record, at the price shown at checkout. Pro includes the monthly events shown on the pricing page plus a temporary traffic-spike buffer (up to 3× your included events) before recording pauses until the next month. It renews automatically until cancelled;
                cancelling stops future charges and keeps Pro until the end of the paid month. After that your account moves to Free: your data stays, and if you have more websites
                than Free records, the busiest one carries on and the others are paused.
              </p>
              <h2>Acceptable use</h2>
              <p>
                Only track sites you have the right to track, follow the privacy laws that apply to your visitors (including showing any cookie or consent notice they
                require), and don't use the service for spam, abuse or anything illegal. We may limit traffic that harms
                the service.
              </p>
              <h2>Availability</h2>
              <p>
                We work to keep the service running and your data safe, but it's provided "as is" without guarantees of uptime or fitness for a particular purpose. To the
                extent the law allows, our liability is limited to the amount you paid in the last 12 months.
              </p>
              <h2>Ending</h2>
              <p>You can stop using the service at any time. We may suspend accounts that break these terms.</p>
              <h2>Contact</h2>
              <p>Questions: {contact}.</p>
            </>
          )}
          {page === 'privacy' && (
            <>
              <h1>Privacy Policy</h1>
              <p className="text-sm text-muted">Last updated {UPDATED}</p>
              <p>This covers the hosted DataMonster service.</p>
              <h2>Your account</h2>
              <p>
                When you sign in with Google we receive your name, email address and profile picture. We use them to run your account and contact you about it. Payments are
                processed by Polar; we never see your full card details.
              </p>
              <h2>Your visitors</h2>
              <p>
                For websites you track, the script records pages viewed, referrers, campaign tags, button clicks you choose to track, approximate location (country, region,
                city, coordinates rounded to about 1 km), browser, operating system and device. It uses two first-party cookies (a random visitor id and a session id) and
                does not store raw IP addresses—to prevent abuse, we keep only a keyed daily hash of the sending address per account, which cannot be reversed and is deleted
                automatically after the day ends. Email addresses in page URLs are removed before sending. You decide whether to link visitors to customers (for example with
                payment metadata or identify()).
              </p>
              <p>
                For this data, you are the controller and we process it on your behalf to provide your analytics. We don't sell it or use it for advertising. AI agents only
                see it when you connect them, with the access you grant.
              </p>
              <h2>Where it's stored</h2>
              <p>Data is stored on Cloudflare's infrastructure.</p>
              <h2>How long it's kept</h2>
              <p>
                There is no automatic expiry. A website's visits, sessions, payments, goals, funnels, tracked links, notes and launches are kept until you
                delete that website. Deleting it, from its settings, removes all of that visitor and site data at once and can't be undone; only aggregate daily and monthly
                event counts remain for your account's billing meter (with no visitor or page data).
              </p>
              <h2>Contact</h2>
              <p>Privacy questions or deletion requests: {contact}.</p>
            </>
          )}
          {page === 'refund' && (
            <>
              <h1>Refund Policy</h1>
              <p className="text-sm text-muted">Last updated {UPDATED}</p>
              <p>If DataMonster Pro isn't right for you, email {contact} within 14 days of your first payment for a full refund, no questions asked.</p>
              <p>
                After that, you can cancel anytime to stop future charges; you keep access until the end of the month you've paid for. Refunds are issued through
                Polar to your original payment method.
              </p>
            </>
          )}
        </article>
      </main>

      <footer className="bg-accent text-white dark:border-t dark:border-line dark:bg-ground dark:text-muted">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm sm:px-6">
          <span>© {new Date().getFullYear()} DataMonster</span>
        </div>
      </footer>
    </div>
  );
}
