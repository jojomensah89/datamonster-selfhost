import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CopyLabel } from './CopyLabel';
import { CopyButton } from './ui';

/** A tooltip appears after this long. One that follows another within WARM ms appears at once. */
const DELAY = 300;
const WARM = 300;
/** Least distance from the window's edge. */
const EDGE = 8;
let lastHidden = -Infinity;

/** A button's tooltip, for a pointer that can hover and for keyboard focus. The button itself carries the accessible name. */
export function Hint({ text, children }: { text: string; children: ReactNode }) {
  const [shown, setShown] = useState<'fade' | 'instant' | null>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  // Centred over the button, but never past the window's edge.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!el) return;
    const box = el.parentElement!.getBoundingClientRect();
    const half = el.offsetWidth / 2;
    const middle = box.left + box.width / 2;
    const room = document.documentElement.clientWidth - EDGE;
    el.style.setProperty('--shift', `${Math.max(EDGE + half, Math.min(room - half, middle)) - middle}px`);
  }, [shown, text]);

  const show = (how: 'hover' | 'focus') => {
    clearTimeout(timer.current);
    if (how === 'focus' || performance.now() - lastHidden < WARM) setShown('instant');
    else timer.current = setTimeout(() => setShown('fade'), DELAY);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (shown) lastHidden = performance.now();
    setShown(null);
  };
  return (
    <span
      className="link-hint"
      onPointerEnter={(e) => e.pointerType !== 'touch' && show('hover')}
      onPointerLeave={hide}
      onFocus={(e) => e.target.matches(':focus-visible') && show('focus')}
      onBlur={hide}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      {children}
      {shown && (
        <span ref={tip} className="link-hint-tip" data-instant={shown === 'instant' ? '' : undefined} aria-hidden="true">
          {text}
        </span>
      )}
    </span>
  );
}

/** Copies text. The icon turns into a check, and screen readers hear that it was copied. `what` finishes "Copy …". */
export function CopyIcon({ text, what, tip = 'Copy', className = '', onCopied }: { text: string; what: string; tip?: string; className?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Hint text={copied ? 'Copied' : tip}>
      <CopyButton
        text={text}
        className={`icon-btn ${className}`}
        label={<CopyLabel icon="copy" text={`Copy ${what}`} />}
        copiedLabel={<span className="copy-done"><CopyLabel icon="check" text={`Copied ${what}`} /></span>}
        onCopied={() => {
          setCopied(true);
          onCopied?.();
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }}
      />
      <span className="sr-only" aria-live="polite">
        {copied && 'Copied'}
      </span>
    </Hint>
  );
}

/** One line to copy: a name over the value, its copy icon at the end. */
export function CopyRow({ label, value, shown = value, what, mono = true, onCopied, children }: { label?: string; value: string; shown?: string; what: string; mono?: boolean; onCopied?: () => void; children?: ReactNode }) {
  return (
    <div className="min-w-0">
      {label && <div className="label">{label}</div>}
      <div className="flex h-9 items-center rounded-full border border-control bg-surface pl-3.5 pr-0.5">
        <span className={`min-w-0 flex-1 select-all truncate ${mono ? 'font-mono text-[13px]' : 'text-muted'}`}>{shown}</span>
        {children}
        <CopyIcon text={value} what={what} onCopied={onCopied} />
      </div>
    </div>
  );
}
