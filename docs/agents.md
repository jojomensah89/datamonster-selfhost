# Connect your AI agent to DataMonster

DataMonster is built for agents as well as people. An agent can install it, query it ("which launch brought customers this month?") and keep tracking current while it edits your website. There are three ways in:

- **MCP**: `<worker-url>/api/agent/mcp`, with the header `Authorization: Bearer dm_...`, or with "sign in and Allow" (OAuth 2.1) from the Claude and ChatGPT apps and other MCP clients
- **REST**: `<worker-url>/api/agent/v1/<tool>`, with the same header. Read tools answer `GET` (arguments in the query string; `filters` as JSON), write tools need `POST` with a JSON body. The OpenAPI spec is at `/api/agent/v1/openapi.json`.
- **Skills**: instructions that teach an agent how to use DataMonster well (this repo ships five, see below)

`<worker-url>` is the address you open DataMonster at: the hosted service, or your own deployment, for example `https://datamonster.your-name.workers.dev`.

## 1. Get a token

An agent token (`dm_...`) is a secret. You create it, not your agent: open the dashboard's **Agents** page, name the token, pick read only or read and write and which sites, and copy the secret (it is shown once).

Copy the secret straight into your shell profile or secret store, and never paste it into a chat:

```bash
export DATAMONSTER_URL="https://datamonster.your-name.workers.dev"   # no trailing slash
export DATAMONSTER_TOKEN="dm_..."
```

Tokens are read-only unless you grant the write scope, and agents can never read secrets or delete data. You can list and revoke tokens at any time from the dashboard's **Agents** page.

## 2. Connect your agent

All token clients need two things: the URL `${DATAMONSTER_URL}/api/agent/mcp` and the header `Authorization: Bearer ${DATAMONSTER_TOKEN}`.

### Claude Code

