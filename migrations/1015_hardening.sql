-- When a listing was last tried, kept even when its URL changes, so editing a URL can't jump the queue.
ALTER TABLE placements ADD COLUMN last_attempt_at INTEGER;
UPDATE placements SET last_attempt_at = last_checked_at;

-- Use the location headers of the owner's own proxy. Off unless the owner turns it on, because anyone can send those headers.
ALTER TABLE sites ADD COLUMN proxy_location INTEGER NOT NULL DEFAULT 0;

CREATE INDEX widget_limits_minute ON widget_limits (minute);

-- A request already under way when its site is deleted must not leave data behind: rows for a missing site are dropped.
CREATE TRIGGER visitors_need_site BEFORE INSERT ON visitors WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER sessions_need_site BEFORE INSERT ON sessions WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER events_need_site BEFORE INSERT ON events WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER payments_need_site BEFORE INSERT ON payments WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER payment_claims_need_site BEFORE INSERT ON payment_claims WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER pending_payments_need_site BEFORE INSERT ON pending_payments WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER dodo_products_need_site BEFORE INSERT ON dodo_products WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER funnels_need_site BEFORE INSERT ON funnels WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER tracked_links_need_site BEFORE INSERT ON tracked_links WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER annotations_need_site BEFORE INSERT ON annotations WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER placements_need_site BEFORE INSERT ON placements WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
