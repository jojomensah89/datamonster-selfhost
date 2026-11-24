import { useEffect, useRef, useState } from 'react';
import type { Filters } from '../lib/api';
import { ChipRow } from './ChipRow';
import { Button } from './primitives/button';
import { renderLabel, rowName } from './Panel';
import { Icon } from './ui';

const FILTER_LABELS: Record<string, { label: string; dim: string }> = {
  channel: { label: 'Channel', dim: 'channel' },
  source: { label: 'Source', dim: 'source' },
  utm_campaign: { label: 'Campaign', dim: 'campaign' },
  utm_term: { label: 'Keyword', dim: 'keyword' },
  utm_source: { label: 'UTM source', dim: 'utm_source' },
  utm_medium: { label: 'UTM medium', dim: 'utm_medium' },
  ref: { label: 'Ref', dim: 'ref' },
  country: { label: 'Country', dim: 'country' },
  region: { label: 'Region', dim: 'region' },
  city: { label: 'City', dim: 'city' },
  browser: { label: 'Browser', dim: 'browser' },
  os: { label: 'OS', dim: 'os' },
  device: { label: 'Device', dim: 'device' },
  page: { label: 'Visited page', dim: 'page' },
  entry_page: { label: 'Entry page', dim: 'entry_page' },
  hostname: { label: 'Hostname', dim: 'hostname' },
  goal: { label: 'Completed goal', dim: 'goal' },
};

/** The active filters, in reach while the page scrolls. `onEmpty` takes keyboard focus once the bar is gone. */
export function FilterBar({ filters, onRemove, onClear, onEmpty }: { filters: Filters; onRemove: (key: string) => void; onClear: () => void; onEmpty: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const shown = Object.entries(filters);

  // The line under the bar only shows once content passes behind it.
  useEffect(() => {
    const on = () => {
      const el = bar.current;
      if (el) setStuck(el.getBoundingClientRect().top <= parseFloat(getComputedStyle(el).top) + 0.5);
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, []);

  const remove = (key: string, i: number) => {
    const buttons = [...bar.current!.querySelectorAll('button')]; // one × per filter, then Clear all
    if (shown.length > 1) buttons[i + 1].focus({ preventScroll: true });
    onRemove(key);
    if (shown.length === 1) onEmpty();
  };

  return (
    <div ref={bar} className="filter-bar" data-stuck={stuck || undefined} role="region" aria-label="Filters">
      <ChipRow values={filters} className="flex-1 gap-2">
        {shown.map(([k, v], i) => {
          const { label, dim } = FILTER_LABELS[k] ?? { label: k, dim: k };
          return (
            <span key={k} data-filter={k} className="filter-chip">
              <span className="text-muted">{label} is</span>
              <span className="flex min-w-0 max-w-[min(240px,44vw)] items-center gap-1.5 font-medium">{renderLabel(dim, { label: v || null })}</span>
              <Button variant="raw" size="raw" type="button" className="icon-btn h-7 w-7" onClick={() => remove(k, i)} aria-label={`Remove filter ${label}: ${rowName(dim, v || null)}`}>
                <Icon name="close" size={12} />
              </Button>
            </span>
          );
        })}
      </ChipRow>
      <Button
        variant="raw"
        size="raw"
        type="button"
        className="btn-ghost shrink-0"
        onClick={() => {
          onClear();
          onEmpty();
        }}
      >
        Clear all
      </Button>
    </div>
  );
}
