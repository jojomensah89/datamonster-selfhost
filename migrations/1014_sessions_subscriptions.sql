-- Dashboard sign-ins. Signing out deletes the row, so a copied cookie stops working too.
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  -- 'admin' (password login) or 'u:<users.id>'
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_expires ON auth_sessions (expires_at);

-- One row per plan subscription, so one ending can never end another. users.plan_* is worked out from these.
CREATE TABLE plan_subscriptions (
  id TEXT PRIMARY KEY, -- the provider's subscription id
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  until INTEGER NOT NULL,
  payment_id TEXT, -- last payment, to recognise its refund
  updated_at INTEGER NOT NULL
);
CREATE INDEX plan_subscriptions_user ON plan_subscriptions (user_id);
CREATE INDEX plan_subscriptions_payment ON plan_subscriptions (payment_id);
INSERT OR IGNORE INTO plan_subscriptions (id, user_id, status, until, payment_id, updated_at)
  SELECT dodo_subscription_id, id, plan_status, COALESCE(plan_until, 0), dodo_payment_id, COALESCE(paid_at, created_at)
  FROM users WHERE dodo_subscription_id IS NOT NULL;

-- Events taken from one address for one hosted account today. The key is a one-day keyed hash, not an address.
CREATE TABLE event_sources (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  events INTEGER NOT NULL
);
CREATE INDEX event_sources_day ON event_sources (day);
