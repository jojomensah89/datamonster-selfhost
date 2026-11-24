-- DataMonster agent layer. Migrations from 1000 up belong to DataMonster; 0001-0999 follow the Minilytics schema.

-- Tokens an AI agent uses to call the agent API and the MCP server. Only a hash of the secret is stored.
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  -- users.id in hosted mode; 'admin' on a self-hosted install
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  -- first characters of the secret, so the owner can tell tokens apart
  prefix TEXT NOT NULL,
  -- space-separated: 'read' or 'read write'. 'admin' is never stored here: agents cannot hold it.
  scopes TEXT NOT NULL,
  -- comma-separated site ids the token is limited to; NULL means every site the owner can see
  site_ids TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX agent_tokens_owner ON agent_tokens (owner_id);

-- Every tool call an agent makes, newest first in the dashboard.
CREATE TABLE agent_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  site_id TEXT,
  tool TEXT NOT NULL,
  args TEXT,
  write INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX agent_audit_owner_ts ON agent_audit (owner_id, ts);
