-- Launches: the directories and listings a site launched on (Product Hunt, BetaList, a newsletter), whether each
-- listing is still up, and what it brought in. Owners and agents (write scope) manage them; a daily cron checks
-- live listings. Archived, never deleted, so their history keeps a name.
CREATE TABLE placements (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  -- e.g. "Product Hunt"; unique per site, ignoring case
  name TEXT NOT NULL,
  -- the public listing page (http/https, public host), checked by verify; NULL until there is one
  listing_url TEXT,
  -- YYYY-MM-DD in the site's time zone
  launched_on TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'in_review', 'live', 'rejected', 'removed')),
  -- Which sessions count as coming from this placement: any session matching at least one of these.
  -- match_source: the classified source name (sessions.source, e.g. "Product Hunt")
  -- match_domain: the referrer domain (sessions.referrer_domain, subdomains included), e.g. "producthunt.com"
  -- match_ref: a ?ref= tag (sessions.ref), e.g. "ph-launch"
  match_source TEXT,
  match_domain TEXT,
  match_ref TEXT,
  last_checked_at INTEGER,
  last_check_result TEXT CHECK (last_check_result IN ('ok', 'missing', 'error', 'unknown')),
  -- short reason shown next to the result, e.g. "HTTP 404"
  last_check_detail TEXT,
  notes TEXT,
  -- agent token id, or 'owner' when created from the dashboard
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  archived_at INTEGER
);
CREATE UNIQUE INDEX placements_site_name ON placements (site_id, name COLLATE NOCASE);
-- The daily check picks live and in-review placements that were not checked recently.
CREATE INDEX placements_due ON placements (status, last_checked_at) WHERE archived_at IS NULL;
