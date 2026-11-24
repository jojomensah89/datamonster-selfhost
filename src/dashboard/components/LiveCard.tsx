import { Button } from './primitives/button';
import { useMemo } from 'react';
import { useDash } from '../lib/context';
import { fmtNumber } from '../lib/format';
import { groupByCity, useRealtime } from '../lib/realtime';
import { useTheme } from '../lib/theme';
import { useReducedMotion } from './Dialog';
import { LiveMap } from './live/LiveMap';
import { BlockError, Icon } from './ui';

const POLL_MS = 20_000;

/**
 * The Overview's live card: who is on the site now, on a small flat map.
 * It polls slowly, and not at all while the live view is open (that view polls for itself).
 */
export function LiveCard({ onOpen, paused }: { onOpen: () => void; paused: boolean }) {
  const { site } = useDash();
  const { theme } = useTheme();
  const reduced = useReducedMotion();
  const { data, error, reload } = useRealtime(site.id, POLL_MS, !paused);
  const places = useMemo(
    () =>
      groupByCity(data?.visitors ?? []).map((g) => ({
        key: g.key,
        lat: g.lat,
        lon: g.lon,
        country: g.country,
        city: g.city,
        count: g.visitors.length,
      })),
    [data],
  );
  const active = data?.active.visitors ?? 0;
  const countries = data?.active.countries ?? 0;

  return (
    <section aria-labelledby="live-card-title" className="card v3-contained-card v3-live">
      <div className="flex items-center justify-between gap-3">
        <h2 id="live-card-title" className="text-base font-semibold">
          Live now
        </h2>
        <Button variant="raw" size="raw" type="button" className="icon-btn -mr-1.5" onClick={onOpen} aria-label="Open live map" title="Open live map (M)">
          <Icon name="expand" size={14} />
        </Button>
      </div>
      {error && !data ? (
        <BlockError what={`Couldn't load live visitors: ${error}.`} onRetry={reload} />
      ) : (
        <div role="group" aria-label="Active visitors by approximate location" title="Locations are approximate" className="flex flex-1 flex-col">
          <div className="flex items-start gap-8">
            <div className="min-w-0">
              {data ? <div className="text-[30px] font-semibold leading-tight tracking-[-0.01em] tabular-nums">{fmtNumber(active)}</div> : <div className="skeleton h-9 w-12" />}
              <div className="mt-0.5 text-muted">Active · last 5 min · site-wide</div>
            </div>
            <div className="min-w-0">
              {data ? <div className="text-2xl leading-[36px] tracking-[-0.01em] tabular-nums">{fmtNumber(countries)}</div> : <div className="skeleton h-9 w-10" />}
              <div className="mt-0.5 text-muted">{countries === 1 ? 'Country' : 'Countries'}</div>
            </div>
          </div>
          <div className="relative mt-3 min-h-[150px] flex-1 overflow-hidden rounded-[14px] bg-[rgb(var(--c-map-stage))] frame:min-h-[168px]">
            <LiveMap mode="flat" compact places={places} onSelect={() => onOpen()} animate={false} reduced={reduced} themeKey={theme} label="" className="absolute inset-0" />
          </div>
          {(!data || active === 0) && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
              <span className={`h-1.5 w-1.5 rounded-full ${data && active === 0 ? 'bg-control' : 'bg-accent'}`} aria-hidden="true" />
              {data && active === 0 ? 'Nobody on the site right now' : 'Loading visitors…'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
