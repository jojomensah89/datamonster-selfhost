import { ChevronDown as DisclosureChevron } from 'lucide-react';
import { Checkbox } from '../components/primitives/checkbox';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../components/primitives/collapsible';
import { Button } from '../components/primitives/button';
import { Input } from '../components/primitives/input';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { WRITE_CAPABILITIES } from '../../agent/write-capabilities';
import { CopyIcon, CopyRow } from '../components/CopyIcon';
import { BlockError, EmptyRow, Icon, TitleRow, useToast } from '../components/ui';
import { api, type Site } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { useApi } from '../lib/useApi';

type Scope = 'read' | 'write';

interface AgentToken {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  site_ids: string[] | null;
  created_at: number;
  last_used_at: number | null;
  /** Set when the assistant connected itself with "sign in and Allow" (OAuth) instead of a pasted token. */
  oauth_client_id?: string | null;
}

interface AuditRow {
  id?: number;
  ts: number;
  tool: string;
  site_id: string | null;
  args: string | null;
  write: number | boolean;
  ok: number | boolean;
  token_id: string;
}

/** Plain names for the agent tools. Unknown tools fall back to their name in words. */
const TOOL_LABELS: Record<string, string> = {
  list_sites: 'Listed sites',
  get_overview: 'Read the overview',
  get_breakdown: 'Read a breakdown',
  get_customers: 'Read customers',
  get_visitors: 'Read visitors',
  get_visitor: 'Read a visitor journey',
  list_funnels: 'Listed funnels',
  get_funnel: 'Read funnel results',
  get_realtime: 'Read realtime',
  get_guide: 'Read the guide',
  list_links: 'Read tracked links',
  create_link: 'Created a tracked link',
  list_annotations: 'Read notes',
  add_annotation: 'Added a note',
  add_placement: 'Added a launch',
  update_placement: 'Updated a launch',
  verify_placement: 'Checked a launch listing',
  list_placements: 'Read launches',
  list_directories: 'Read launch directories',
};
const toolLabel = (t: string) => TOOL_LABELS[t] ?? t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const READ_TOOLS = 'Overview, sources and breakdowns, customers, visitors and their journeys, funnels, realtime, tracked links, notes and launches.';
/** The environment variable every copyable snippet reads the token from, so no secret ever sits in a prompt or a config file. */
const TOKEN_ENV = 'DATAMONSTER_TOKEN';

