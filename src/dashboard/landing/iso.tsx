import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * A small kit for the landing page's line drawings. One isometric space: x runs down-right, y down-left, z up.
 * Faces are filled with the plate's own colour (--face), so nearer things hide what is behind them; draw back to front.
 */
export type P3 = [number, number, number];
const C = Math.cos(Math.PI / 6);
const U = 40; // pixels per unit

export const px = ([x, y, z]: P3): [number, number] => [(x - y) * C * U, ((x + y) / 2 - z) * U];
const pts = (list: P3[]) => list.map((p) => px(p).map((n) => n.toFixed(1)).join(',')).join(' ');

export type Tone = 'line' | 'soft' | 'hot';

/** A line through points. `dash` for routes and hidden edges. */
export function Line({ p, tone = 'line', dash, className = '' }: { p: P3[]; tone?: Tone; dash?: boolean; className?: string }) {
  return <polyline className={`iso-l iso-l--${tone}${dash ? ' iso-dash' : ' iso-draw'} ${className}`} pathLength={dash ? undefined : 1} points={pts(p)} />;
}

export function Poly({ p, tone = 'line', fill = true }: { p: P3[]; tone?: Tone; fill?: boolean }) {
  return <polygon className={`iso-l iso-l--${tone}${fill ? ' iso-f' : ''} iso-draw`} pathLength={1} points={pts(p)} />;
}

/** A box standing on z, its near corner towards the viewer. */
export function Box({ x, y, z = 0, w, d, h, tone = 'line', children }: { x: number; y: number; z?: number; w: number; d: number; h: number; tone?: Tone; children?: ReactNode }) {
  const t = z + h;
  return (
    <g>
      <Poly tone={tone} p={[[x, y + d, z], [x + w, y + d, z], [x + w, y + d, t], [x, y + d, t]]} />
      <Poly tone={tone} p={[[x + w, y, z], [x + w, y + d, z], [x + w, y + d, t], [x + w, y, t]]} />
      <Poly tone={tone} p={[[x, y, t], [x + w, y, t], [x + w, y + d, t], [x, y + d, t]]} />
      {children}
    </g>
  );
}

/** Points of a flat rounded rectangle at height z. */
export function rounded(x: number, y: number, w: number, d: number, r: number, z: number): P3[] {
  const out: P3[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 10; i++) {
      const a = ((from + i * 9) * Math.PI) / 180;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
    }
  };
  corner(x + w - r, y + d - r, 0);
  corner(x + r, y + d - r, 90);
  corner(x + r, y + r, 180);
  corner(x + w - r, y + r, 270);
  return out;
}

/** A rounded block: the side that faces the viewer, then its top. */
export function Round({ x, y, z = 0, w, d, r, h, tone = 'line', children }: { x: number; y: number; z?: number; w: number; d: number; r: number; h: number; tone?: Tone; children?: ReactNode }) {
  const top = rounded(x, y, w, d, r, z + h);
  const low = rounded(x, y, w, d, r, z);
  // The outline's leftmost and rightmost points on screen; between them, through the front, is what shows.
  let a = 0;
  let b = 0;
  low.forEach((p, i) => {
    if (px(p)[0] > px(low[a])[0]) a = i;
    if (px(p)[0] < px(low[b])[0]) b = i;
  });
  const n = low.length;
  const arc = (from: number, to: number) => Array.from({ length: ((to - from + n) % n) + 1 }, (_, i) => (from + i) % n);
  const front = arc(a, b);
  const side: P3[] = [...front.map((i) => low[i]), ...front.map((i) => top[i]).reverse()];
  return (
    <g>
      <Poly tone={tone} p={side} />
      <Poly tone={tone} p={top} />
      {children}
    </g>
  );
}

/** A circle lying flat (or on a wall facing left, `wall`). */
export function Ring({ x, y, z = 0, r, tone = 'line', fill = false, dash }: { x: number; y: number; z?: number; r: number; tone?: Tone; fill?: boolean; dash?: boolean }) {
  const p: P3[] = Array.from({ length: 40 }, (_, i) => [x + r * Math.cos((i / 40) * 2 * Math.PI), y + r * Math.sin((i / 40) * 2 * Math.PI), z]);
  return <polygon className={`iso-l iso-l--${tone}${fill ? ' iso-f' : ''}${dash ? ' iso-dash' : ' iso-draw'}`} pathLength={dash ? undefined : 1} points={pts(p)} />;
}

/** The dashed floor a drawing stands on. */
export function Floor({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return <Line tone="soft" dash p={[[x, y, 0], [x + w, y, 0], [x + w, y + d, 0], [x, y + d, 0], [x, y, 0]]} />;
}

/** Part of a drawing that moves as one: a class from lines.css and its place in the order. */
export function Part({ name, i = 0, children }: { name: string; i?: number; children: ReactNode }) {
  return (
    <g className={`iso-${name}`} style={{ '--k': i } as CSSProperties}>
      {children}
    </g>
  );
}

/** Coins that travel a route over and over, while it is on screen. */
export function Coins({ p, live }: { p: P3[]; live: boolean }) {
  const ref = useRef<SVGGElement>(null);
  const key = JSON.stringify(p);
  useEffect(() => {
    const g = ref.current;
    if (!g || !live || typeof g.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const at = p.map(px);
    const len = at.map((q, i) => (i ? Math.hypot(q[0] - at[i - 1][0], q[1] - at[i - 1][1]) : 0));
    const total = len.reduce((a, b) => a + b, 0);
    let run = 0;
    const path = at.map((q, i) => ({ transform: `translate(${q[0]}px, ${q[1]}px)`, offset: (run += len[i]) / total }));
    const all = [...g.children].flatMap((c, i) => {
      const t = { duration: 2400, iterations: Infinity, delay: i * 800, fill: 'backwards' as const };
      return [c.animate(path, t), c.animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.88 }, { opacity: 0 }], t)];
    });
    return () => all.forEach((a) => a.cancel());
    // p is made anew on every render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live]);
  return (
    <g ref={ref} className="iso-coins">
      {[0, 1, 2].map((i) => (
        <g key={i} opacity={0}>
          <ellipse className="iso-l iso-l--hot iso-f" cx={0} cy={0} rx={11} ry={6.35} />
          <ellipse className="iso-l iso-l--hot iso-f" cx={0} cy={-4} rx={11} ry={6.35} />
        </g>
      ))}
    </g>
  );
}

/** is-seen once it has been on screen (it draws itself), is-live only while it is (loops run). */
export function useLive<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      setLive(e.isIntersecting);
      if (e.isIntersecting) setSeen(true);
    }, { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, live, seen };
}

export function Scene({ box, className = '', onLive, children }: { box: [number, number, number, number]; className?: string; onLive?: (live: boolean) => void; children: ReactNode }) {
  const { ref, live, seen } = useLive<SVGSVGElement>();
  useEffect(() => onLive?.(live), [live, onLive]);
  return (
    <svg ref={ref} className={`iso ${className}${seen ? ' is-seen' : ''}${live ? ' is-live' : ''}`} viewBox={box.join(' ')} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
