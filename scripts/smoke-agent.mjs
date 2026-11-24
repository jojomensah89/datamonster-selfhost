// Isolated, real-Worker integration smoke test. Node 20+, no account access.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();
const temp = await mkdtemp(join(tmpdir(), 'datamonster-agent-'));
const children = new Set();
const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS: 'false', WRANGLER_SEND_METRICS: 'false', CI: 'true' };
let logs = '', base, cookie = '', secret = '', failures = 0, interrupted = false;
function launch(file, args) {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.add(child);
  child.done = new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code) => res(code)); });
  child.done.catch(() => {});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-24000); });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) { children.delete(child); return; }
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (killed.status !== 0 && child.exitCode === null) throw new Error(`taskkill failed: ${killed.stderr || killed.stdout}`);
  } else process.kill(-child.pid, 'SIGKILL');
  await child.done;
  children.delete(child);
}
async function run(file, args, timeout = 120000) {
  const child = launch(file, args);
  const timer = setTimeout(() => { void stop(child); }, timeout);
  try { if (await child.done !== 0) throw new Error(`Command failed: ${file} ${args.join(' ')}\n${logs}`); }
  finally { clearTimeout(timer); }
}
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const child of [...children]) await stop(child);
    await rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    console.log('PASS cleanup: all owned process trees stopped; temporary state deleted');
  })();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => {
  interrupted = true;
  void cleanup().then(() => process.exit(130), e => { console.error('FAIL cleanup:', e); process.exit(1); });
});
function redact(value) {
  return String(value).replaceAll(secret || '\0', '[agent secret]').replace(/dm_[\w-]+/g, '[site key]').replace(/dm_[\w-]+/g, '[agent secret]');
}
async function request(path, { method = 'GET', body, auth = 'none', headers = {} } = {}) {
  const res = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: {
    'content-type': 'application/json', ...(auth === 'dashboard' ? { cookie } : auth === 'agent' ? { authorization: `Bearer ${secret}` } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, evidence: `${method} ${path}${body === undefined ? '' : ` body=${redact(JSON.stringify(body))}`} -> ${res.status} ${redact(text)} location=${res.headers.get('location') ?? ''}` };
}
function expect(r, condition) { if (!condition) throw new Error(r.evidence); return r.data; }
async function check(name, fn) {
  if (interrupted) throw new Error('Interrupted');
  try { const data = await fn(); console.log(`PASS ${name}`); return data; }
  catch (e) { failures++; console.error(`FAIL ${name}: ${redact(e.message)}`); return undefined; }
}
let rpcId = 0;
const rpc = (method, params = {}, notification = false, auth = 'agent') => request('/api/agent/mcp', { method: 'POST', auth, body: { jsonrpc: '2.0', ...(!notification ? { id: ++rpcId } : {}), method, params } });
async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  expect(r, r.status === 200 && r.data.result?.isError === false && !r.data.error);
  return { ...r, data: r.data.result.structuredContent };
}
try {
  const port = await new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  if (port === 8787) throw new Error('Reserved port selected; rerun');
  base = `http://127.0.0.1:${port}`;
  const config = join(temp, 'wrangler.json');
  // Use an isolated configuration: no user secrets, cron triggers or remote bindings.
  await writeFile(config, JSON.stringify({ name: 'datamonster-agent-smoke', main: join(root, 'src/worker/index.ts'), compatibility_date: '2025-09-01', assets: { directory: join(temp, 'dist'), binding: 'ASSETS', not_found_handling: 'none', run_worker_first: ['/api/*'] }, d1_databases: [{ binding: 'DB', database_name: 'datamonster', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: join(root, 'migrations') }] }));
  const password = randomBytes(24).toString('hex');
  await run(join(root, 'node_modules/vite/bin/vite.js'), ['build', '--outDir', join(temp, 'dist')]);
  console.log('PASS isolated build');
  const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
  const common = ['--config', config];
  await run(wrangler, ['d1', 'migrations', 'apply', 'datamonster', '--local', '--persist-to', join(temp, 'state'), ...common]);
  console.log('PASS local migrations');
  const worker = launch(wrangler, ['dev', '--local', '--persist-to', join(temp, 'state'), '--port', String(port), '--ip', '127.0.0.1', '--var', `ADMIN_PASSWORD:${password}`, '--var', `SESSION_SECRET:${randomBytes(32).toString('hex')}`, ...common]);
  const deadline = Date.now() + 60000;
  for (;;) {
    if (worker.exitCode !== null || Date.now() > deadline) throw new Error(`Worker startup failed\n${logs}`);
    try { if ((await request('/api/auth/me')).status < 500) break; } catch {}
    await new Promise(res => setTimeout(res, 250));
  }
  console.log(`PASS Worker ready on ${base}`);
  const login = await check('dashboard login', async () => { const r = await request('/api/auth/login', { method: 'POST', body: { password } }); expect(r, r.status === 200 && r.headers.has('set-cookie')); cookie = r.headers.get('set-cookie').split(';')[0]; return true; });
  if (!login) throw new Error('Cannot seed without dashboard login');
  const site = await check('create site and read dmk_ key', async () => { const r = await request('/api/sites', { method: 'POST', auth: 'dashboard', body: { domain: 'agent-smoke.example', name: 'Agent smoke', timezone: 'UTC', currency: 'USD' } }); return expect(r, r.status === 200 && r.data.id && r.data.api_key?.startsWith('dmk_')); });
  if (!site) throw new Error('Cannot continue without site');
  const vid = randomUUID(), sid = randomUUID();
  for (const [name, visitor, session, referrer] of [['X', vid, sid, 'https://t.co/smoke'], ['Google', randomUUID(), randomUUID(), 'https://www.google.com/']]) await check(`public tracker visit from ${name}`, async () => { const r = await request('/api/event', { method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' }, body: { w: site.id, t: 'pageview', u: 'https://agent-smoke.example/', r: referrer, vid: visitor, sid: session, sw: 1440 } }); expect(r, r.status === 202); });
  await check('generic payment attributed', async () => { const r = await request('/api/v1/payments', { method: 'POST', headers: { authorization: `Bearer ${site.api_key}` }, body: { transaction_id: 'smoke-payment', amount: 12.34, currency: 'USD', visitor_id: vid } }); expect(r, r.status === 200 && r.data.attributed === true); });
  const token = await check('create read+write agent token', async () => { const r = await request('/api/agent-tokens', { method: 'POST', auth: 'dashboard', body: { name: 'Smoke', scopes: ['read', 'write'], site_ids: [site.id] } }); return expect(r, r.status === 201 && r.data.secret && r.data.token?.id); });
  if (!token) throw new Error('Cannot continue without agent token');
  secret = token.secret;
  const query = `site_id=${site.id}&period=today`;
  const rest = path => request('/api/agent/v1/' + path, { auth: 'agent' });
  await check('REST list_sites', async () => { const r = await rest('list_sites'); expect(r, r.status === 200 && r.data.sites?.some(s => s.id === site.id)); });
  await check('REST get_overview: 2 visitors, 1234 revenue', async () => { const r = await rest(`get_overview?${query}`); expect(r, r.status === 200 && r.data.data?.current?.visitors === 2 && r.data.data.current.revenue === 1234); });
  const sourceOK = r => r.status === 200 && r.data.data?.rows?.some(row => row.label === 'X' && row.revenue === 1234) && r.data.data.rows.some(row => row.label === 'Google' && row.revenue === 0);
  await check('REST get_breakdown: revenue credited to X', async () => { const r = await rest(`get_breakdown?${query}&dimension=source`); expect(r, sourceOK(r)); });
  await check('OpenAPI document', async () => { const r = await request('/api/agent/v1/openapi.json'); expect(r, r.status === 200 && r.data.openapi && r.data.paths); });
  await check('MCP initialize', async () => { const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }); expect(r, r.status === 200 && r.data.result?.protocolVersion === '2025-06-18' && r.data.result.capabilities.tools); });
  await check('MCP initialized notification: 202', async () => { const r = await rpc('notifications/initialized', {}, true); expect(r, r.status === 202); });
  await check('MCP tools/list includes write tools', async () => { const r = await rpc('tools/list'); expect(r, r.status === 200 && ['create_link', 'add_placement'].every(n => r.data.result?.tools?.some(t => t.name === n && t.annotations?.readOnlyHint === false))); });
  await check('MCP get_breakdown: revenue credited to X', async () => { const r = await tool('get_breakdown', { site_id: site.id, period: 'today', dimension: 'source' }); expect(r, sourceOK(r)); });
  const link = await check('MCP create_link', async () => { const r = await tool('create_link', { site_id: site.id, ref: 'agent-smoke', path: '/pricing' }); return expect(r, r.data.data?.url === 'https://agent-smoke.example/pricing?ref=agent-smoke'); });
  await check('MCP list_links contains created link', async () => { const r = await tool('list_links', { site_id: site.id, period: 'today' }); expect(r, !!link && r.data.data?.links?.some(item => item.id === link.data.link.id && item.ref === 'agent-smoke')); });
  await check('MCP add_placement', async () => { const r = await tool('add_placement', { site_id: site.id, name: 'Smoke directory', match_ref: 'agent-smoke', status: 'draft' }); expect(r, r.data.data?.placement?.name === 'Smoke directory' && r.data.data.placement.match_ref === 'agent-smoke'); });
  await check('OAuth protected resource discovery', async () => { const r = await request('/.well-known/oauth-protected-resource'); expect(r, r.status === 200 && r.data.resource === base + '/api/agent/mcp' && r.data.authorization_servers?.includes(base)); });
  await check('OAuth authorization server discovery', async () => { const r = await request('/.well-known/oauth-authorization-server'); expect(r, r.status === 200 && r.data.issuer === base && r.data.registration_endpoint === base + '/oauth/register'); });
  await check('MCP without token: 401 resource_metadata challenge', async () => { const r = await rpc('tools/list', {}, false, 'none'); expect(r, r.status === 401 && r.headers.get('www-authenticate')?.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource"`)); });
  const redirect = 'http://127.0.0.1:34567/callback';
  const client = await check('OAuth dynamic client registration', async () => { const r = await request('/oauth/register', { method: 'POST', body: { client_name: 'Smoke', redirect_uris: [redirect], token_endpoint_auth_method: 'none' } }); return expect(r, r.status === 201 && r.data.client_id && r.data.redirect_uris?.includes(redirect)); });
  await check('OAuth authorize redirects to consent', async () => { if (!client) throw new Error('Registration prerequisite failed'); const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'read write', resource: base + '/api/agent/mcp', code_challenge: createHash('sha256').update(randomBytes(32).toString('hex')).digest('base64url'), code_challenge_method: 'S256', state: randomUUID() }); const r = await request('/oauth/authorize?' + q); expect(r, r.status === 302 && r.headers.get('location')?.startsWith('/oauth/consent?')); });
  await check('revoke agent token', async () => { const r = await request('/api/agent-tokens/' + token.token.id, { method: 'DELETE', auth: 'dashboard' }); expect(r, r.status === 200 && r.data.ok === true); });
  await check('revoked token rejected by MCP: 401', async () => { const r = await rpc('tools/list'); expect(r, r.status === 401); });
} catch (e) { failures++; console.error(`FAIL setup/run: ${redact(e.message)}`); }
finally {
  try { await cleanup(); } catch (e) { failures++; console.error('FAIL cleanup:', e.message, 'temporary directory:', temp); }
  console.log(`${failures ? 'FAIL' : 'PASS'} agent smoke: ${failures} failure(s), ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exitCode = failures ? 1 : 0;
}
