import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../components/primitives/accordion';
import { Button } from '../components/primitives/button';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { CloudflareMark } from '../components/CloudflareMark';
import { GoogleMark } from '../components/GoogleMark';
import { Spike } from '../components/Spike';
import '../landing/landing.css';
import { SIGN_IN_URL, SiteFooter, SiteNav, usePlan } from '../landing/SiteChrome';
import { useGlyphField } from '../landing/useGlyphField';
import { useLightOnly } from '../lib/theme';
import type { PlanInfo } from '../lib/api';

export { usePlan };

export function priceLabel(p: PlanInfo | null) {
  if (!p) return '';
  return `${p.price}/${p.interval}`;
}

/** Pro's price, for when the server hasn't said. */
const HOSTED_PRICE = '$5';

const stagger = (i: number) => ({ '--i': i }) as CSSProperties;

/* ---------------------------------------------------------------- content */

/** Illustrative numbers for the hero card. The card says "example" so nobody reads them as a customer's figures. */
const SOURCES: { name: string; ico: string; color: string; ink?: string; visitors: string; revenue: string; width: string; note: ReactNode }[] = [
  { name: 'Launch tweet', ico: 'X', color: '#0a1633', visitors: '2,904', revenue: '$1,240', width: '100%', note: <><b>Launch tweet</b> brought 31 buyers. Median time from first visit to payment: 2 days.</> },
  { name: 'Product Hunt', ico: 'P', color: '#da552f', visitors: '1,733', revenue: '$860', width: '69%', note: <><b>Product Hunt</b> sent 1,733 visitors. 14 paid, most on the Pro plan.</> },
  { name: 'Google', ico: 'G', color: '#ffffff', ink: '#1f54f0', visitors: '2,186', revenue: '$540', width: '44%', note: <><b>Google</b> buyers landed on /blog/self-host-analytics before paying.</> },
  { name: 'chatgpt.com', ico: 'C', color: '#10a37f', visitors: '412', revenue: '$310', width: '25%', note: <><b>chatgpt.com</b>: 9 buyers came from ChatGPT answers this month, up from 2.</> },
];

const KPIS = [
  { label: 'Visitors', value: '8,412', delta: '+21%' },
  { label: 'Revenue', value: '$3,140', delta: '+34%' },
  { label: 'Per visitor', value: '$0.37', delta: '+11%' },
];

const ASKS: { q: string; a: string; tone: string }[] = [
  { q: 'Which post made me money this month?', a: 'Your launch tweet: $1,240 from 31 buyers, 39% of revenue. Product Hunt is second with $860.', tone: 'navy' },
  { q: 'How did this week compare with last week?', a: 'Revenue was $712, up 18% on the 7 days before. Visitors stayed level at 2,140, so revenue per visitor rose from $0.28 to $0.33.', tone: 'deep' },
  { q: 'Which of my directory launches paid off?', a: 'Of 12 launches, 3 brought buyers: Product Hunt $860, Uneed $120, Microlaunch $45. The other 9 sent 214 visitors and no sales so far.', tone: 'blue' },
  { q: 'Make a tracked link for my Reddit post.', a: 'Done: yoursite.com/?ref=reddit-sideproject. Visits and sales from it will show up under that name.', tone: 'navy' },
  { q: 'I just went live on Uneed. Track it.', a: 'Added Uneed as a live launch. Its visitors and sales will show up under that launch, and the listing gets checked daily.', tone: 'deep' },
];

/** Short labels for the question list; the full question is what the chat shows. */
const ASK_LABELS = ['Which post made money?', 'How was this week?', 'Which launch paid off?', 'Tag my Reddit post', 'Record my launch'];

