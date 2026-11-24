-- Monthly event counts per hosted account (UTC YYYY-MM), used for plan limits.
CREATE TABLE usage_monthly (
  owner_id TEXT NOT NULL,
  month TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, month)
);
