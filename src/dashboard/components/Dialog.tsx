import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

// shadcn Dialog composition retaining the existing sheet and fullscreen API.
type Entry = { covered: (covered: boolean) => void };
const stack: Entry[] = [];
const notify = () => stack.forEach((entry, i) => entry.covered(i < stack.length - 1));
export const isDialogOpen = () => stack.length > 0;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** id of the visible title. */
  labelledBy?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  /** Classes for the element with role="dialog". */
  className?: string;
  /** Classes for the full-screen layer behind the panel (the scrim). Clicking it closes the dialog. */
  backdropClassName?: string;
  /** Whether a click on the backdrop closes the dialog (default true when there is a backdrop). */
  closeOnBackdrop?: boolean;
  /** Return false to let Escape through (the live map while fullscreen: the browser exits fullscreen first). */
  canEscape?: () => boolean;
  /** Called with true when another dialog opens over this one, false when it is on top again. */
  onCoveredChange?: (covered: boolean) => void;
  /** Extra attributes for the dialog element, e.g. data-theme. */
  dialogProps?: React.HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
  style?: React.CSSProperties;
}


export function Dialog({ open, ...props }: DialogProps) {
  return open ? <OpenDialog open {...props} /> : null;
}
function OpenDialog({ onClose, children, labelledBy, label, className = '', backdropClassName, closeOnBackdrop = true, canEscape, onCoveredChange, dialogProps, style }: DialogProps) {
  const returnTo = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const covered = useRef(onCoveredChange);
  covered.current = onCoveredChange;
  useLayoutEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    const entry: Entry = { covered: value => covered.current?.(value) };
    stack.push(entry); notify();
    return () => { stack.splice(stack.indexOf(entry), 1); notify(); };
  }, []);
  const panel = <DialogPrimitive.Content
    {...dialogProps}
    ref={content}
    aria-labelledby={labelledBy}
    aria-label={labelledBy ? undefined : label}
    aria-describedby={undefined}
    className={`outline-none ${className}`}
    style={style}
    onEscapeKeyDown={e => { if (canEscape && !canEscape()) e.preventDefault(); }}
    onInteractOutside={e => { if (!backdropClassName || !closeOnBackdrop) e.preventDefault(); }}
    onOpenAutoFocus={e => {
      const target = content.current?.querySelector<HTMLElement>('[data-autofocus]');
      if (target) { e.preventDefault(); target.focus({ preventScroll: true }); }
    }}
    onCloseAutoFocus={e => { e.preventDefault(); if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true }); }}
  >
    <DialogPrimitive.Title className="sr-only">{label ?? 'Dialog'}</DialogPrimitive.Title>
    {children}
  </DialogPrimitive.Content>;
  return <DialogPrimitive.Root open onOpenChange={value => { if (!value) onClose(); }}>
    <DialogPrimitive.Portal>
      {backdropClassName ? <DialogPrimitive.Overlay className={backdropClassName}>{panel}</DialogPrimitive.Overlay> : panel}
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/** True while prefers-reduced-motion is set; follows changes. */
export function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}