const FAQ: [string, ReactNode][] = [
  ['Is the free plan really free?', 'Yes: 5,000 events a month on one website, with no card. If you reach the limit, recording pauses until the 1st and nothing you have is lost.'],
  ['How do I set it up?', 'Sign in with Google, add your website and paste one script tag. Or copy the setup prompt into Claude Code, Codex or Cursor and it does the install for you.'],
  ['Can I cancel Pro?', 'Yes, any time. You keep Pro to the end of the month you paid for, then move to Free with your data. Your first payment can be refunded within 14 days.'],
  ['Which AI assistants can use it?', 'Anything that speaks MCP or calls a REST API: Claude, ChatGPT, Codex, Cursor and personal assistant bots.'],
  ['Can an agent break my data?', 'Agents get read access by default. Writing (links, notes, launches and listing checks) needs a scope you grant on a consent screen, every action is logged, and secrets and deletion are never given to an agent.'],
  ['Which visit gets the credit for a sale?', 'The last non-direct visit before payment gets credit. Add a ?ref= tag to identify the exact post.'],
  ['Does it use cookies?', 'Yes, two first-party cookies on your own domain, so a buyer who comes back days later is still recognised. Depending on where your visitors are, you may need a consent banner.'],
];

type Plan = {
  name: string; price: string; per: string; size: number; list: string[]; lead: number;
  btn: string; href: string | null; mark: 'google' | 'cloudflare' | null; note: string;
};

const isLive = (p: PlanInfo | null) => !!(p?.hosted && p?.checkout);
const count = (k: number, one: string, many: string) => `${k.toLocaleString('en-US')} ${k === 1 ? one : many}`;

const EVERYTHING = ['Revenue by source, journeys, funnels and a live globe', 'Launches and tagged links', 'MCP server and REST API for your agent', 'Stripe, Polar and Dodo Payments'];

/** Free, Pro, or your own copy. Each says only what can be done today: no button leads somewhere that isn't ready. */
export function plansFor(p: PlanInfo | null): Plan[] {
  const google = { btn: 'Continue with Google', mark: 'google' as const };
  const free = p?.free ?? { eventLimit: 5_000, siteLimit: 1 };
  const waitlist = p?.supportEmail
    ? { btn: 'Join the waitlist', mark: null, href: `mailto:${p.supportEmail}?subject=${encodeURIComponent('Add me to the DataMonster Pro waitlist')}`, note: 'Not on sale yet.' }
    : { btn: '', mark: null, href: null, note: 'Not on sale yet.' };
  return [
    {
      name: 'Free', price: '$0', per: 'a month', size: 52, lead: 2,
      list: [count(free.eventLimit, 'event a month', 'events a month'), count(free.siteLimit, 'website', 'websites'), ...EVERYTHING],
      ...(p?.hosted ? { ...google, href: SIGN_IN_URL, note: 'No card needed.' } : { btn: '', mark: null, href: null, note: 'Opening soon.' }),
    },
    {
      name: 'Pro', price: (isLive(p) && p?.price) || HOSTED_PRICE, per: 'a month', size: 88, lead: 2,
      list: [count(p?.eventLimit ?? 50_000, 'event a month', 'events a month'), `Up to ${count(p?.siteLimit ?? 10, 'website', 'websites')}`, ...EVERYTHING],
      ...(isLive(p) ? { ...google, href: `${SIGN_IN_URL}?plan=pro`, note: 'Cancel any time.' } : waitlist),
    },
    {
      name: 'Self-host', price: '$0', per: 'on your Cloudflare', size: 68, lead: 2,
      list: ['Your own copy, your own database', 'No event or website limits from us', 'The same dashboard, agents and payments', 'One owner, with a password', 'You run the updates'],
      ...(p?.deployUrl ? { btn: 'Deploy to Cloudflare', mark: 'cloudflare' as const, href: p.deployUrl, note: "Cloudflare's own limits and prices apply." } : { btn: 'Deploy to Cloudflare', mark: 'cloudflare' as const, href: null, note: 'Coming soon.' }),
    },
  ];
}

/* ---------------------------------------------------------------- behaviour */

/** Adds `.in` to each section (and loose `.rise` elements) as it scrolls into view, once. */
function useReveal(root: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.12 },
    );
    el.querySelectorAll('section, .foot').forEach((n) => io.observe(n));
    el.querySelectorAll('.rise').forEach((n) => {
      if (!n.closest('section, .plate, .foot')) io.observe(n);
    });
    const raf = requestAnimationFrame(() => el.querySelector('.plate')?.classList.add('in'));
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [root]);
}

