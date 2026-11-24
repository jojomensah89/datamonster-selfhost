// End-to-end check of hosted mode against `wrangler dev`, with dummy Google and Polar values:
//   npx wrangler dev --port 8788 --var HOSTED_MODE:true --var GOOGLE_CLIENT_ID:test --var GOOGLE_CLIENT_SECRET:test \
//     --var ADMIN_EMAILS:owner@example.com --var SESSION_SECRET:any-long-random-string --var POLAR_ENVIRONMENT:sandbox \
//     --var POLAR_ACCESS_TOKEN:not-a-real-token --var POLAR_PRODUCT_ID:prod_test --var POLAR_WEBHOOK_SECRET:whsec_dGVzdC1iaWxsaW5nLXNlY3JldA==
// Accounts and sessions are made directly in the local database. Nothing is bought, and Polar is asked once with the dummy token.
// Extra `wrangler d1` flags (such as --persist-to) go in D1_FLAGS.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788';
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'any-long-random-string';
const KEY = Buffer.from('dGVzdC1iaWxsaW5nLXNlY3JldA==', 'base64');
const PRODUCT = 'prod_test';
const assert = (cond, msg) => {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok -', msg);
};
const sql = (q) => execSync(`npx wrangler d1 execute datamonster --local ${process.env.D1_FLAGS ?? ''} --command ${JSON.stringify(q)}`, { stdio: 'ignore' });
const run = crypto.randomUUID().slice(0, 6);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const DAY = 86_400_000;

