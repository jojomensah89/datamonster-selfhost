import { describe, expect, it } from 'vitest';
import type { Site } from '../src/worker/env';
import { realtime, REALTIME_LIMITS } from '../src/worker/stats';
import { makeD1 } from './helpers/d1';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const site = { id: 's', name: 'Site', domain: 'example.com', timezone: 'UTC', currency: 'USD' } as Site;

function setup() {
  const db = makeD1();
  db.raw.exec("INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at) VALUES ('s','Site','example.com','UTC','USD','key',0)");
  const session = db.raw.prepare(
    `INSERT INTO sessions (site_id,id,visitor_id,started_at,last_seen_at,source,channel,country,city,lat,lon,exit_page)
     VALUES ('s',?,?,?,?,'Google','Organic Search',?,?,?,?,?)`,
  );
  const payment = db.raw.prepare("INSERT INTO payments (id,site_id,provider,ts,amount,kind,currency,visitor_id,session_id) VALUES (?, 's', 'api', ?, ?, ?, ?, ?, ?)");
  const event = db.raw.prepare("INSERT INTO events (site_id,session_id,visitor_id,ts,type,path) VALUES ('s',?,?,?,'pageview',?)");
  return { db, session, payment, event };
}

describe('realtime', () => {
  it('counts active visitors and countries exactly, by their latest session', async () => {
    const { db, session } = setup();
    // v1 has two active sessions in two countries; only the latest (GB) counts.
    session.run('a1', 'v1', NOW - 20 * MIN, NOW - 4 * MIN, 'GH', 'Accra', 5.6, -0.2, '/');
    session.run('a2', 'v1', NOW - 3 * MIN, NOW - 1 * MIN, 'GB', 'London', 51.5, -0.1, '/pricing');
    session.run('b1', 'v2', NOW - 2 * MIN, NOW - 1 * MIN, 'DE', 'Berlin', 52.5, 13.4, '/docs');
    session.run('c1', 'v3', NOW - 2 * MIN, NOW - 1 * MIN, null, null, null, null, '/');
    // Not active: last seen 6 minutes ago, or a session older than six hours.
    session.run('d1', 'v4', NOW - 30 * MIN, NOW - 6 * MIN, 'FR', 'Paris', 48.8, 2.3, '/');
    session.run('e1', 'v5', NOW - 7 * 60 * MIN, NOW - 1 * MIN, 'US', 'Austin', 30.2, -97.7, '/');

    const r = await realtime(db.d1, site, NOW);
    expect(r.active).toEqual({ visitors: 3, countries: 2, unlocated: 1 });
    expect(r.visitors.map((v: any) => v.visitor_id).sort()).toEqual(['v1', 'v2', 'v3']);
    expect(r.visitors.find((v: any) => v.visitor_id === 'v1')).toMatchObject({ country: 'GB', page: '/pricing' });
    expect(r.truncated).toEqual({ visitors: false, events: false, payments: false });
    expect(r.window).toEqual({ active_ms: 5 * MIN, feed_ms: 30 * MIN, active_since: NOW - 5 * MIN, feed_since: NOW - 30 * MIN });
  });

  it('flags a visitor list cut short while the count stays exact', async () => {
    const { db, session } = setup();
    const n = REALTIME_LIMITS.visitors + 7;
    for (let i = 0; i < n; i++) session.run(`s${i}`, `v${i}`, NOW - 2 * MIN, NOW - MIN + i, 'GH', 'Accra', 5.6, -0.2, '/');
    const r = await realtime(db.d1, site, NOW);
    expect(r.visitors.length).toBe(REALTIME_LIMITS.visitors);
    expect(r.active.visitors).toBe(n);
    expect(r.truncated.visitors).toBe(true);
  });

  it('totals payments and refunds in the site currency and names the others', async () => {
    const { db, session, payment } = setup();
    session.run('a1', 'v1', NOW - 20 * MIN, NOW - 1 * MIN, 'GH', 'Accra', 5.6, -0.2, '/thanks');
    payment.run('p1', NOW - 2 * MIN, 7900, 'payment', 'USD', 'v1', 'a1');
    payment.run('p2', NOW - 3 * MIN, 14900, 'payment', 'USD', null, null);
    payment.run('r1', NOW - 4 * MIN, -2900, 'refund', 'USD', null, null);
    payment.run('x1', NOW - 5 * MIN, 5000, 'payment', 'EUR', null, null);
    payment.run('x2', NOW - 6 * MIN, 900, 'payment', 'JPY', null, null);
    payment.run('old', NOW - 31 * MIN, 99900, 'payment', 'USD', null, null);

    const r = await realtime(db.d1, site, NOW);
    expect(r.payments).toEqual({ count: 2, amount: 22800, refunds: 1, refunded: 2900, net: 19900 });
    expect(r.other_currencies).toEqual([
      { currency: 'EUR', payments: 1, amount: 5000 },
      { currency: 'JPY', payments: 1, amount: 900 },
    ]);
    const types = r.feed.map((f) => [f.id, f.type]);
    expect(types).toEqual([
      ['pp1', 'payment'],
      ['pp2', 'payment'],
      ['pr1', 'refund'],
    ]);
    // The payment's place comes from its attributed session; an unlinked payment has none.
    expect(r.feed[0]).toMatchObject({ city: 'Accra', country: 'GH', lat: 5.6, amount: 7900 });
    expect(r.feed[1]).toMatchObject({ city: null, country: null, lat: null });
  });

  it('caps the feed and says so, while the payment totals stay exact', async () => {
    const { db, session, payment, event } = setup();
    session.run('a1', 'v1', NOW - 20 * MIN, NOW - 1 * MIN, 'GH', 'Accra', 5.6, -0.2, '/');
    for (let i = 0; i < REALTIME_LIMITS.events + 3; i++) event.run('a1', 'v1', NOW - 10 * MIN + i, `/p${i}`);
    for (let i = 0; i < REALTIME_LIMITS.payments + 2; i++) payment.run(`p${i}`, NOW - 10 * MIN + i, 100, 'payment', 'USD', null, null);

    const r = await realtime(db.d1, site, NOW);
    expect(r.truncated).toEqual({ visitors: false, events: true, payments: true });
    expect(r.feed.filter((f) => f.type === 'pageview').length).toBe(REALTIME_LIMITS.events);
    expect(r.feed.filter((f) => f.type === 'payment').length).toBe(REALTIME_LIMITS.payments);
    expect(r.payments.count).toBe(REALTIME_LIMITS.payments + 2);
    expect(r.payments.amount).toBe((REALTIME_LIMITS.payments + 2) * 100);
  });

  it('returns zeros, not gaps, when nobody is online', async () => {
    const { db } = setup();
    const r = await realtime(db.d1, site, NOW);
    expect(r.active).toEqual({ visitors: 0, countries: 0, unlocated: 0 });
    expect(r.payments).toEqual({ count: 0, amount: 0, refunds: 0, refunded: 0, net: 0 });
    expect(r.other_currencies).toEqual([]);
    expect(r.visitors).toEqual([]);
    expect(r.feed).toEqual([]);
  });
});
