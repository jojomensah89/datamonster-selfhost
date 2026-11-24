import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import app from '../src/worker/index';
import { makeD1 } from './helpers/d1';

let db: ReturnType<typeof makeD1>;
const secret = 'whsec_' + Buffer.from('fixture-secret').toString('base64');
const env = () => ({ DB: db.d1, SESSION_SECRET: 'session', ADMIN_PASSWORD: 'pw' });
const UUID = '3f1c2b9e-7a4d-4e8b-9c55-0a1b2c3d4e5f';
const payments = () => db.raw.prepare('SELECT * FROM payments ORDER BY id').all();
const claims = () => db.raw.prepare('SELECT payment_id, visitor_id FROM payment_claims').all();

async function visit(search: string, vid = 'visitor-return') {
  const res = await app.request(
    '/api/event',
    {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36', 'content-type': 'application/json' },
      body: JSON.stringify({ w: 'site-return', t: 'pageview', u: `https://example.com/thanks${search}`, vid, sid: `session-${vid}` }),
    },
    env(),
  );
  expect(res.status).toBe(202);
}

async function polarOrder(checkoutId: string | null, id = 'order-1') {
  const body = JSON.stringify({
    type: 'order.paid',
    timestamp: new Date().toISOString(),
    data: { id, created_at: new Date().toISOString(), total_amount: 1200, currency: 'usd', customer_id: 'customer-1', checkout_id: checkoutId, metadata: {}, customer: { email: 'buyer@example.com', name: 'Buyer' } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`delivery-1.${timestamp}.${body}`).digest('base64');
  const res = await app.request(
    '/api/webhooks/polar/site-return',
    { method: 'POST', headers: { 'webhook-id': 'delivery-1', 'webhook-timestamp': timestamp, 'webhook-signature': signature }, body },
    env(),
  );
  expect(res.status).toBe(200);
}

beforeEach(() => {
  db = makeD1();
  db.raw.prepare("INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at,polar_webhook_secret) VALUES ('site-return','Site','example.com','UTC','USD','key',0,?)").run(secret);
});

describe('Polar return page', () => {
  it('credits the visitor who landed on /thanks?checkout_id= when the webhook has no visitor metadata', async () => {
    await visit(`?checkout_id=${UUID}`);
    expect(claims()).toEqual([{ payment_id: UUID, visitor_id: 'visitor-return' }]);
    await polarOrder(UUID);
    expect(payments()).toHaveLength(1);
    expect(payments()[0]).toMatchObject({ provider: 'polar', visitor_id: 'visitor-return', matched_by: 'return_page', checkout_id: UUID });
    expect(payments()[0].session_id).toBe('session-visitor-return');
  });

  it('links a payment that arrived before the visit', async () => {
    await polarOrder(UUID);
    expect(payments()[0]).toMatchObject({ visitor_id: null });
    await visit(`?checkout_id=${UUID}`);
    expect(payments()[0]).toMatchObject({ visitor_id: 'visitor-return', matched_by: 'return_page' });
  });

  it('matches an upper-case id from the URL', async () => {
    await visit(`?checkout_id=${UUID.toUpperCase()}`);
    await polarOrder(UUID);
    expect(payments()[0]).toMatchObject({ visitor_id: 'visitor-return', matched_by: 'return_page' });
  });

  it.each(['not-a-uuid', `${UUID}x`, UUID.slice(1), `${UUID}%20OR%201=1`, '{CHECKOUT_ID}', ''])('ignores a malformed checkout_id (%s)', async bad => {
    await visit(`?checkout_id=${encodeURIComponent(bad)}`);
    expect(claims()).toEqual([]);
    await polarOrder(UUID);
    expect(payments()[0]).toMatchObject({ visitor_id: null, matched_by: null });
  });

  it('does not accept a UUID in the Dodo/Stripe parameters', async () => {
    await visit(`?payment_id=${UUID}`, 'visitor-a1');
    await visit(`?session_id=${UUID}`, 'visitor-a2');
    expect(claims()).toEqual([]);
  });
});

describe('Dodo and Stripe return pages are unchanged', () => {
  it.each([
    ['payment_id', 'pay_abc123XYZ'],
    ['subscription_id', 'sub_abc123XYZ'],
    ['session_id', 'cs_test_abc123XYZ'],
    ['session_id', 'cs_live_abc123XYZ'],
  ])('claims ?%s=%s', async (param, value) => {
    await visit(`?${param}=${value}`);
    expect(claims()).toEqual([{ payment_id: value, visitor_id: 'visitor-return' }]);
  });

  it.each(['payment_id=abc', 'payment_id=pay_', 'session_id=cs_dev_abc123XYZ', 'subscription_id=xyz_abc123XYZ'])('ignores ?%s', async q => {
    await visit(`?${q}`);
    expect(claims()).toEqual([]);
  });
});
