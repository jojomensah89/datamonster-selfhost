import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Filters } from '../lib/api';

/** One line of chips that scrolls sideways, fading at an edge that has more. `values` is what the chips show, by key. */
export function ChipRow({ values, className = '', children }: { values: Filters; className?: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const before = useRef(values);
  const measure = () => {
    const el = row.current;
    if (!el) return;
    el.toggleAttribute('data-more-start', el.scrollLeft > 1);
    el.toggleAttribute('data-more-end', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useLayoutEffect(() => {
    // Bring the newest filter into view.
    const newest = Object.keys(values).find((k) => before.current[k] !== values[k]);
    before.current = values;
    const el = row.current;
    const chip = newest === undefined ? null : el?.querySelector<HTMLElement>(`[data-filter="${newest}"]`);
    if (el && chip) el.scrollLeft = chip.offsetLeft + chip.offsetWidth - el.clientWidth + 24;
    measure();
  }, [values]);
  useEffect(() => {
    if (!row.current || typeof ResizeObserver === 'undefined') return;
    const seen = new ResizeObserver(measure);
    seen.observe(row.current);
    return () => seen.disconnect();
  }, []);
  return (
    <div ref={row} className={`chip-row ${className}`} onScroll={measure}>
      {children}
    </div>
  );
}
