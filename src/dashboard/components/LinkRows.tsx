import { memo, useMemo, type CSSProperties } from 'react';
import { fmtNumber } from '../lib/format';
import { ARCHIVED, barLength, conversionOf, count, FIRST_ROWS, GROUPS, groupTitle, isEmail, MORE_ROWS, nameOf, noSales, opens, refundNote, sourceOf, type GroupId, type SavedLink } from '../lib/links';
import { SourceIcon } from './Icons';
import { CopyLink, GroupHead, LinkActions, QrDownloads, ShowMore, UrlBox } from './LinkParts';
import { Button } from './primitives/button';
import { QrCode } from './QrCode';
import { Icon } from './ui';

export const rowId = (id: string) => `link-${id}`;
export const foldId = (g: GroupId) => `links-${g}`;

interface RowProps {
  allTime: boolean;
  money: (minor: number) => string;
  /** Money per visitor. */
  each: (minor: number) => string;
  created: (l: SavedLink) => string;
  onHot: (id: string | null) => void;
  onOpen: (id: string, byPointer: boolean) => void;
  onQr: (l: SavedLink) => void;
  onArchive: (l: SavedLink) => void;
  onRestore: (l: SavedLink) => void;
  /** The most visitors and revenue of any link: each is the length of a full bar on its side. */
  maxVisitors: number;
  maxRevenue: number;
}

interface Props extends RowProps {
  groups: Record<GroupId, SavedLink[]>;
  /** While searching every group is open. */
  searching: boolean;
  isOpen: (g: GroupId) => boolean;
  limits: Partial<Record<GroupId, number>>;
  onFold: (g: GroupId, byPointer: boolean) => void;
  onMore: (g: GroupId) => void;
  open: string | null;
  hot: string | null;
  busy: string | null;
}

/** Every link as one row with two bars, grouped by what it brought. One row can be open at a time. */
export function LinkRows({ groups, searching, isOpen, limits, onFold, onMore, open, hot, busy, ...row }: Props) {
  const { allTime, money, each, maxVisitors, maxRevenue } = row;
  // The numbers beside the bars get one width, so every bar starts at the same place.
  const widths = useMemo(() => {
    const all = GROUPS.flatMap((g) => groups[g]);
    const longest = (text: (l: SavedLink) => string) => Math.max(3, ...all.map((l) => text(l).length));
    return { '--row-v': `${longest((l) => fmtNumber(l.visitors))}ch`, '--row-r': `${longest((l) => money(l.revenue))}ch`, '--row-e': `${longest((l) => perVisitor(l, each) ?? '')}ch` } as CSSProperties;
  }, [groups, money, each]);

  return (
    <div className="link-rows" style={widths}>
      {maxVisitors > 0 && (
        <p className="pt-2 text-xs text-muted">
          {maxRevenue > 0
            ? `Each side has its own scale: a full blue bar is ${count(maxVisitors, 'visitor')}, a full amber bar is ${money(maxRevenue)}.`
            : `A full blue bar is ${count(maxVisitors, 'visitor')}.`}
        </p>
      )}
      {maxVisitors > 0 && (
        <div className="link-rows-head" aria-hidden="true">
          <span className="link-rows-axis">
            <span>
              Visitors
              <i className="link-key" data-measure="visitors" />
            </span>
            <span>
              <i className="link-key" data-measure="revenue" />
              Revenue
            </span>
          </span>
          <span className="link-rows-each">Per visitor</span>
        </div>
      )}
      {GROUPS.map((g) => {
        const links = groups[g];
        if (!links.length) return null;
        const folds = !searching && (g === 'unvisited' || g === 'archived');
        const shown = isOpen(g);
        const limit = limits[g] ?? FIRST_ROWS;
        const title = groupTitle(g, allTime);
        return (
          <section key={g} aria-labelledby={foldId(g)}>
            <GroupHead id={foldId(g)} title={title} total={links.length} open={shown} onToggle={folds ? (byPointer) => onFold(g, byPointer) : undefined} />
            {shown && g === 'archived' && <p className="pb-2 text-xs text-muted">{ARCHIVED}</p>}
            {shown && (
              <ul>
                {links.slice(0, limit).map((l) => (
                  <LinkRow key={l.id} l={l} open={open === l.id} hot={hot === l.id} busy={busy === l.id} {...row} />
                ))}
              </ul>
            )}
            {shown && links.length > limit && <ShowMore left={links.length - limit} step={MORE_ROWS} group={title} onMore={() => onMore(g)} />}
          </section>
        );
      })}
    </div>
  );
}

/** Null without visits: there is nothing to divide by. */
const perVisitor = (l: SavedLink, each: RowProps['each']) => (l.visitors > 0 ? each(l.revenue / l.visitors) : null);

