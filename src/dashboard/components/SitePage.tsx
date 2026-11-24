import { useEffect, useState, type ReactNode } from 'react';
import type { Site } from '../lib/api';
import { loadPref } from '../lib/prefs';
import { useApi } from '../lib/useApi';
import { AppLink, BlockError, EmptyRow, TitleRow } from './ui';

export const LAST_SITE = 'dm_last_site';

/** Periods the Launches and Links ledgers offer. */
export const LEDGER_PERIODS: [string, string][] = [
  ['all', 'All time'],
  ['12m', 'Last 12 months'],
  ['90d', 'Last 90 days'],
  ['30d', 'Last 30 days'],
  ['7d', 'Last 7 days'],
];

/** The site a page outside /site/ is about: ?site=, else the last site opened, else the only one. Follows the sidebar's switcher. */
function useSiteParam() {
  const read = () => new URLSearchParams(window.location.search).get('site') ?? loadPref<string | null>(LAST_SITE, null);
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return id;
}

/** A page about one site that is not under /site/ (Launches, Links): picks the site, and covers loading, errors and having none. */
export function SitePage({ title, children }: { title: string; children: (site: Site) => ReactNode }) {
  const wanted = useSiteParam();
  const { data: sites, error } = useApi<Site[]>('/api/sites');
  const site = sites?.find((s) => s.id === wanted) ?? (sites?.length ? sites[0] : undefined);

  if (error && !sites) return <BlockError what={`Couldn't load your sites: ${error}.`} />;
  if (!sites) {
    return (
      <div aria-busy="true">
        <div className="skeleton h-7 w-40" />
        <div className="skeleton mt-2 h-4 w-80 max-w-full" />
        <div className="skeleton mt-6 h-64 rounded-2xl" />
      </div>
    );
  }
  if (!site) {
    return (
      <>
        <TitleRow title={title} />
        <EmptyRow>
          Add a website first.{' '}
          <AppLink to="/" className="card-link">
            All websites
          </AppLink>
        </EmptyRow>
      </>
    );
  }
  return <>{children(site)}</>;
}

/** A labelled form field with an optional hint under it. */
export function Field({ label, hint, id, children }: { label: string; hint?: ReactNode; id: string; children: ReactNode }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
