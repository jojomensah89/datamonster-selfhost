-- Free accounts record one website. NULL until it has to be chosen (an account that had more on Pro), then the busiest one.
ALTER TABLE users ADD COLUMN free_site_id TEXT;

-- Stored events per account, UTC day and website: the month on the billing page, and which website is busiest.
CREATE TABLE usage_daily (
  owner_id TEXT NOT NULL,
  day TEXT NOT NULL,
  site_id TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day, site_id)
) WITHOUT ROWID;

INSERT INTO usage_daily (owner_id, day, site_id, events)
SELECT s.owner_id, date(e.ts / 1000, 'unixepoch'), e.site_id, COUNT(*)
FROM events e JOIN sites s ON s.id = e.site_id
WHERE s.owner_id IS NOT NULL AND e.ts >= unixepoch('now', 'start of month') * 1000
GROUP BY 1, 2, 3;
