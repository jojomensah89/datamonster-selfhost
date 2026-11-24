-- OAuth 2.1 for MCP clients (Claude.ai, ChatGPT and others): "sign in and click Allow" instead of a pasted token.
-- An approved connection is one agent_tokens row (so scopes, site limits, the audit log and the Agents page all apply).
-- Its access secret is replaced on every refresh; revoking the row ends the connection and its refresh tokens.

-- When the current access secret stops working. NULL for tokens created by hand (they never expire).
ALTER TABLE agent_tokens ADD COLUMN expires_at INTEGER;
-- oauth_clients.id for a connection made with OAuth; NULL for tokens created by hand.
ALTER TABLE agent_tokens ADD COLUMN oauth_client_id TEXT;

-- Clients that registered themselves (RFC 7591). Public clients only: no client secret exists.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- JSON array of exact redirect URIs
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- SHA-256 of the registering IP, only to cap registrations per address
  created_ip TEXT
);
CREATE INDEX oauth_clients_ip ON oauth_clients (created_ip, created_at);

-- Authorization codes: single use, about a minute long. Only a hash of the code is stored.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  site_ids TEXT,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  -- the agent token the code was exchanged for, revoked if the code is ever presented again
  agent_token_id TEXT
);

-- Refresh tokens: rotated on every use. Presenting a used one revokes the whole connection.
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_token_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX oauth_refresh_tokens_agent ON oauth_refresh_tokens (agent_token_id);