/** Exactly what write access allows, from the same list the agent guide and the consent screen use. */
function WriteList({ className = '' }: { className?: string }) {
  return (
    <ul className={`list-disc space-y-0.5 pl-5 text-muted marker:text-faint ${className}`}>
      {WRITE_CAPABILITIES.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  );
}

function when(ts: number) {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
}

function argsSummary(raw: string | null): string {
  if (!raw) return '';
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(a)
      .filter(([k, v]) => k !== 'site_id' && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
  } catch {
    return '';
  }
}

export function Agents() {
  const origin = window.location.origin;
  const mcpUrl = `${origin}/api/agent/mcp`;
  const openapiUrl = `${origin}/api/agent/v1/openapi.json`;
  const [reload, setReload] = useState(0);
  const tokens = useApi<AgentToken[]>('/api/agent-tokens', reload);
  const audit = useApi<AuditRow[]>('/api/agent-audit', reload);
  const { data: sites } = useApi<Site[]>('/api/sites');
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const toast = useToast();

  return (
    <div>
      <TitleRow title="Agents and MCP" />

      <Setting
        title="Connect an assistant"
        desc={
          <>
            In Claude.ai or ChatGPT, add the MCP URL as a connector, then sign in and click Allow: no token to handle. Claude Code, Cursor and other MCP clients use a token you create below, read from the {TOKEN_ENV} environment variable. The REST API serves the same tools for scripts.
          </>
        }
        first
      >
        <Connect mcpUrl={mcpUrl} openapiUrl={openapiUrl} origin={origin} secret={fresh?.secret} onCopied={toast.show} />
      </Setting>

      <Setting title="Tokens">
        <CreateToken
          sites={sites}
          onCreated={(name, secret) => {
            setFresh({ name, secret });
            setReload((r) => r + 1);
          }}
        />
        {fresh && <SecretOnce name={fresh.name} secret={fresh.secret} onDone={() => setFresh(null)} />}
        <TokenList
          state={tokens}
          sites={sites ?? []}
          onRetry={() => setReload((r) => r + 1)}
          onRevoked={(name) => {
            toast.show(`${name} revoked`);
            setReload((r) => r + 1);
          }}
          onError={(m) => toast.show(m, true)}
        />
      </Setting>

      <Setting title="What agents may do">
        <div className="well px-4 py-1">
          <Rule title="Read" status={<span className="pill">Every token</span>}>
            {READ_TOOLS}
          </Rule>
          <Rule title="Write" status={<span className="pill pill-info">Tokens you choose</span>}>
            Only on tokens and connections you allow it for. Exactly this, each call logged below:
            <WriteList className="mt-1" />
          </Rule>
          <Rule title="Admin" status={<span className="pill pill-neg">Never</span>}>
            Payment keys, API keys, agent tokens, site settings and deleting data stay with you, in this dashboard. No token can be granted this.
          </Rule>
        </div>
      </Setting>

      <Setting title="Activity log">
        <ActivityLog state={audit} tokens={tokens.data ?? []} sites={sites ?? []} onRetry={() => setReload((r) => r + 1)} />
      </Setting>

      {toast.node}
    </div>
  );
}

/** Settings layout: a label column on the left, the work on the right; stacked on a phone. */
function Setting({ title, desc, children, first }: { title: string; desc?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section className={`grid gap-3 py-7 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:gap-8 ${first ? 'pt-2' : 'border-t border-line'}`}>
      <div>
        <h2 className="text-base font-semibold lg:mt-1">{title}</h2>
        {desc && <p className="mt-1 max-w-[42ch] text-muted">{desc}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Rule({ title, status, children }: { title: string; status: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-rule py-3 [&+&]:border-t">
      <div className="min-w-0 flex-1 basis-[280px]">
        <b className="font-medium">{title}</b>
        <p className="mt-0.5 max-w-[60ch] text-muted">{children}</p>
      </div>
      {status}
    </div>
  );
}

type Client = 'connector' | 'claude' | 'cursor' | 'other' | 'rest';
const CLIENTS: { id: Client; label: string }[] = [
  { id: 'connector', label: 'Claude.ai or ChatGPT' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'other', label: 'Other MCP clients' },
  { id: 'rest', label: 'REST API' },
];

/** A code block with a small header bar, so the copy button never covers the code. */
function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="rounded-xl bg-code dark:border dark:border-line">
      <div className="flex items-center justify-between gap-3 border-b border-codeInk/10 py-1.5 pl-4 pr-1.5">
        <span className="font-mono text-xs text-codeMuted">{label}</span>
        <CopyIcon text={code} what={label} className="icon-btn-code" />
      </div>
      <pre className="whitespace-pre-wrap p-4 font-mono text-[13px] leading-relaxed text-codeInk [overflow-wrap:anywhere]">{code}</pre>
    </div>
  );
}

function Connect({ mcpUrl, openapiUrl, origin, secret, onCopied }: { mcpUrl: string; openapiUrl: string; origin: string; secret?: string; onCopied: (m: string) => void }) {
  const [client, setClient] = useState<Client>('connector');
  const mcpJson = (header: string) => JSON.stringify({ mcpServers: { datamonster: { url: mcpUrl, headers: { Authorization: header } } } }, null, 2);
  // Each client's own way of reading an environment variable; none of these snippets holds the token itself.
  const snippets: Record<Exclude<Client, 'connector'>, { label: string; code: string; note: ReactNode }> = {
    claude: {
      label: 'Terminal',
      code: `claude mcp add --transport http datamonster ${mcpUrl} \\\n  --scope project --header 'Authorization: Bearer \${${TOKEN_ENV}}'`,
      note: (
        <>
          Single quotes keep <code className="font-mono">{`\${${TOKEN_ENV}}`}</code> literal: Claude Code writes it to the project's <code className="font-mono">.mcp.json</code> and reads the variable each time it starts, so the file is safe to commit.
        </>
      ),
    },
    cursor: {
      label: '.cursor/mcp.json',
      code: mcpJson(`Bearer \${env:${TOKEN_ENV}}`),
      note: <>Cursor fills in <code className="font-mono">{`\${env:${TOKEN_ENV}}`}</code> from your environment. Use .cursor/mcp.json in a project, or ~/.cursor/mcp.json for every project.</>,
    },
    other: {
      label: 'MCP config (JSON)',
      code: mcpJson(`Bearer \${${TOKEN_ENV}}`),
      note: <>Most clients take this shape and expand <code className="font-mono">{`\${${TOKEN_ENV}}`}</code>. The server speaks Streamable HTTP: JSON-RPC over POST, no stream.</>,
    },
    rest: {
      label: 'curl',
      code: `curl ${origin}/api/agent/v1/list_sites \\\n  -H "Authorization: Bearer $${TOKEN_ENV}"`,
      note: (
        <>
          Every MCP tool is also a REST endpoint. The full description is at{' '}
          <a className="card-link font-mono text-[13px] font-normal" href={openapiUrl} target="_blank" rel="noreferrer">
            /api/agent/v1/openapi.json
          </a>
          .
        </>
      ),
    },
  };

  const prompt = `Connect to my DataMonster analytics so you can answer questions about my websites, visitors and revenue.

- MCP server (Streamable HTTP, JSON-RPC over POST): ${mcpUrl}
- REST alternative with the same tools: ${openapiUrl}

How to authenticate:
- If you are a chat app such as Claude.ai or ChatGPT: add ${mcpUrl} as a custom connector. I will sign in and click Allow; no token is needed.
- Otherwise, send Authorization: Bearer <token> on every call, reading the token from the environment variable ${TOKEN_ENV}. I create it at ${origin}/agents and store it there myself.
- Never ask me to paste the token into this chat, and never write it into a file. If ${TOKEN_ENV} is not set, tell me to set it and stop.

If you are Claude Code, add the server with (single quotes keep the variable unexpanded, so .mcp.json holds no secret):
claude mcp add --transport http datamonster ${mcpUrl} --scope project --header 'Authorization: Bearer \${${TOKEN_ENV}}'

Once connected, call get_guide first, then list_sites to find my site ids. Answer from the tools only and never guess a number. If a tool says it needs write access, tell me instead of retrying.`;

  return (
    <div className="well p-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <CopyRow label="Setup prompt" value={prompt} shown={prompt.split('\n')[0]} what="the setup prompt" mono={false} onCopied={() => onCopied('Setup prompt copied. It holds no token.')} />
        <CopyRow label="MCP server URL" value={mcpUrl} what="the MCP server URL" onCopied={() => onCopied('MCP URL copied')} />
      </div>

      <div className="mt-5 overflow-x-auto pb-0.5">
        <div className="tabs" role="tablist" aria-label="Client">
          {CLIENTS.map((c) => (
            <Button variant="raw" size="raw" key={c.id} type="button" role="tab" aria-selected={client === c.id} className={`tab whitespace-nowrap ${client === c.id ? 'tab-active' : ''}`} onClick={() => setClient(c.id)}>
              {c.label}
            </Button>
          ))}
        </div>
      </div>
      {client === 'connector' ? (
        <div className="mt-3 rounded-xl border border-line bg-surface p-4">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            Sign in and Allow <span className="pill pill-pos">Recommended</span>
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted marker:text-faint">
            <li>In Claude.ai or ChatGPT, open the connector settings and add a custom connector.</li>
            <li>Paste the MCP server URL above.</li>
            <li>Sign in to DataMonster when it asks, choose the sites and whether it may make changes, then click Allow.</li>
          </ol>
          <p className="mt-2 text-xs text-muted">No token to copy or store. The connection shows in Active tokens below, marked "Connected with sign-in", and you can revoke it there.</p>
        </div>
      ) : (
        <>
          <div className="mt-3">
            <Snippet label={snippets[client].label} code={snippets[client].code} />
          </div>
          <p className="mt-2 text-xs text-muted">{snippets[client].note}</p>
          {client !== 'rest' && <InlinedConfig mcpUrl={mcpUrl} secret={secret} />}
        </>
      )}
    </div>
  );
}

/** For a client that can't read environment variables: a config with the token in it, kept local and out of git. */
function InlinedConfig({ mcpUrl, secret }: { mcpUrl: string; secret?: string }) {
  const code = JSON.stringify({ mcpServers: { datamonster: { url: mcpUrl, headers: { Authorization: `Bearer ${secret ?? 'PASTE_YOUR_TOKEN_HERE'}` } } } }, null, 2);
  return (
    <Collapsible className="mt-4 text-sm">
      <CollapsibleTrigger asChild><Button variant="raw" size="raw" type="button" className="cursor-pointer font-medium text-ink">Client can't read environment variables? Local config with the token inlined<DisclosureChevron className="disclosure-chevron ml-2 inline-block h-4 w-4" aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent>
      <p className="mt-2 max-w-[65ch] text-muted">
        Only for a config file that stays on this computer. Add the file to .gitignore, never commit or share it, and revoke the token if it leaks.
        {secret ? ' It holds the token you just created.' : ' Replace the placeholder with your token.'}
      </p>
      <div className="mt-2">
        <Snippet label="Local MCP config, token inlined" code={code} />
      </div>
    </CollapsibleContent></Collapsible>
  );
}

function CreateToken({ sites: loaded, onCreated }: { sites: Site[] | null; onCreated: (name: string, secret: string) => void }) {
  const sites = loaded ?? [];
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  // null until the owner picks: with exactly one site the default is that site only, never "all, including future ones".
  const [limitChoice, setLimit] = useState<boolean | null>(null);
  const limit = limitChoice ?? sites.length === 1;
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const ids = sites.length === 1 ? [sites[0].id] : picked;
    if (limit && !ids.length) return setError('Pick at least one site, or allow all current and future sites.');
    setBusy(true);
    try {
      const label = name.trim() || 'Agent';
      const r = await api<{ token: AgentToken; secret: string }>('/api/agent-tokens', {
        method: 'POST',
        json: { name: label, scopes: write ? ['read', 'write'] : ['read'], ...(limit ? { site_ids: ids } : {}) },
      });
      onCreated(r.token.name, r.secret);
      setName('');
      setWrite(false);
      setLimit(null);
      setPicked([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const choice = (on: boolean, title: string, desc: string, onClick: () => void) => (
    <Button variant="raw" size="raw"
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`flex min-w-0 flex-1 basis-[200px] items-start gap-2.5 rounded-xl border bg-surface px-3 py-2.5 text-left transition-colors duration-150 ${
        on ? 'border-accent outline outline-1 -outline-offset-2 outline-accent' : 'border-line hover:border-control'
      }`}
    >
      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${on ? 'border-accent' : 'border-control'}`}>
        {on && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0">
        <b className="block font-medium">{title}</b>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </Button>
  );

  return (
    <form onSubmit={submit} className="well p-4">
      <label className="label" htmlFor="token-name">
        Name
      </label>
      <Input id="token-name" className="input max-w-sm" placeholder="Claude Code on my laptop" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />

      <p className="label mt-4" id="access-label">
        Access
      </p>
      <div role="radiogroup" aria-labelledby="access-label" className="flex flex-wrap gap-2">
        {choice(!write, 'Read only', 'Answers questions. Changes nothing.', () => setWrite(false))}
        {choice(write, 'Read and write', 'Also makes the changes listed below.', () => setWrite(true))}
      </div>
      <div className={`mt-2 rounded-xl px-3 py-2.5 text-sm ${write ? 'bg-surface' : ''}`}>
        <p className={write ? 'font-medium' : 'text-muted'}>{write ? 'With write, this token may:' : 'Write would let it:'}</p>
        <WriteList className="mt-1" />
      </div>

      <p className="label mt-4" id="sites-label">
        Sites
      </p>
      {!loaded ? (
        <div className="skeleton h-14 rounded-xl" aria-label="Loading sites" />
      ) : (
        <>
          <div role="radiogroup" aria-labelledby="sites-label" className="flex flex-wrap gap-2">
            {sites.length === 1
              ? choice(limit, 'This site only', `${sites[0].name} (${sites[0].domain}).`, () => setLimit(true))
              : sites.length > 1 && choice(limit, 'Only some sites', 'Pick the sites this token may see.', () => setLimit(true))}
            {choice(
              !limit,
              'All current and future sites',
              sites.length ? `${sites.length === 1 ? sites[0].name : `All ${sites.length} sites`} now, and every site you add later.` : 'Every site you add, now or later.',
              () => setLimit(false),
            )}
          </div>
          {limit && sites.length > 1 && (
            <div className="mt-2 grid gap-1 rounded-xl border border-line bg-surface p-1.5 sm:grid-cols-2">
              {sites.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-raised">
                  <Checkbox

                    className="h-4 w-4 accent-accent"
                    checked={picked.includes(s.id)}
                    onCheckedChange={(checked) => setPicked((p) => ((checked === true) ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                  />
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className="ml-auto truncate text-xs text-faint">{s.domain}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="raw" size="raw" className="btn-dark" disabled={busy}>
          <Icon name="key" size={14} />
          {busy ? 'Creating…' : 'Create token'}
        </Button>
        {error && (
          <p className="text-sm text-negative" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

/** The secret, shown once, right after it is created, on its own: never inside a prompt or a config snippet. */
function SecretOnce({ name, secret, onDone }: { name: string; secret: string; onDone: () => void }) {
  return (
    <div className="anim-sheet mt-3 rounded-2xl border-2 border-accent bg-surface p-4" role="status">
      <b className="font-medium">Token for {name} created</b>
      <p className="mt-0.5 text-muted">Copy it now. It is not shown again; if you lose it, revoke it and create a new one.</p>
      <div className="mt-3 flex items-center gap-3 rounded-xl bg-code py-2 pl-4 pr-2 dark:border dark:border-line">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-codeInk [scrollbar-width:none]">{secret}</code>
        <CopyIcon text={secret} what="the token" className="icon-btn-code" />
      </div>
      <p className="mt-3 max-w-[65ch]">
        Store it as <code className="font-mono text-[13px]">{TOKEN_ENV}</code> in your shell or secret store. <b className="font-medium">Never paste it into a chat</b>; the setup prompt and snippets above read it from that variable.
      </p>
      <ul className="mt-2 space-y-0.5 text-xs text-muted">
        <li>
          macOS or Linux: add <code className="font-mono">export {TOKEN_ENV}="…"</code> to ~/.zshrc or ~/.bashrc, then open a new terminal.
        </li>
        <li>
          Windows: run <code className="font-mono">setx {TOKEN_ENV} "…"</code>, then open a new terminal.
        </li>
      </ul>
      <Button variant="raw" size="raw" type="button" className="btn mt-3" onClick={onDone}>
        I've stored it
      </Button>
    </div>
  );
}

function TokenList({
  state,
  sites,
  onRetry,
  onRevoked,
  onError,
}: {
  state: { data: AgentToken[] | null; error: string | null; loading: boolean };
  sites: Site[];
  onRetry: () => void;
  onRevoked: (name: string) => void;
  onError: (m: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  async function revoke(t: AgentToken) {
    setBusy(t.id);
    try {
      await api(`/api/agent-tokens/${t.id}`, { method: 'DELETE' });
      setConfirming(null);
      onRevoked(t.name);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-5">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-medium">Active tokens</h3>
        {state.data && <span className="text-xs text-faint">{state.data.length}</span>}
      </div>
      {state.error && !state.data && <BlockError what={`Couldn't load tokens: ${state.error}.`} onRetry={onRetry} />}
      {!state.data && !state.error && (
        <div aria-busy="true" aria-label="Loading tokens">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-rule py-3.5 last:border-0">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton ml-auto h-4 w-20" />
            </div>
          ))}
        </div>
      )}
      {state.data?.length === 0 && <EmptyRow>No tokens yet.</EmptyRow>}
      {!!state.data?.length && (
        <ul>
          {state.data.map((t) => {
            const writes = t.scopes.includes('write');
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule py-3 last:border-0">
                <div className="min-w-0 flex-1 basis-[220px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="truncate font-medium">{t.name}</b>
                    <span className={`pill ${writes ? 'pill-info' : ''}`}>{writes ? 'Read and write' : 'Read only'}</span>
                    {t.oauth_client_id && <span className="pill">Connected with sign-in</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {t.oauth_client_id ? 'Renews itself' : <code className="font-mono">{t.prefix}…</code>}
                    {' · '}
                    {t.site_ids ? t.site_ids.map(siteName).join(', ') : 'All current and future sites'}
                    {' · '}created {fmtAgo(Date.now() - t.created_at)} ago
                  </p>
                </div>
                <span className="text-sm text-muted">{t.last_used_at ? `Used ${fmtAgo(Date.now() - t.last_used_at)} ago` : <span className="text-faint">Never used</span>}</span>
                {confirming === t.id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-sm">Revoke {t.name}?</span>
                    <Button variant="raw" size="raw" type="button" className="btn-ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button variant="raw" size="raw" type="button" className="btn-danger" disabled={busy === t.id} onClick={() => revoke(t)} autoFocus>
                      {busy === t.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  </span>
                ) : (
                  <Button variant="raw" size="raw" type="button" className="text-sm font-medium text-negative underline-offset-[3px] hover:underline" onClick={() => setConfirming(t.id)} aria-label={`Revoke ${t.name}`}>
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const LOG_PAGE = 30;

function ActivityLog({
  state,
  tokens,
  sites,
  onRetry,
}: {
  state: { data: AuditRow[] | null; error: string | null; loading: boolean };
  tokens: AgentToken[];
  sites: Site[];
  onRetry: () => void;
}) {
  const [all, setAll] = useState(false);
  const tokenName = useMemo(() => new Map(tokens.map((t) => [t.id, t.name])), [tokens]);
  const siteName = (id: string | null) => (id ? sites.find((s) => s.id === id)?.name ?? null : null);

  if (state.error && !state.data) return <BlockError what={`Couldn't load the activity log: ${state.error}.`} onRetry={onRetry} />;
  if (!state.data)
    return (
      <div aria-busy="true" aria-label="Loading activity">
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-rule py-3 last:border-0">
            <div className="skeleton h-4 w-12" />
            <div className="skeleton h-4 w-2/3" />
          </div>
        ))}
      </div>
    );
  if (!state.data.length) return <EmptyRow>No calls yet.</EmptyRow>;

  const failed = state.data.filter((r) => !r.ok).length;
  const rows = all ? state.data : state.data.slice(0, LOG_PAGE);
  return (
    <div>
      <p className="mb-1 text-xs text-faint">
        {state.data.length} recent {state.data.length === 1 ? 'call' : 'calls'}
        {failed ? `, ${failed} failed` : ''}
      </p>
      <ol>
        {rows.map((r, i) => {
          const args = argsSummary(r.args);
          const site = siteName(r.site_id);
          return (
            <li key={r.id ?? `${r.ts}-${i}`} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-3 border-b border-rule py-2.5 last:border-0 sm:grid-cols-[96px_minmax(0,1fr)_auto]">
              <span className="text-xs text-faint" title={new Date(r.ts).toLocaleString()}>
                {when(r.ts)}
              </span>
              <div className="min-w-0">
                <span className="font-medium">{toolLabel(r.tool)}</span>{' '}
                <code className="font-mono text-xs text-accentInk">{r.tool}</code>
                <span className="block truncate text-xs text-muted">
                  {tokenName.get(r.token_id) ?? 'A revoked token'}
                  {site ? ` · ${site}` : ''}
                  {args ? ` · ${args}` : ''}
                </span>
              </div>
              <span className="col-start-2 flex gap-1.5 sm:col-start-auto">
                {!!r.write && <span className="pill pill-info">Changed data</span>}
                {!r.ok && <span className="pill pill-neg">Failed</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {!all && state.data.length > LOG_PAGE && (
        <Button variant="raw" size="raw" type="button" className="card-link mt-3" onClick={() => setAll(true)}>
          Show all {state.data.length}
          <Icon name="down" size={12} />
        </Button>
      )}
    </div>
  );
}
