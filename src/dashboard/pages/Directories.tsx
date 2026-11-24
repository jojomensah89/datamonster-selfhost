import { useState } from 'react';
import { CopyLabel } from '../components/CopyLabel';
import { Button } from '../components/primitives/button';
import { Input } from '../components/primitives/input';
import { SelectField, SelectItem } from '../components/primitives/select-field';
import { CopyButton, Icon } from '../components/ui';
import '../landing/landing.css';
import { SiteFooter, SiteNav, usePlan } from '../landing/SiteChrome';
import { useLightOnly } from '../lib/theme';
import { agentPrompt, byCategory, CATEGORY_LABEL, DIRECTORIES, directoryQuery, filterDirectories, parseDirectoryFilter, type DirectoryFilter } from '../../shared/directories';
import './directories.css';

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');

/** A plain list of places to launch. Agents read the same list at /directories.json and /directories.md. */
export function Directories({ hosted: wasHosted, loggedIn, supportEmail }: { hosted: boolean; loggedIn: boolean; supportEmail: string | null }) {
  useLightOnly();
  const plan = usePlan();
  const hosted = plan?.hosted ?? wasHosted;
  const [filter, setFilter] = useState(() => parseDirectoryFilter(new URLSearchParams(window.location.search)));
  const shown = filterDirectories(filter);
  const query = directoryQuery(filter);
  const { origin } = window.location;

  // The address keeps the filters, so a filtered list can be shared.
  const change = (next: DirectoryFilter) => {
    setFilter(next);
    window.history.replaceState(window.history.state, '', `/directories${directoryQuery(next)}`);
  };

  return (
    <div className="dir-page">
      <header className="lp lp-chrome">
        <SiteNav page="directories" hosted={hosted} loggedIn={loggedIn} />
      </header>
      <main className="dir-main">
        <section className="dir-hero">
          <h1>Launch directories</h1>
          <p>{DIRECTORIES.length} places to launch your product. A plain list: check each site's own rules and prices before you submit.</p>
        </section>

        <section className="dir-agents" aria-labelledby="dir-agents-title">
          <div>
            <h2 id="dir-agents-title">For your agent</h2>
            <p>The same list, with the same filters. Connected agents can call list_directories.</p>
          </div>
          <ul>
            {[`/directories.json${query}`, `/directories.md${query}`].map((path) => (
              <li key={path}>
                <a href={path}>{path}</a>
                <CopyButton
                  text={origin + path}
                  className="dir-icon"
                  label={<CopyLabel icon="copy" text={`Copy ${path}`} />}
                  copiedLabel={<CopyLabel icon="check" text={`Copied ${path}`} />}
                />
              </li>
            ))}
          </ul>
          <CopyButton
            text={agentPrompt(origin, filter)}
            className="dir-prompt"
            label={
              <>
                <Icon name="copy" />
                Copy prompt
              </>
            }
          />
        </section>

        <div className="dir-filters">
          <div className="dir-search">
            <Icon name="search" />
            <Input
              type="search"
              aria-label="Search directories"
              placeholder="Search"
              className="h-11 rounded-full bg-white pl-10 text-base sm:text-sm"
              value={filter.search ?? ''}
              onChange={(e) => change({ ...filter, search: e.target.value || undefined })}
            />
          </div>
          <SelectField aria-label="Category" className="h-11 w-full rounded-full bg-white px-4 sm:w-56" value={filter.category ?? ''} onValueChange={(v) => change({ ...filter, category: v || undefined })}>
            <SelectItem value="">All categories</SelectItem>
            {byCategory(DIRECTORIES).map(([c, rows]) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABEL[c]} ({rows.length})
              </SelectItem>
            ))}
          </SelectField>
          <p role="status">{shown.length === DIRECTORIES.length ? `${shown.length} places` : `${shown.length} of ${DIRECTORIES.length} places`}</p>
        </div>

        {byCategory(shown).map(([c, rows]) => (
          <section key={c} className="dir-group" aria-labelledby={`dir-${c}`}>
            <h2 id={`dir-${c}`}>
              {CATEGORY_LABEL[c]} <span>{rows.length}</span>
            </h2>
            <ul>
              {rows.map((d) => (
                <li key={d.url}>
                  <a href={d.url} target="_blank" rel="noopener noreferrer">
                    <b>{d.name}</b>
                    <span>{hostOf(d.url)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {shown.length === 0 && (
          <p className="dir-none">
            Nothing matches.{' '}
            <Button variant="raw" size="raw" type="button" className="underline" onClick={() => change({})}>
              Show all
            </Button>
          </p>
        )}
      </main>
      <div className="lp lp-chrome">
        <SiteFooter page="directories" hosted={hosted} loggedIn={loggedIn} supportEmail={plan?.supportEmail ?? supportEmail} />
      </div>
    </div>
  );
}