const LinkRow = memo(function LinkRow({ l, open, hot, busy, ...p }: RowProps & { l: SavedLink; open: boolean; hot: boolean; busy: boolean }) {
  const id = rowId(l.id);
  const name = nameOf(l);
  const note = refundNote(l);
  const per = perVisitor(l, p.each);
  return (
    <li className="link-item" id={`${id}-item`}>
      <div
        className="link-row"
        data-hot={hot ? '' : undefined}
        data-open={open ? '' : undefined}
        onPointerEnter={(e) => e.pointerType !== 'touch' && p.onHot(l.id)}
        onPointerLeave={() => p.onHot(null)}
        onFocus={(e) => (e.target as HTMLElement).matches(':focus-visible') && p.onHot(l.id)}
        onBlur={() => p.onHot(null)}
      >
        <Button variant="raw" size="raw" type="button" id={id} className="link-row-main" aria-expanded={open} aria-controls={open ? `${id}-card` : undefined} onClick={(e) => p.onOpen(l.id, e.detail > 0)}>
          <span className="link-row-name">
            <SourceIcon source={sourceOf(l)} size={16} fallback={<Icon name={isEmail(l) ? 'mail' : 'link'} />} />
            <span className="truncate" title={name}>
              {name}
            </span>
          </span>{' '}
          <span className="link-row-v">
            {fmtNumber(l.visitors)} <span className="link-row-unit">{l.visitors === 1 ? 'visitor' : 'visitors'}</span>
          </span>{' '}
          <span className="link-row-bars" aria-hidden="true">
            <span>
              <i data-measure="visitors" style={{ '--bar': barLength(l.visitors, p.maxVisitors) } as CSSProperties} />
            </span>
            <span>
              <i data-measure="revenue" style={{ '--bar': barLength(l.revenue, p.maxRevenue) } as CSSProperties} />
            </span>
          </span>
          <span className={`link-row-r ${l.revenue > 0 ? 'font-medium' : 'text-muted'}`}>
            {p.money(l.revenue)} <span className="sr-only">revenue</span>
          </span>{' '}
          <span className="link-row-e" data-none={per === null ? '' : undefined} data-zero={l.revenue === 0 && !note ? '' : undefined}>
            {per === null ? (
              <span>
                <span aria-hidden="true">–</span>
                <span className="sr-only">no visits to divide by</span>
              </span>
            ) : (
              <span className={l.revenue > 0 ? 'link-row-each' : undefined}>
                {per} <span className="link-row-unit">per visitor</span>
              </span>
            )}
            {note && (
              <span className="link-row-note">
                <span className="link-row-comma">, </span>
                {note}
              </span>
            )}
          </span>
          <Icon name="down" className="link-chevron link-row-chevron" />
        </Button>
        <CopyLink link={l} className="link-row-copy" />
      </div>
      {open && (
        <div role="region" id={`${id}-card`} aria-labelledby={id} className="link-card">
          <LinkCard l={l} busy={busy} {...p} />
        </div>
      )}
    </li>
  );
});

function LinkCard({ l, busy, allTime, money, each, created, ...on }: Omit<RowProps, 'onHot' | 'onOpen'> & { l: SavedLink; busy: boolean }) {
  const rate = conversionOf(l);
  const unpaid = l.visitors > 0 && l.customers === 0 && l.revenue === 0;
  const paid = unpaid ? noSales(allTime) : rate !== null && l.customers > 0 && `${rate} paid`;
  const per = l.revenue !== 0 && l.visitors > 0 && `${each(l.revenue / l.visitors)} per visitor`;
  return (
    <>
      <div className="link-card-main">
        <UrlBox
          url={l.url}
          action={
            <span className="link-tools">
              <CopyLink link={l} />
              <LinkActions l={l} busy={busy} onQr={on.onQr} onArchive={on.onArchive} onRestore={on.onRestore} />
            </span>
          }
        />
        <div className="link-steps">
          <Step value={fmtNumber(l.visitors)} unit={l.visitors === 1 ? 'visitor' : 'visitors'} />
          <Arrow>{paid}</Arrow>
          <Step value={fmtNumber(l.customers)} unit={l.customers === 1 ? 'customer' : 'customers'} />
          <Arrow>{per}</Arrow>
          <Step value={money(l.revenue)} unit="revenue" />
        </div>
        {/* Narrow cards have no room for these on the arrows. */}
        {(paid || per) && <p className="link-rates text-xs tabular-nums text-muted">{[paid, per].filter(Boolean).join(' · ')}</p>}
        {l.revenue < 0 && <p className="text-xs text-muted">More was refunded than paid.</p>}
        {l.revenue === 0 && l.customers > 0 && <p className="text-xs text-muted">Payments and refunds add up to {money(0)}.</p>}
        <p className="min-w-0 break-words text-sm text-muted">
          Opens <span className="text-ink">{opens(l.destination)}</span>
          <br />
          Created {created(l)}
          {l.created_by !== 'owner' && ' by an agent'}
        </p>
      </div>
      <div className="link-card-qr">
        <div className="link-card-code">
          <QrCode value={l.url} size={132} label={`QR code that opens ${l.url}`} />
        </div>
        <QrDownloads link={l} />
      </div>
    </>
  );
}

const Step = ({ value, unit }: { value: string; unit: string }) => (
  <span className="min-w-0">
    <b className="block text-xl font-semibold leading-7 tracking-[-0.01em]">{value}</b> <span className="block text-xs text-muted">{unit}</span>
  </span>
);

const Arrow = ({ children }: { children: string | false }) => (
  <span className="link-arrow">
    {children && <span>{children}</span>}
    <svg width="28" height="8" viewBox="0 0 28 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 4h25M22.5 1 26 4l-3.5 3" />
    </svg>
  </span>
);