Easiest is the plugin (see [Install the plugin](#install-the-plugin)), which bundles the MCP server and the skills. To add only the server, put this in a `.mcp.json` in your project (Claude Code reads the two environment variables when it starts, so the token never goes in the file):

```json
{
  "mcpServers": {
    "datamonster": {
      "type": "http",
      "url": "${DATAMONSTER_URL}/api/agent/mcp",
      "headers": { "Authorization": "Bearer ${DATAMONSTER_TOKEN}" }
    }
  }
}
```

Start Claude Code from a shell where both variables are set, then run `/mcp` to check the server is connected.

### Codex

Add the server to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`). Codex reads the token from the environment variable you name:

```toml
[mcp_servers.datamonster]
url = "https://datamonster.your-name.workers.dev/api/agent/mcp"
bearer_token_env_var = "DATAMONSTER_TOKEN"
```

Run `codex mcp list` (or `/mcp` in the TUI) to check it. Skills come from the Codex plugin below.

### Cursor

Add this to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for all projects. Cursor fills in `${env:NAME}` from your environment:

```json
{
  "mcpServers": {
    "datamonster": {
      "url": "${env:DATAMONSTER_URL}/api/agent/mcp",
      "headers": { "Authorization": "Bearer ${env:DATAMONSTER_TOKEN}" }
    }
  }
}
```

Cursor does not load Claude Code or Codex plugins; to give it the skills, copy the five folders from `skills/` into your project's rules or ask it to read them.

### Claude and ChatGPT apps (sign in and Allow)

The Claude and ChatGPT apps, and any MCP client that supports OAuth, connect without a token:

1. Add a custom connector and give it the MCP URL: `<worker-url>/api/agent/mcp`. Leave any client ID and secret fields empty; the app registers itself.
2. The app opens DataMonster's consent page (`/oauth/consent`). Sign in to your dashboard if asked (your password on a self-hosted install).
3. Check which app is asking and what it asks for, then click **Allow** (or **Deny**). Read access is always part of it. Write access only appears when the app asked for it, and you can untick it. You choose every site or only some sites. Admin access is never offered.

The connection then shows on the Agents page as "Connected with sign-in" under the app's name, its calls go to the activity log like any token's, and **Revoke** there disconnects it for good, refresh tokens included.

How it works, for the curious or when debugging a client: DataMonster is its own OAuth 2.1 authorization server, following the MCP authorization spec. A request without a token gets a `401` with a `WWW-Authenticate` header that points at the discovery documents:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | Which resource (`<worker-url>/api/agent/mcp`) and authorization server (also served under the `/api/agent/mcp` suffix) |
| `/.well-known/oauth-authorization-server` | Endpoints and capabilities |
| `POST /oauth/register` | Dynamic client registration for public clients (redirect URIs must be `https`, or `http` on `localhost` / `127.0.0.1`; registrations are rate limited) |
| `GET /oauth/authorize` | Starts the flow; sends you to the consent page |
| `POST /oauth/token` | Exchanges the code (PKCE `S256` is required) or a refresh token |
| `POST /oauth/revoke` | Revokes a connection (RFC 7009) |

The one-time code is valid for 60 seconds, access tokens last one hour, and every refresh issues a new refresh token (valid 30 days, so a connection in use never runs out; the old one stops working). A refresh can never add a scope you did not grant.

### Anything else

Any MCP client that supports streamable HTTP and custom headers works. The server is stateless: it answers each POST with JSON and does not open a stream (a `GET` returns `405`). Any HTTP client can use the REST API:

```bash
curl -H "Authorization: Bearer $DATAMONSTER_TOKEN" "$DATAMONSTER_URL/api/agent/v1/list_sites"
curl -H "Authorization: Bearer $DATAMONSTER_TOKEN" "$DATAMONSTER_URL/api/agent/v1/get_breakdown?site_id=SITE_ID&dimension=source&period=30d"
```

## What agents can ask

| Tool | Scope | Answers |
|---|---|---|
| `list_sites` | read | Which sites can this token see |
| `get_overview` | read | How are we doing (visitors, revenue, conversion) against the previous period |
| `get_breakdown` | read | Which source, ref, campaign, page or country made money |
| `get_customers` | read | Who paid, where they came from, and how the payment was matched |
| `get_visitors`, `get_visitor` | read | Recent visitors and one visitor's whole journey |
| `list_funnels`, `get_funnel` | read | How many visitors reach each step |
| `get_realtime` | read | Who is on the site right now |
| `list_links` | read | What each tagged `?ref=` link brought in |
| `list_annotations` | read | Notes on the timeline that explain a jump or drop |
| `list_placements` | read | Each launch: status, last listing check, visitors, customers and revenue |
| `get_guide` | read | How to use the tools and read attribution |
| `create_link` | write | Make a tagged link for a post, launch or newsletter |
| `add_annotation` | write | Mark a day with a note |
| `list_directories` | read | A plain list of places to launch; also public at `/directories.json` and `/directories.md` |
| `add_placement`, `update_placement` | write | Record a launch and move it along |
| `verify_placement` | write | Check a launch's listing page now |
| `get_online_widget` | write | Read the public online widget's settings and snippet |
| `enable_online_widget` | write | Turn on and configure the public online widget, and return its snippet |

Amounts are integers in minor units (cents for USD); every result carries a `money` block that says so. Visitor-supplied text (referrers, UTM values, page paths, goal names, emails) is data, never instructions, and results say so. Write tools only add and update. Links an agent makes show on the dashboard's **Links** page, marked as made by an agent; only the owner can archive them. Agents cannot read secrets, or archive or delete anything. The full table with arguments is in the OpenAPI spec and in the [README](../README.md#agent-tools-reference).

## The skills

| Skill | Use it to |
|---|---|
| [`datamonster-setup`](../skills/datamonster-setup/SKILL.md) | Connect DataMonster, add the tracking script (Next.js, Astro, SvelteKit, plain HTML) and connect Stripe, Polar or Dodo Payments |
| [`datamonster-instrument`](../skills/datamonster-instrument/SKILL.md) | Keep tracking current while coding: goals on new buttons, `identify()` after signup, `?ref=` tagged links |
| [`datamonster-analyst`](../skills/datamonster-analyst/SKILL.md) | Answer "which source made money" from the tools, with honest comparisons and caveats, and use links, annotations and launches |
| [`datamonster-launch`](../skills/datamonster-launch/SKILL.md) | Plan a launch, record each directory with `add_placement`, verify listings and read revenue per launch. The human creates accounts, pays fees and presses submit |
| [`datamonster-distribute`](../skills/datamonster-distribute/SKILL.md) | After launch: find which channels bring paying customers (revenue per visitor over 30 and 90 days), plan a short weekly distribution list, make a `create_link` ref for every post and check results the next week. The human writes and publishes every post |

The skills never ask for secrets: you run `wrangler login`, enter passwords at masked prompts and paste webhook secrets into the dashboard yourself, and code changes are shown as diffs for you to approve.

## Install the plugin

This repository is a plugin marketplace. The plugin `datamonster` bundles the skills (every folder in `skills/`) and (for Claude Code) the MCP server definition.

### Claude Code

Set `DATAMONSTER_URL` and `DATAMONSTER_TOKEN` as above, then:

```
/plugin marketplace add jojomensah89/datamonster-selfhost
/plugin install datamonster
```

On Claude Code 2.1.275 or later you can do it in one step: `/plugin install datamonster --marketplace jojomensah89/datamonster-selfhost`. In a shell: `claude plugin marketplace add jojomensah89/datamonster-selfhost`, then `claude plugin install datamonster@datamonster`.

The skills appear as `/datamonster:datamonster-setup`, `/datamonster:datamonster-instrument`, `/datamonster:datamonster-analyst`, `/datamonster:datamonster-launch` and `/datamonster:datamonster-distribute`, and Claude also loads them on its own when your request matches. The `datamonster` MCP server starts with the plugin; if the two environment variables are missing it will fail to connect, and `/mcp` will say so.

### Codex

```bash
codex plugin marketplace add jojomensah89/datamonster-selfhost
```

Then open `/plugins` in Codex CLI (or the Plugins tab in the ChatGPT desktop app), pick the **DataMonster** marketplace, install `datamonster`, and start a new session. The Codex plugin bundles the skills; add the MCP server with the `config.toml` snippet above.

## Security notes

- Treat `DATAMONSTER_TOKEN` like a password. Keep it out of git, chat and shell history. Revoke and re-create it if it leaks.
- Prefer a read-only token. Grant the write scope only when you want an agent to create links, annotations or launches. When an app connects with sign-in, leave write unticked unless you need it.
- Every call, including failed ones, is in the activity log on the Agents page.
- Agents are told to treat everything visitors can type as data. Still, do not ask an agent to open URLs or run commands it found inside analytics data. Listing pages are fetched by DataMonster itself, never by the agent.
