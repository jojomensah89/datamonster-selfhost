import { useState, type ReactNode } from 'react';
import { persona } from '../../shared/names';
import { domainForSource } from '../../shared/sources';
import { Icon } from './ui';

export function Favicon({ domain, size = 18, fallback }: { domain?: string | null; size?: number; fallback?: ReactNode }) {
  const [broken, setBroken] = useState(false);
  if (!domain || broken) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded text-stone-400"
        style={{ width: size, height: size, fontSize: size * 0.8 }}
      >
        {fallback ?? <LinkIcon size={size} />}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
      width={size}
      height={size}
      className="shrink-0 rounded"
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

export function LinkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

/** Medium's own favicon is its wordmark cut off after "Me", so its mark is drawn here. */
function MediumMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0 rounded" aria-hidden="true">
      <path d="M0 0h16v16H0z" fill="#000" />
      <g fill="#fff">
        <circle cx="5.4" cy="8" r="3.2" />
        <ellipse cx="10.5" cy="8" rx="1.5" ry="3" />
        <ellipse cx="13.1" cy="8" rx=".6" ry="2.7" />
      </g>
    </svg>
  );
}

export function SourceIcon({ source, domain, size, fallback }: { source: string | null; domain?: string | null; size?: number; fallback?: ReactNode }) {
  if (!source || source === 'Direct/None') return <Favicon size={size} fallback={fallback} />;
  if (source === 'Medium') return <MediumMark size={size} />;
  return <Favicon domain={domainForSource(source) ?? domain ?? (source.includes('.') ? source : null)} size={size} fallback={fallback} />;
}

/** One grey outline glyph per channel, on the same 16px grid as the app's icons. */
const CHANNEL_PATHS: Record<string, string> = {
  Direct: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  'Organic Search': 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5 14 14',
  'Organic Social': 'M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
  AI: 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2',
  Referral: 'M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5',
  Email: 'M2.5 4h11v8h-11zM2.5 4.5 8 9l5.5-4.5',
  Paid: 'M8 2v12M11 4.5H6.8a1.8 1.8 0 0 0 0 3.5h2.4a1.8 1.8 0 0 1 0 3.5H5',
};
function Glyph({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-pill text-pillInk" style={{ width: size, height: size }}>
      <svg width={size * 0.67} height={size * 0.67} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
      </svg>
    </span>
  );
}
export function ChannelIcon({ channel }: { channel: string | null }) {
  return <Glyph d={CHANNEL_PATHS[channel ?? ''] ?? 'M8 7.5v.01'} />;
}

// Browsers and systems are a fixed set, so they get one local glyph each kind (the name beside it says which) rather
// than a logo from Google's favicon service: no third-party request for them on any dashboard view.
// Referrer sources (SourceIcon) are open-ended domains and still use the favicon service.
export function BrowserIcon({ size }: { name?: string | null; size?: number }) {
  return <Glyph size={size} d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />;
}
export function OSIcon({ size }: { name?: string | null; size?: number }) {
  return <Glyph size={size} d="M3 4h10v7H3zM1.5 13h13" />;
}
export function DeviceIcon({ name, size = 18 }: { name: string | null; size?: number }) {
  const d = name === 'Mobile' ? 'M5 2h6v12H5zM7.5 12h1' : name === 'Tablet' ? 'M3.5 2h9v12h-9zM7.5 12h1' : 'M2 3h12v8H2zM6 14h4M8 11v3';
  return <Glyph size={size} d={d} />;
}
/** A country code the flag set can draw: two letters, not Cloudflare's XX (unknown) or T1 (Tor). */
export const flagCode = (cc: string | null | undefined) => {
  const u = cc?.toUpperCase();
  return u && /^[A-Z]{2}$/.test(u) && u !== 'XX' && u !== 'T1' ? u.toLowerCase() : null;
};

/**
 * A small round flag (circle-flags, MIT; see THIRD_PARTY_NOTICES.md). Each flag is its own static SVG under
 * /flags, fetched only when shown, so the bundle carries none of them. Emoji flags are not used: Windows draws them
 * as two letters. Unknown place, or a code the set doesn't have: the outline globe from the icon set.
 */
export function Flag({ cc, size = 18, edge = true }: { cc: string | null; size?: number; edge?: boolean }) {
  const code = flagCode(cc);
  const [missing, setMissing] = useState<string | null>(null);
  if (!code || missing === code) {
    return (
      <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        <Icon name="globe" size={Math.round(size * 0.8)} className="text-faint" />
      </span>
    );
  }
  return (
    <img
      src={`/flags/${code}.svg`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={`inline-block shrink-0 rounded-full ${edge ? 'flag-edge' : ''}`}
      style={{ width: size, height: size }}
      onError={() => setMissing(code)}
    />
  );
}

/** A friendly, stable avatar per visitor (same visitor id = same face and animal name). */
export function Avatar({ id, size = 40 }: { id: string; size?: number }) {
  const p = persona(id);
  return (
    <img
      src={p.avatar}
      alt=""
      title={p.name}
      width={size}
      height={size}
      className="inline-block shrink-0 rounded-full ring-2 ring-surface"
      style={{ width: size, height: size, background: p.color }}
    />
  );
}
