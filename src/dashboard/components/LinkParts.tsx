import { useState, type ReactNode } from 'react';
import { nameOf, type SavedLink } from '../lib/links';
import { Button } from './primitives/button';
import { downloadQr, QrCode } from './QrCode';
import { CopyIcon, Hint } from './CopyIcon';
import { Icon } from './ui';

/** Full-size touch targets until the sidebar is docked, then the app's usual control height. */
export const TAP = 'h-11 frame:h-8';

/** An action as an icon, named for screen readers and in its tooltip. */
export function IconAction({ icon, name, tip, disabled, onClick }: { icon: string; name: string; tip: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Hint text={tip}>
      <Button variant="raw" size="raw" type="button" className="icon-btn link-tool" aria-label={name} disabled={disabled} onClick={onClick}>
        <Icon name={icon} />
      </Button>
    </Hint>
  );
}

/** Copies a link. */
export const CopyLink = ({ link, className = '' }: { link: SavedLink; className?: string }) => (
  <CopyIcon text={link.url} what={`link for ${nameOf(link)}`} tip="Copy link" className={`link-tool ${className}`} />
);

/** A URL that wraps instead of hiding its end, where the link tag is. */
export function UrlBox({ url, action }: { url: string; action?: ReactNode }) {
  return (
    <div className="well flex min-h-12 items-center gap-2 px-4 py-1">
      <code className="min-w-0 flex-1 break-all py-1 font-mono text-[13px] leading-5">{url}</code>
      {action && <span className="-mr-2">{action}</span>}
    </div>
  );
}

/** The two downloads of a link's QR code, and why when one fails. */
export function QrDownloads({ link }: { link: SavedLink }) {
  const [err, setErr] = useState<string | null>(null);
  const download = (format: 'svg' | 'png') => {
    setErr(null);
    downloadQr(link.url, `${link.ref}-qr`, format).catch((e: Error) => setErr(e.message));
  };
  return (
    <>
      <div className="flex justify-center gap-2">
        {(['svg', 'png'] as const).map((f) => (
          <Hint key={f} text={`Download ${f.toUpperCase()}`}>
            <Button variant="raw" size="raw" type="button" className="btn link-download" onClick={() => download(f)}>
              <Icon name="download" />
              <span>
                <span className="sr-only">Download the QR code for {nameOf(link)} as</span> {f.toUpperCase()}
              </span>
            </Button>
          </Hint>
        ))}
      </div>
      {err && (
        <p className="text-sm text-negative" role="alert">
          {err}
        </p>
      )}
    </>
  );
}

/** The link's QR code, its URL and the two downloads. */
export function QrPanel({ link }: { link: SavedLink }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="max-w-full overflow-hidden rounded-xl border border-line bg-white p-1">
          <QrCode value={link.url} size={208} label={`QR code that opens ${link.url}`} />
        </div>
      </div>
      <UrlBox url={link.url} action={<CopyLink link={link} />} />
      <QrDownloads link={link} />
    </div>
  );
}

/** What can be done with a link besides copying it. */
export function LinkActions({ l, busy, onQr, onArchive, onRestore }: { l: SavedLink; busy: boolean; onQr: (l: SavedLink) => void; onArchive: (l: SavedLink) => void; onRestore: (l: SavedLink) => void }) {
  const name = nameOf(l);
  return (
    <>
      <span className="link-qr-action">
        <IconAction icon="qr" name={`QR code for ${name}`} tip="QR code" onClick={() => onQr(l)} />
      </span>
      {l.archived_at ? (
        <IconAction icon="restore" name={`Restore ${name}`} tip="Restore to your list" disabled={busy} onClick={() => onRestore(l)} />
      ) : (
        <IconAction icon="archive" name={`Archive ${name}`} tip="Archive. The link keeps working" disabled={busy} onClick={() => onArchive(l)} />
      )}
    </>
  );
}

/** A group's heading. With onToggle it folds the group. */
export function GroupHead({ id, title, total, open, onToggle }: { id: string; title: string; total: number; open?: boolean; onToggle?: (byPointer: boolean) => void }) {
  const text = (
    <>
      {title} <span className="text-xs font-normal tabular-nums text-muted">{total}</span>
    </>
  );
  if (!onToggle) {
    return (
      <h2 id={id} className="flex min-h-11 items-center gap-2 pt-2 text-sm font-semibold">
        {text}
      </h2>
    );
  }
  return (
    <h2 className="pt-2 text-sm font-semibold">
      <Button id={id} variant="raw" size="raw" type="button" aria-expanded={open} onClick={(e) => onToggle(e.detail > 0)} className="link-fold -ml-2 flex min-h-11 items-center gap-2 rounded-lg px-2">
        {text}
        <Icon name="down" className="link-chevron" />
      </Button>
    </h2>
  );
}

/** Reveals the next rows of a long list. */
export function ShowMore({ left, step, group, onMore }: { left: number; step: number; group: string; onMore: () => void }) {
  return (
    <Button variant="raw" size="raw" type="button" className={`btn-ghost -ml-3 my-1 ${TAP}`} onClick={onMore}>
      Show {Math.min(step, left)} more
      {left > step && <span className="font-normal">of {left}</span>}
      <span className="sr-only">in {group}</span>
    </Button>
  );
}
