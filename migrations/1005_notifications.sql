-- Digest and alerts: where a site's Monday digest and alerts go (Telegram, Slack, Discord, a signed webhook), and a log
-- of what was sent. Channel secrets (bot tokens, webhook URLs, signing secrets) stay on the server and are masked on read.
CREATE TABLE notify_channels (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  -- 'email' is reserved for later; the API does not create it yet
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'slack', 'discord', 'webhook', 'email')),
  -- the owner's name for it, e.g. "#growth"
  label TEXT,
  -- JSON. telegram: {bot_token, chat_id}; slack, discord: {url}; webhook: {url, secret}
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  weekly_digest INTEGER NOT NULL DEFAULT 1,
  alert_first_sale INTEGER NOT NULL DEFAULT 1,
  alert_launch_sale INTEGER NOT NULL DEFAULT 1,
  alert_listing_missing INTEGER NOT NULL DEFAULT 1,
  alert_revenue_spike INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX notify_channels_site ON notify_channels (site_id);

-- One row per message sent (or tried). dedupe_key makes each digest and alert go out once per channel:
-- "digest:2026-11-16", "first_sale", "launch_sale:plc_x", "listing_missing:plc_x", "revenue_spike:2026-11-14", "test:<id>".
-- A failed send may be retried by a later run (attempts < 3); a sent one never repeats.
CREATE TABLE notify_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  -- digest | first_sale | launch_sale | listing_missing | revenue_spike | test
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  -- short reason when ok = 0, e.g. "HTTP 404" (never a secret)
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX notify_deliveries_dedupe ON notify_deliveries (channel_id, dedupe_key);
CREATE INDEX notify_deliveries_site ON notify_deliveries (site_id, ts);
