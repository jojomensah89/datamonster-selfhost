-- Tagged links and annotations: the first things agents (with the write scope) and owners can create.

-- A link to a page on the site, tagged with ?ref=<ref>. Sessions already record ref, so revenue per link is a
-- breakdown by ref. Links are archived, never deleted, so their history keeps a name.
CREATE TABLE tracked_links (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  -- slug: [a-z0-9][a-z0-9-]{1,48}
  ref TEXT NOT NULL,
  -- full URL on the site's own domain, without the ref parameter, e.g. https://example.com/pricing?plan=pro
  destination TEXT NOT NULL,
  label TEXT,
  -- agent token id, or 'owner' when created from the dashboard
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX tracked_links_site_ref ON tracked_links (site_id, ref);

-- A note on one day of a site's timeline, e.g. "Launched on Product Hunt".
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  -- YYYY-MM-DD in the site's time zone
  day TEXT NOT NULL,
  text TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX annotations_site_day ON annotations (site_id, day);
