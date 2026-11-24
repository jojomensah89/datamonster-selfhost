import { Button } from './primitives/button';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { navigate } from '../App';

/** An in-app link: a real <a> (so middle-click and copy-link work) that routes without a reload. */
export function AppLink({ to, className, children, current, onNavigate }: { to: string; className?: string; children: ReactNode; current?: boolean; onNavigate?: () => void }) {
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={(e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** The screen's title row: a noun title, one plain sentence under it, actions at the right. */
export function TitleRow({ title, sub, actions, className = '' }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {sub && <p className="mt-1 text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A block heading over a panel. */
export function BlockHead({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {meta && <span className="text-xs text-faint">{meta}</span>}
      {children}
    </div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure origins: fall back to a hidden textarea.
    try {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel,
  className = 'btn',
  onCopied,
}: {
  text: string;
  label?: ReactNode;
  /** Shown for a moment after copying, where "Copied" does not fit. */
  copiedLabel?: ReactNode;
  className?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <Button variant="raw" size="raw"
      type="button"
      className={className}
      onClick={async () => {
        if (!(await copyText(text))) return;
        setCopied(true);
        onCopied?.();
        clearTimeout(t.current);
        t.current = setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        copiedLabel ?? (
          <>
            <Icon name="check" size={14} />
            Copied
          </>
        )
      ) : (
        label
      )}
    </Button>
  );
}

/** A transient message at the foot of the screen. */
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(t.current), []);
  const show = useCallback((text: string, error = false) => {
    setMsg({ text, error });
    clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 2200);
  }, []);
  const node = msg ? (
    <div key={msg.text} role="status" aria-live="polite" className={`toast ${msg.error ? '!bg-negative' : ''}`}>
      {msg.text}
    </div>
  ) : null;
  return { show, node };
}

/** An error inside the block that failed, with a retry. */
export function BlockError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed border-control px-4 py-3 text-sm text-muted">
      <Icon name="alert" size={14} className="text-negative" />
      <span>{what}</span>
      {onRetry && (
        <Button variant="raw" size="raw" type="button" className="card-link" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** One sentence in a dashed frame: an empty block keeps its place. */
export function EmptyRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[10px] border border-dashed border-control px-3.5 py-3 text-sm text-muted ${className}`}>{children}</div>;
}

const PATHS: Record<string, ReactNode> = {
  sites: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M2 6h12" />
    </>
  ),
  overview: <path d="M2.5 13.5V8M6.5 13.5V4M10.5 13.5V6.5M14 13.5H1.5" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  agents: (
    <>
      <rect x="3" y="5" width="10" height="8" rx="3" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01" />
    </>
  ),
  billing: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M1.5 6.5h13M4 10h2" />
    </>
  ),
  logout: <path d="M6 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h2M10 5l3 3-3 3M13 8H6" />,
  menu: <path d="M2 4h12M2 8h12M2 12h12" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  updown: <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  down: <path d="M4.5 6.5 8 10l3.5-3.5" />,
  left: <path d="M10 4 6 8l4 4" />,
  refresh: (
    <>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.6 3.8L13.5 5.5" />
      <path d="M13.5 2v3.5H10" />
    </>
  ),
  copy: (
    <>
      <rect x="5" y="5" width="8" height="8" rx="2" />
      <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />
    </>
  ),
  check: <path d="M3 8.5l3 3 7-7" />,
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.2h.01" />
    </>
  ),
  edit: <path d="M3 13l.6-2.9 7-7a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2l-7 7zM9.5 4.2l2.3 2.3" />,
  plus: <path d="M8 3v10M3 8h10" />,
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </>
  ),
  alert: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 11h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5" />
    </>
  ),
  bell: <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3" />,
  bellOff: <path d="M4 11V7a4 4 0 0 1 6.5-3.1M12 7v4l1 1.5H5M6.5 14h3M2.5 2.5l11 11" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  monitor: <path d="M2.5 3.5h11v7.5h-11zM6 13.5h4M8 11v2.5" />,
  expand: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  external: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />,
  key: (
    <>
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="M7.6 8.4 13.5 2.5M11.5 4.5l1.5 1.5" />
    </>
  ),
  link: <path d="M6.7 9.3a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.3 6.7a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />,
  mail: <path d="M2.5 4h11v8h-11zM2.5 4.5 8 9l5.5-4.5" />,
  qr: <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h1.5M13.5 9.5v1.5M9.5 13.5v-1.5M12 13.5h1.5" />,
  archive: <path d="M2 2.5h12v3H2zM3 5.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7M6.5 8.5h3" />,
  restore: <path d="M2 2.5h12v3H2zM3 5.5v7a1 1 0 0 0 1 1h1.5M13 5.5v7a1 1 0 0 1-1 1h-1.5M8 13.5v-5M6 10.5l2-2 2 2" />,
  download: <path d="M8 2.5v7.5M5 7l3 3 3-3M3 13.5h10" />,
  bars: <path d="M2.5 2v12M5.5 4.5h8M5.5 8h5M5.5 11.5h2.5" />,
  table: <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  play: <path d="M5 3.5v9l7.5-4.5z" />,
  target: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.5" />
    </>
  ),
};

/** One outline icon set, 16px grid, grey by default. */
export function Icon({ name, size = 16, className = '' }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      {PATHS[name]}
    </svg>
  );
}