function session(userId) {
  const id = crypto.randomUUID().replaceAll('-', '');
  const value = `u:${userId}.${id}.${now + DAY}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64').replace(/=+$/, '');
  return { row: `('${id}', 'u:${userId}', ${now}, ${now + DAY})`, cookie: `dm_auth=${encodeURIComponent(`${value}.${sig}`)}` };
}
async function call(path, { cookie = '', method = 'GET', json } = {}) {
  const res = await fetch(BASE + path, { method, redirect: 'manual', headers: { cookie, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, location: res.headers.get('location') };
}
async function polar(event, key = KEY) {
  const body = JSON.stringify(event);
  const id = 'msg_' + crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return fetch(BASE + '/api/billing/webhook', { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body });
}
const state = (user, id, at, o = {}) => ({ id, status: 'active', product_id: PRODUCT, created_at: iso(0), modified_at: iso(at), current_period_end: iso(28 * DAY), cancel_at_period_end: false, ends_at: null, customer: { external_id: user }, ...o });
const order = (user, subId, id, type, at) => ({ type: 'order.' + type, data: { id, status: type, paid: true, product_id: PRODUCT, subscription_id: subId, created_at: iso(at), customer: { external_id: user }, subscription: state(user, subId, at) } });

const [alice, bob, owner] = ['alice', 'bob', 'owner'].map((n) => `${n}_${run}`);
const [A, B, O] = [alice, bob, owner].map(session);
sql(`DELETE FROM users WHERE email = 'owner@example.com'; INSERT INTO users (id, email, name, created_at) VALUES ('${alice}', 'alice-${run}@example.com', 'Alice', ${now}), ('${bob}', 'bob-${run}@example.com', 'Bob', ${now}), ('${owner}', 'owner@example.com', 'Owner', ${now}); INSERT INTO auth_sessions (id, subject, created_at, expires_at) VALUES ${[A, B, O].map((s) => s.row).join(', ')}`);
const plan = async (s) => (await call('/api/auth/me', { cookie: s.cookie })).body.user;

let r = await call('/api/auth/me');
assert(r.body.hosted === true && r.body.loggedIn === false, 'hosted mode, signed out');
r = await call('/api/public/plan');
assert(r.body.hosted && r.body.checkout && r.body.price === '$5', `on sale at ${r.body.price} a ${r.body.interval}`);
r = await call('/api/auth/google');
assert(r.status === 302 && r.location.startsWith('https://accounts.google.com/') && r.location.includes('client_id=test'), 'Google sign-in redirect');
r = await call('/api/auth/login', { method: 'POST', json: { password: 'change-me' } });
assert(r.status === 400, 'password login is off in hosted mode');

r = await plan(A);
assert(!r.paid && r.events_limit === 5000 && r.sites_limit === 1, 'Alice is signed in, on Free');
r = await call('/api/sites', { cookie: A.cookie, method: 'POST', json: { domain: 'alice-site.com' } });
assert(r.status === 200, 'Free adds a site');
const site = r.body.id;
assert((await call('/api/sites', { cookie: A.cookie, method: 'POST', json: { domain: 'alice-two.com' } })).status === 402, 'but not a second one');
r = await call('/api/billing/checkout', { cookie: A.cookie });
assert(r.status === 302 && r.location === '/billing?error=checkout', 'a refused checkout comes back to Billing');

assert((await polar({ type: 'subscription.active', data: state(alice, 'sub_' + run, 0, { product_id: 'other' }) })).ok && !(await plan(A)).paid, 'another product changes nothing');
assert((await polar({ type: 'subscription.active', data: state(alice, 'sub_' + run, 0) }, Buffer.from('wrong'))).status === 401, 'a bad signature is refused');
await polar({ type: 'subscription.active', data: state(alice, 'sub_' + run, 0) });
await polar(order(alice, 'sub_' + run, 'ord_' + run, 'paid', 0));
assert((await plan(A)).paid === true, 'a subscription opens the plan');
assert((await call('/api/billing/checkout', { cookie: A.cookie })).location === '/billing', 'a paid account is not sent to checkout again');

assert((await call('/api/sites', { cookie: A.cookie, method: 'POST', json: { domain: 'alice-two.com' } })).status === 200, 'Pro adds a second site');
await polar({ type: 'subscription.active', data: state(bob, 'sub_b' + run, 0) });
assert((await plan(B)).paid === true, 'Bob pays too');
assert((await call(`/api/sites/${site}`, { cookie: B.cookie })).status === 404, "Bob can't open Alice's site");
assert((await call('/api/sites', { cookie: B.cookie })).body.length === 0, "Bob's list is empty");
const own = await plan(O);
assert(own.admin && own.paid, 'the owner is free');
assert(!(await call('/api/sites', { cookie: O.cookie })).body.some((s) => s.id === site), "the owner doesn't see customers' sites");

const event = () => fetch(BASE + '/api/event', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/129 Safari/537.36' }, body: JSON.stringify({ w: site, u: 'https://alice-site.com/', t: 'pageview', vid: crypto.randomUUID(), sid: crypto.randomUUID() }) });
await event();
assert((await call(`/api/sites/${site}/overview?period=today`, { cookie: A.cookie })).body.current.visitors === 1, 'visits are recorded');

await polar({ type: 'subscription.canceled', data: state(alice, 'sub_' + run, 1000, { cancel_at_period_end: true, ends_at: iso(28 * DAY) }) });
assert((await plan(A)).plan_status === 'cancelled' && (await plan(A)).paid, 'cancelling keeps the paid time');
await polar({ type: 'subscription.uncanceled', data: state(alice, 'sub_' + run, 2000) });
await polar({ type: 'subscription.past_due', data: state(alice, 'sub_' + run, 3000, { status: 'past_due', past_due_at: iso(0) }) });
let p = await plan(A);
assert(p.plan_status === 'past_due' && p.paid && p.plan_until < now + 4 * DAY, 'a failed renewal keeps access for three days');
await polar({ type: 'subscription.updated', data: state(alice, 'sub_' + run, 4000) });
await polar(order(alice, 'sub_' + run, 'ord_' + run, 'refunded', 0));
p = await plan(A);
assert(p.plan_status === 'refunded' && !p.paid, 'a full refund ends the plan');
await polar({ type: 'subscription.updated', data: state(alice, 'sub_' + run, 5000) });
assert((await plan(A)).paid === false, 'and stays ended');
r = await call('/api/billing/usage', { cookie: A.cookie });
assert(r.body.total === 1 && r.body.sites.length === 2, 'the month is still there');
assert((await call(`/api/sites/${site}/overview`, { cookie: A.cookie })).status === 200, 'and so is the dashboard');
assert((await plan(B)).paid === true, 'Bob is unaffected');
await polar(order(alice, 'sub_' + run, 'ord2_' + run, 'paid', 6000));
assert((await plan(A)).paid === true, 'a new payment opens it again');
await polar({ type: 'subscription.revoked', data: state(alice, 'sub_' + run, 7000, { status: 'canceled' }) });
assert((await plan(A)).plan_status === 'expired', 'the end of the subscription ends the plan');

await call('/api/auth/logout', { cookie: B.cookie, method: 'POST' });
assert((await call('/api/auth/me', { cookie: B.cookie })).body.loggedIn === false, 'signing out ends the session');
assert((await call(`/api/sites/${site}`, { cookie: A.cookie, method: 'DELETE' })).status === 200, 'an ended account can still delete its site');

sql(`DELETE FROM users WHERE id IN ('${alice}', '${bob}', '${owner}'); DELETE FROM plan_subscriptions WHERE user_id IN ('${alice}', '${bob}'); DELETE FROM auth_sessions WHERE subject IN ('u:${alice}', 'u:${bob}', 'u:${owner}')`);
console.log('\nAll hosted-mode checks passed');
