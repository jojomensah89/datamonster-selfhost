import type { CSSProperties } from 'react';

/** A continuous, decorative share meter with optional accessible context. */
export function Capsule({ ratio, caption, large = false, metric = 'neutral' }: { ratio: number; caption?: string; large?: boolean; metric?: 'visitors' | 'revenue' | 'neutral' }) {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return <span className={`v3-meter-wrap${large ? ' large' : ''}`} data-metric-color={metric} title={caption} style={{ '--v3-segment-fill': `var(--chart-${metric})` } as CSSProperties}>
    <span className="v3-meter" aria-hidden="true"><i><b style={{ width: `${r * 100}%` }} /></i></span>
    {caption && <span className="sr-only">{caption}</span>}
  </span>;
}

/** Two independently scaled quantities, never a share of one combined total. */
export function MetricRowBackground({ visitors, revenue, maxVisitors, maxRevenue }: { visitors: number; revenue: number; maxVisitors: number; maxRevenue: number }) {
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const hasRevenue = maxRevenue > 0;
  return <span className="metric-row-background" aria-hidden="true">
    <i data-row-metric="visitors" style={{ width: `${clamp(visitors / Math.max(1, maxVisitors)) * (hasRevenue ? 62 : 100)}%` }} />
    <i data-row-metric="revenue" style={{ width: `${hasRevenue ? clamp(revenue / maxRevenue) * 38 : 0}%` }} />
  </span>;
}
