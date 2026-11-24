import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type SVGProps } from 'react';
import { fmtNumber } from '../lib/format';
import { flowItems, NARROW_LABEL, narrowLayout, nodePath, ribbonPath, wideLayout, type FlowBand, type FlowItem } from '../lib/linkFlow';
import { count, fmtShare, type SavedLink } from '../lib/links';
import { Button } from './primitives/button';

/** Below this width the text goes above each ribbon instead of beside it. */
const WIDE = 600;
const NODE = 4;
/** A tooltip that follows another within this many ms appears at once. */
const WARM = 300;
/** Height of the two headings above the ribbons. */
const HEAD = 24;

interface Props {
  links: SavedLink[];
  /** The link under the pointer or focus, here or in the list. */
  hot: string | null;
  /** The link whose row is open. */
  kept: string | null;
  onHot: (id: string | null) => void;
  onPick: (id: string, byPointer: boolean) => void;
  money: (minor: number) => string;
  /** Money per visitor. */
  each: (minor: number) => string;
}

/** Where visitors and revenue come from, one ribbon per link. Nothing when there is nothing to compare. */
export const LinkFlow = memo(function LinkFlow({ links, ...rest }: Props) {
  const items = useMemo(() => flowItems(links), [links]);
  return items.length ? <Flow items={items} {...rest} /> : null;
});

const perVisitor = (i: FlowItem, each: Props['each']) => (i.visitors > 0 ? each(i.revenue / i.visitors) : null);

const Head = () => (
  <div className="link-flow-head text-xs text-muted" aria-hidden="true">
    <span>
      <i className="link-key" data-measure="visitors" />
      Visitors
    </span>
    <span>
      <i className="link-key" data-measure="revenue" />
      Revenue
    </span>
  </div>
);

/** The ribbons themselves. */
function Art({ bands, height, lit, kept, on }: { bands: FlowBand[]; height: number; lit?: string | null; kept?: string | null; on?: (i: FlowItem) => SVGProps<SVGGElement> }) {
  const gradient = `flow${useId().replace(/\W/g, '')}`;
  return (
    <svg className="link-flow-art" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" height={height} aria-hidden="true">
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
          <stop stopColor="var(--chart-visitors)" />
          <stop offset="1" stopColor="var(--chart-revenue)" />
        </linearGradient>
        {/* An end of nothing: the edges fade as they meet, so no line is left where there is no value. */}
        <linearGradient id={`${gradient}l`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
          <stop stopColor="var(--chart-visitors)" stopOpacity="0" />
          <stop offset="0.4" stopColor="color-mix(in srgb, var(--chart-visitors) 60%, var(--chart-revenue))" />
          <stop offset="1" stopColor="var(--chart-revenue)" />
        </linearGradient>
        <linearGradient id={`${gradient}r`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
          <stop stopColor="var(--chart-visitors)" />
          <stop offset="0.6" stopColor="color-mix(in srgb, var(--chart-visitors) 40%, var(--chart-revenue))" />
          <stop offset="1" stopColor="var(--chart-revenue)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {bands.map((b) => (
        <g
          key={b.item.id}
          className="link-ribbon"
          data-link={b.item.id}
          data-other={b.item.link ? undefined : ''}
          data-lit={lit === b.item.id ? '' : undefined}
          data-kept={kept === b.item.id ? '' : undefined}
          {...on?.(b.item)}
        >
          <path className="link-ribbon-hit" d={ribbonPath(b)} />
          <path className="link-ribbon-fill" d={ribbonPath(b)} fill={`url(#${gradient})`} />
          <path className="link-ribbon-edge" d={ribbonPath(b)} stroke={`url(#${gradient}${b.right.size === 0 ? 'r' : b.left.size === 0 ? 'l' : ''})`} />
          {b.left.size > 0 && <path className="link-ribbon-node" d={nodePath(0, b.left, NODE / 2)} stroke="var(--chart-visitors)" strokeWidth={NODE} strokeLinecap={b.left.size > NODE ? 'round' : 'butt'} />}
          {b.right.size > 0 && <path className="link-ribbon-node" d={nodePath(100, b.right, NODE / 2)} stroke="var(--chart-revenue)" strokeWidth={NODE} strokeLinecap={b.right.size > NODE ? 'round' : 'butt'} />}
        </g>
      ))}
    </svg>
  );
}

