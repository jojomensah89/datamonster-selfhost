import { Button } from './primitives/button';
import { useId, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Icon } from './ui';

/** A centred sheet over a scrim, built on the shared Dialog (focus in, trapped, Escape, focus back). */
export function Modal({
  open,
  onClose,
  children,
  width = 'max-w-2xl',
  title,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  title?: ReactNode;
  /** Accessible name when there is no visible title. */
  label?: string;
}) {
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={title ? titleId : undefined}
      label={label ?? 'Dialog'}
      backdropClassName="anim-fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--scrim)] p-4 sm:p-10"
      className={`anim-sheet w-full ${width} rounded-2xl border border-line bg-surface shadow-float`}
    >
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-line py-3 pl-6 pr-3">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <Button variant="raw" size="raw" type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </Button>
        </div>
      )}
      <div className="p-6">{children}</div>
    </Dialog>
  );
}