/** Swap content behind a short blur-out, so the panel never shows two states at once. */
function useSwap<T>(initial: T, outMs: number) {
  const [shown, setShown] = useState(initial);
  const [selected, setSelected] = useState(initial);
  const [out, setOut] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const pick = (next: T) => {
    if (next === selected) return;
    setSelected(next);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.clearTimeout(timer.current);
    if (reduce) {
      setShown(next);
      return;
    }
    setOut(true);
    timer.current = window.setTimeout(() => {
      setShown(next);
      setOut(false);
    }, outMs);
  };
  return { shown, selected, out, pick };
}

/* ---------------------------------------------------------------- sections */

function Hero({ error, hosted, live }: { error: string | null; hosted: boolean; live: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState(0);
  useGlyphField(stageRef, canvasRef, mapRef);

  return (
    <header className="hero">
      <SiteNav page="landing" error={error} hosted={hosted} />
      <div className="wrap">
        <div className="plate" ref={stageRef}>
          <canvas className="glyphs" ref={canvasRef} aria-hidden="true" />
          <div className="plate-map" ref={mapRef} aria-hidden="true" />
          <div className="hero-copy">
            <h1>
              <span className="nowrap">Know which</span> <span className="nowrap">post paid you</span>
            </h1>
            <p className="hero-sub rise" style={stagger(1)}>
              Revenue analytics your AI agent can read. Ask it which post, launch or directory brought the money.
            </p>
            <div className="hero-actions rise" style={stagger(2)}>
              {live ? (
                <a className="lp-btn lp-btn--light" href={SIGN_IN_URL} data-dm-goal="signup_click" data-dm-goal-location="hero">
                  <GoogleMark size={20} />
                  Continue with Google
                </a>
              ) : (
                <a className="lp-btn lp-btn--light" href="#pricing" data-dm-goal="pricing_cta" data-dm-goal-location="hero">
                  See pricing
                </a>
              )}
              <a className="lp-btn lp-btn--ghost" href="#ask">Ask it something</a>
            </div>
          </div>

          <div className="hero-card rise" style={stagger(3)}>
            <Spike size={220} className="hero-spike" />
            <div className="panel" data-ui role="group" aria-label="Example: revenue by source, last 30 days">
              <div className="panel-head">
                <span className="panel-title">
                  Revenue by source <span className="panel-eg">Example</span>
                </span>
                <span className="panel-meta">
                  <span className="lp-live">23 online</span>
                  <span>Last 30 days</span>
                </span>
              </div>
              <div className="kpis">
                {KPIS.map((k, i) => (
                  <div key={k.label} className={`kpi${i === 1 ? ' is-on' : ''}`}>
                    <span>{k.label}</span>
                    <strong>{k.value}</strong>
                    <em>{k.delta}</em>
                  </div>
                ))}
              </div>
              <div className="rows-head" aria-hidden="true">
                <span>Source</span>
                <span>Visitors</span>
                <span>Revenue</span>
              </div>
              <div className="rows">
                {SOURCES.map((s, i) => (
                  <Button variant="raw" size="raw"
                    type="button"
                    key={s.name}
                    className="row"
                    aria-pressed={i === row}
                    onPointerEnter={(e) => e.pointerType === 'mouse' && setRow(i)}
                    onClick={() => setRow(i)}
                  >
                    <span className="fill" style={{ width: s.width }} />
                    <span className="src-ico" style={{ background: s.color, color: s.ink }} aria-hidden="true">{s.ico}</span>
                    <b>{s.name}</b>
                    <span className="n">{s.visitors}</span>
                    <span className="rev">{s.revenue}</span>
                  </Button>
                ))}
              </div>
              <p className="row-note" aria-live="polite">{SOURCES[row].note}</p>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

/** The signature move: the questions people ask it, travelling across the page. */
function Marquee() {
  const line = (
    <span className="marquee-line">
      {ASK_LABELS.map((l) => (
        <span key={l}>
          {l}
          <i className="marquee-dot" />
        </span>
      ))}
    </span>
  );
  return (
    <div className="wrap">
      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {line}
          {line}
        </div>
      </div>
    </div>
  );
}

/** One navy plate, the hero's twin: the questions on the left, the conversation as a window on the right. */
function Ask() {
  const { shown, selected, out, pick } = useSwap(0, 120);
  const s = ASKS[shown];

  return (
    <section className="sec" id="ask" aria-labelledby="ask-h">
      <div className="wrap">
        <div className="ask-plate">
          <div className="ask-list">
            <h2 id="ask-h" className="h2 rise">Ask your agent</h2>
            <p className="ask-lede rise" style={stagger(1)}>Claude, ChatGPT, Codex or Cursor answer from your own numbers.</p>
            <div role="tablist" aria-label="Questions your agent can ask" className="ask-qs rise" style={stagger(2)}>
              {ASK_LABELS.map((label, i) => (
                <Button variant="raw" size="raw"
                  key={label}
                  className="ask-q"
                  role="tab"
                  id={`ask-tab-${i}`}
                  aria-selected={i === selected}
                  aria-controls="ask-panel"
                  onClick={() => pick(i)}
                  onFocus={() => pick(i)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <div className="ask-window rise" style={stagger(2)}>
            <Spike size={200} className="ask-spike" />
            <div className="chat-card" data-ui role="tabpanel" id="ask-panel" aria-labelledby={`ask-tab-${selected}`} aria-live="polite">
              <div className="chat-bar">
                <span className="chat-dot" />
                Your agent, with DataMonster connected
              </div>
              <div className={`chat${out ? ' out' : ''}`}>
                <p className="bubble me">{s.q}</p>
                <p className="bubble it">{s.a}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Three bands of different weight: the two big proofs, three controls, and the privacy and payment facts on one strip. */
function Features() {
  return (
    <section className="sec" id="features" aria-labelledby="feat-h">
      <div className="wrap">
        <div className="feat-head">
          <h2 className="h2 rise" id="feat-h">Built for agents</h2>
          <p className="rise" style={stagger(1)}>Read access by default, every call logged, and the money traced to the post that earned it.</p>
        </div>

        <div className="feat-row feat-row--big">
          <article className="feat feat--blue rise" style={stagger(1)}>
            <div className="feat-copy">
              <h3>Every agent action, logged</h3>
              <p>See what each assistant read or changed, and revoke it in one click.</p>
            </div>
            <div className="log-card" data-ui>
              <div><span>09:12</span><span>Claude</span><code>create_link</code><span>reddit-sideproject</span></div>
              <div><span>09:12</span><span>Claude</span><code>get_breakdown</code><span>source, 30d</span></div>
              <div><span>Mon 08:00</span><span>Claude</span><code>verify_placement</code><span>Product Hunt</span></div>
              <div><span>Sun 22:40</span><span>Codex</span><code>add_annotation</code><span>Raised prices</span></div>
              <div><span>Sun 22:39</span><span>Codex</span><code>get_overview</code><span>7d</span></div>
            </div>
          </article>
          <article className="feat feat--navy feat--fig rise" style={stagger(2)}>
            <p className="fig" data-ui>$860</p>
            <div className="feat-copy">
              <h3>Revenue per directory</h3>
              <p>Product Hunt paid. Nine others sent visitors and no sales.</p>
            </div>
          </article>
        </div>

        <div className="feat-row feat-row--three">
          <article className="feat feat--sky rise" style={stagger(1)}>
            <div className="chip" data-ui>write <span className="toggle" /></div>
            <div className="feat-copy">
              <h3>Scoped tokens</h3>
              <p>Read by default. Writing needs your click.</p>
            </div>
          </article>
          <article className="feat feat--light rise" style={stagger(2)}>
            <div className="chip chip--status" data-ui>Matched: return page</div>
            <div className="feat-copy">
              <h3>Honest matching</h3>
              <p>Every payment says how it was linked to a visitor.</p>
            </div>
          </article>
          <article className="feat feat--ink rise" style={stagger(3)}>
            <div className="tg-card" data-ui>
              <b>Timeline note · Nov 12</b>Raised prices to $29/mo — conversion held steady.
            </div>
            <div className="feat-copy">
              <h3>Timeline notes</h3>
              <p>Mark launches and price changes right on the chart.</p>
            </div>
          </article>
        </div>

        <div className="own-strip rise">
          <Spike size={120} className="own-spike" />
          <div>
            <h3>No IP addresses kept</h3>
            <p>Location is rounded to about 1 km.</p>
          </div>
          <div>
            <h3>Never sold</h3>
            <p>Your numbers are not sold or used for advertising.</p>
          </div>
          <div>
            <h3>Stripe, Polar, Dodo</h3>
            <p>Or send payments from your own backend.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Three plans on one cobalt field, like the hero. Spike grows with the plan. */
function Pricing({ plan }: { plan: PlanInfo | null }) {
  return (
    <section className="sec" id="pricing" aria-labelledby="price-h">
      <div className="wrap">
        <div className="price-plate">
          <div className="price-head">
            <h2 id="price-h" className="h2 rise">Pricing</h2>
            <p className="rise" style={stagger(1)}>Start free. Grow for {(isLive(plan) && plan?.price) || HOSTED_PRICE} a month, or run your own copy.</p>
          </div>
          <div className="plan-grid">
            {plansFor(plan).map((pl, i) => (
              <article key={pl.name} className="plan-card rise" style={stagger(i + 2)} aria-labelledby={`plan-${i}`}>
                <h3 id={`plan-${i}`}>{pl.name}</h3>
                <div className="plan-top">
                  <p className="plan-price">
                    <strong>{pl.price}</strong> <span>{pl.per}</span>
                  </p>
                  <Spike size={pl.size} className="plan-spike" />
                </div>
                <ul className="plan-list">
                  {pl.list.map((t, k) => (
                    <li key={t} className={k < pl.lead ? 'lead' : undefined}>{t}</li>
                  ))}
                </ul>
                <div className="plan-action">
                  {pl.btn && !pl.href && (
                    <span className="lp-btn lp-btn--big lp-btn--soon" aria-disabled="true">
                      {pl.mark && <span className="g-chip"><CloudflareMark /></span>}
                      {pl.btn}
                    </span>
                  )}
                  {pl.href && (
                    <a className="lp-btn lp-btn--big" href={pl.href} data-dm-goal="pricing_cta" data-dm-goal-location={pl.name.toLowerCase()} {...(pl.mark === 'cloudflare' ? { target: '_blank', rel: 'noreferrer' } : {})}>
                      {pl.mark && <span className="g-chip">{pl.mark === 'google' ? <GoogleMark size={20} /> : <CloudflareMark />}</span>}
                      {pl.btn}
                    </a>
                  )}
                  <p className="plan-note">{pl.note}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section className="sec" id="faq" aria-labelledby="faq-h">
      <div className="wrap faq">
        <div className="faq-side">
          <h2 id="faq-h" className="h2 rise">Questions</h2>
          <Spike size={160} className="faq-spike" />
        </div>
        <Accordion type="single" collapsible defaultValue={FAQ[0][0]} className="qs rise" style={stagger(1)}>
          {FAQ.map(([q, a]) => (
            <AccordionItem className="faq-item border-0" key={q} value={q}>
              <AccordionTrigger className="faq-trigger [&>svg]:hidden hover:no-underline">
                {q}
                <span className="plus" aria-hidden="true" />
              </AccordionTrigger>
              <AccordionContent className="pb-0">
                <p className="a">{a}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- page */

export function Landing() {
  const plan = usePlan();
  const error = new URLSearchParams(window.location.search).get('login_error');
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  // The brand page stays light whatever the dashboard theme.
  useLightOnly();

  return (
    <div className="lp" ref={root}>
      <Hero error={error} hosted={!!plan?.hosted} live={isLive(plan)} />
      <main>
        <Marquee />
        <Ask />
        <Features />
        <Pricing plan={plan} />
        <Faq />
      </main>
      <SiteFooter page="landing" hosted={!!plan?.hosted} supportEmail={plan?.supportEmail ?? null} />
    </div>
  );
}