/** Made-up shares for the page without links: a newsletter with few visitors and most of the revenue. */
const SAMPLE: FlowItem[] = (
  [
    ['Newsletter', 0.16, 0.58],
    ['Launch post', 0.56, 0.3],
    ['Forum reply', 0.28, 0.12],
  ] as const
).map(([name, visitorShare, revenueShare]) => ({ id: name, name, link: null, visitors: 0, customers: 0, revenue: 0, visitorShare, revenueShare }));
const SAMPLE_LAYOUT = wideLayout(SAMPLE);

/** What the flow will look like, before there is a link. */
export function FlowSample() {
  const { height, bands } = SAMPLE_LAYOUT;
  return (
    <figure className="link-sample">
      <figcaption className="sr-only">Example chart. Each link is a ribbon, from its share of visitors on the left to its share of revenue on the right.</figcaption>
      <div aria-hidden="true">
        <p className="pill mb-4">Example</p>
        <div className="link-flow">
          <Head />
          <div className="relative" style={{ height }}>
            <Art bands={bands} height={height} />
            {bands.map((b) => (
              <span key={b.item.id} className="link-flow-label text-sm leading-5 text-muted" style={{ transform: `translateY(${b.left.slotTop}px)`, height: b.left.slot }}>
                {b.item.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

function Flow({ items, hot, kept, onHot, onPick, money, each }: Omit<Props, 'links'> & { items: FlowItem[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  /** When a tooltip was last put away: moving on to another ribbon shows the next one at once. */
  const hidden = useRef(-Infinity);
  const hideTip = () => {
    if (tip) hidden.current = performance.now();
    setTip(null);
  };

  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < WIDE);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const { height, bands } = useMemo(() => (narrow ? narrowLayout(items) : wideLayout(items)), [items, narrow]);
  // A row whose link is inside "Other" can be hot or open too; then nothing is marked.
  const drawn = (id: string | null) => (items.some((i) => i.id === id) ? id : null);
  const lit = drawn(hot);
  const marked = drawn(kept);
  const widest = (text: (i: FlowItem) => string) => `${Math.max(...items.map((i) => text(i).length)) + 1}ch`;
  const widths = { '--flow-v': widest((i) => fmtNumber(i.visitors)), '--flow-r': widest((i) => money(i.revenue)) } as CSSProperties;

  // A finger has no hover: a tap opens the link instead.
  const pointer = (i: FlowItem) => ({
    onPointerEnter: (e: PointerEvent) => e.pointerType !== 'touch' && onHot(i.id),
    onPointerMove: (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const r = box.current!.getBoundingClientRect();
      setTip({ id: i.id, x: e.clientX - r.left, y: e.clientY - r.top });
    },
    onPointerLeave: () => {
      onHot(null);
      hideTip();
    },
  });
  const pick = (i: FlowItem) =>
    i.link
      ? {
          onClick: (e: MouseEvent) => {
            hideTip();
            onPick(i.id, e.detail > 0);
          },
        }
      : {};
  const describe = (i: FlowItem) => {
    const per = perVisitor(i, each);
    return (
      `${i.name}: ${count(i.visitors, 'visitor')}, ${fmtShare(i.visitorShare)} of visitors. ${count(i.customers, 'customer')}. ` +
      `${money(i.revenue)} revenue${i.revenue > 0 ? `, ${fmtShare(i.revenueShare)} of revenue` : ''}${per === null ? '' : `, ${per} per visitor`}.`
    );
  };
  const tipped = tip && items.find((i) => i.id === tip.id);

  return (
    <section className="card mb-4 p-4 sm:px-5" aria-label="Share of visitors and revenue per link">
      <p className="mb-3 text-xs text-muted">Left: share of visitors. Right: share of revenue. Wider on the right means it earns more than its share.</p>
      <div ref={box} className="link-flow" data-narrow={narrow || undefined} data-lit={lit ? '' : undefined} data-kept={marked ? '' : undefined} style={widths}>
        <Head />
        {/* Keyed, so switching layouts does not ease one into the other. */}
        <div key={narrow ? 'narrow' : 'wide'} className="relative" style={{ height }}>
          <Art bands={bands} height={height} lit={lit} kept={marked} on={(i) => ({ ...pointer(i), ...pick(i) })} />
          <ul>
            {bands.map((b) => {
              const i = b.item;
              const revenue = <span className={`whitespace-nowrap text-sm leading-5 tabular-nums ${i.revenue > 0 ? 'font-medium' : 'text-muted'}`}>{money(i.revenue)}</span>;
              const label = (
                <>
                  <span className={`link-flow-name min-w-0 truncate text-sm leading-5 ${i.link ? 'font-medium' : 'text-muted'}`}>{i.name}</span>
                  <span className="link-flow-count tabular-nums text-muted">{narrow ? count(i.visitors, 'visitor') : fmtNumber(i.visitors)}</span>
                  {narrow && <span className="ml-auto flex-none">{revenue}</span>}
                </>
              );
              const place = { transform: `translateY(${b.left.slotTop}px)`, height: b.left.slot, '--label-h': `${NARROW_LABEL}px` } as CSSProperties;
              return (
                <li key={i.id} data-lit={lit === i.id ? '' : undefined} data-kept={marked === i.id ? '' : undefined} className="link-flow-item">
                  {i.link ? (
                    <Button
                      variant="raw"
                      size="raw"
                      type="button"
                      className="link-flow-label"
                      style={place}
                      aria-label={`${describe(i)} Show details`}
                      onFocus={(e) => {
                        if (!e.currentTarget.matches(':focus-visible')) return;
                        onHot(i.id);
                        setTip({ id: i.id, x: narrow ? 0 : e.currentTarget.offsetWidth, y: HEAD + b.left.slotTop + b.left.slot / 2 });
                      }}
                      onBlur={() => {
                        onHot(null);
                        hideTip();
                      }}
                      {...pointer(i)}
                      {...pick(i)}
                    >
                      {label}
                    </Button>
                  ) : (
                    <div className="link-flow-label" style={place} {...pointer(i)}>
                      <span className="sr-only">{describe(i)}</span>
                      <span aria-hidden="true" className="contents">
                        {label}
                      </span>
                    </div>
                  )}
                  {!narrow && (
                    <div className="link-flow-revenue" aria-hidden="true" style={{ transform: `translateY(${b.right.slotTop}px)`, height: b.right.slot }}>
                      {revenue}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        {tip && tipped && <Tip x={tip.x} y={tip.y} instant={performance.now() - hidden.current < WARM} item={tipped} money={money} each={each} />}
      </div>
    </section>
  );
}

function Tip({ x, y, instant, item, money, each }: { x: number; y: number; instant: boolean; item: FlowItem } & Pick<Props, 'money' | 'each'>) {
  const el = useRef<HTMLDivElement>(null);
  // As it was when it appeared: it stays while the pointer moves.
  const [atOnce] = useState(instant);
  const [pos, setPos] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' });
  useLayoutEffect(() => {
    const t = el.current!;
    const room = t.parentElement!.clientWidth - t.offsetWidth;
    const above = y - t.offsetHeight - 12;
    setPos({ left: Math.max(0, Math.min(room, x + 16)), top: above < -60 ? y + 20 : above });
  }, [x, y]);
  const per = perVisitor(item, each);
  return (
    <div ref={el} className="v3-tooltip link-tip pointer-events-none absolute z-20" data-instant={atOnce ? '' : undefined} style={pos} aria-hidden="true">
      <b className="break-words">{item.name}</b>
      <dl className="v3-tooltip-rows">
        <div>
          <dt>
            <i style={{ background: 'var(--chart-visitors)' }} />
            Visitors
          </dt>
          <dd>
            {fmtNumber(item.visitors)} <span className="font-normal opacity-75">({fmtShare(item.visitorShare)})</span>
          </dd>
        </div>
        <div>
          <dt>
            <i />
            Customers
          </dt>
          <dd>{fmtNumber(item.customers)}</dd>
        </div>
        <div>
          <dt>
            <i style={{ background: 'var(--chart-revenue)' }} />
            Revenue
          </dt>
          <dd>
            {money(item.revenue)} {item.revenue > 0 && <span className="font-normal opacity-75">({fmtShare(item.revenueShare)})</span>}
          </dd>
        </div>
        {per !== null && (
          <div>
            <dt>
              <i />
              Per visitor
            </dt>
            <dd>{per}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
