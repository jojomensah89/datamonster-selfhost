import type { ReactNode } from 'react';
import { count, fmtShare, nameOf, opens, pageOf, type SavedLink } from '../lib/links';
import { fmtNumber } from '../lib/format';
import { Capsule } from './Capsule';
import { CopyLink, LinkActions } from './LinkParts';

interface Props {
  rows: SavedLink[];
  /** What the rows together earned, so each bar is a share of the links shown. */
  positive: number;
  money: (minor: number) => string;
  created: (l: SavedLink) => string;
  busy: string | null;
  onQr: (l: SavedLink) => void;
  onArchive: (l: SavedLink) => void;
  onRestore: (l: SavedLink) => void;
}

/** Links as a table, stacked on phones and tablets. */
export function LinkTable({ rows, positive, money, created, busy, ...on }: Props) {
  const actions = (l: SavedLink) => (
    <>
      <CopyLink link={l} />
      <LinkActions l={l} busy={busy === l.id} {...on} />
    </>
  );
  const share = (l: SavedLink) => {
    if (positive <= 0) return null;
    const ratio = Math.max(0, l.revenue) / positive;
    return <Capsule metric="revenue" ratio={ratio} caption={`${fmtShare(ratio)} of revenue from the links shown`} />;
  };
  const by = (l: SavedLink) => (l.created_by === 'owner' ? '' : 'by an agent');
  /** The stacked rows show the whole URL, so the ref is not repeated there. */
  const heading = (l: SavedLink, withRef: boolean): ReactNode => (
    <span className="flex min-w-0 items-baseline gap-2">
      <b className="min-w-0 truncate font-medium" title={nameOf(l)}>
        {nameOf(l)}
      </b>
      {withRef && l.label && l.label !== l.ref && (
        <span className="min-w-0 shrink-[4] truncate text-xs text-muted" title={l.ref}>
          {l.ref}
        </span>
      )}
      {l.archived_at && <span className="pill flex-none">Archived</span>}
    </span>
  );

  return (
    <>
      {/* Desktop: a table. */}
      <table className="data-table hidden table-fixed xl:table">
        <thead>
          <tr>
            <th>Link</th>
            <th className="w-[15%]">Page</th>
            <th className="n w-[80px]">Visitors</th>
            <th className="n w-[92px]">Customers</th>
            <th className="n w-[100px]">Revenue</th>
            <th className="w-[116px]">Created</th>
            <th className="link-actions-col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id} className={l.archived_at ? 'text-muted' : ''}>
              <td>
                {heading(l, true)}
                {share(l)}
                <span className="mt-1 block truncate font-mono text-xs text-muted" title={l.url}>
                  {l.url}
                </span>
              </td>
              <td className="truncate text-muted" title={pageOf(l.destination)}>
                {pageOf(l.destination) === '/' ? 'Homepage' : pageOf(l.destination)}
              </td>
              <td className="n tabular-nums">{fmtNumber(l.visitors)}</td>
              <td className="n tabular-nums">{fmtNumber(l.customers)}</td>
              <td className={`n tabular-nums ${l.revenue ? 'font-medium' : 'text-muted'}`}>{money(l.revenue)}</td>
              <td className="whitespace-nowrap text-muted">
                {created(l)}
                {by(l) && <span className="block text-xs">{by(l)}</span>}
              </td>
              <td>
                <div className="link-tools justify-end">{actions(l)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phone and tablet: stacked rows. */}
      <ul className="xl:hidden">
        {rows.map((l, i) => (
          <li key={l.id} className={`py-3 ${i ? 'border-t border-rule' : ''} ${l.archived_at ? 'text-muted' : ''}`}>
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1">{heading(l, false)}</span>
              <span className={`flex-none text-right tabular-nums ${l.revenue ? 'font-medium' : 'text-muted'}`}>{money(l.revenue)}</span>
            </div>
            {share(l)}
            <p className="mt-1 text-xs tabular-nums text-muted">
              {count(l.visitors, 'visitor')} · {count(l.customers, 'customer')}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-muted">{l.url}</p>
            <p className="mt-1 truncate text-xs text-muted" title={pageOf(l.destination)}>
              {created(l)}
              {by(l) && ` ${by(l)}`} · opens {opens(l.destination)}
            </p>
            <div className="link-tools -ml-3 mt-1">{actions(l)}</div>
          </li>
        ))}
      </ul>
    </>
  );
}
