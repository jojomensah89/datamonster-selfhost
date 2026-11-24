import { describe, it, expect } from 'vitest';
import { makeD1 } from './helpers/d1';
import { overview, type Ctx } from '../src/worker/stats';
import { jobs, jobsForCron } from '../src/cron';
import { makeVerifyPlacementsJob, verifyPlacementsJob } from '../src/cron/verify-placements';
import { publicPlacement, type Placement } from '../src/agent/placements';
describe('backend review regressions', () => {
 it('separates USD, EUR and JPY without converting minor units', async () => {
  const db = makeD1();
  db.raw.exec("INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at) VALUES ('s','Site','example.com','UTC','USD','key',0)");
  for (const [currency, amount] of [['USD', 900], ['EUR', 800], ['JPY', 1000]] as const) {
   db.raw.prepare("INSERT INTO payments (id,site_id,provider,ts,amount,currency) VALUES (?, 's', 'api', 1000, ?, ?)").run(currency, amount, currency);
  }
  const ctx = {db: db.d1, site: {id: 's', currency: 'USD'}, range: {from: 0, to: 2000, granularity: 'day'}, filters: {}, offset: 0} as Ctx;
  const result = await overview(ctx);
  expect(result.current.revenue).toBe(900);
  expect(result.current.payments).toBe(1);
  expect(result.other_currencies).toEqual([{currency: 'EUR', amount: 800, payments: 1}, {currency: 'JPY', amount: 1000, payments: 1}]);
  expect(result.other_currency_payments).toBe(2);
 });
 it('checks more than 25 listings across hourly batches without repeating recent checks', async () => {
  const db = makeD1();
  const now = Date.now();
  db.raw.exec("INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at) VALUES ('s','Site','example.com','UTC','USD','key',0)");
  for (let i = 0; i < 33; i++) db.raw.prepare("INSERT INTO placements (id,site_id,name,status,listing_url,created_by,created_at,updated_at) VALUES (?, 's', ?, 'live', 'https://directory.org/listing', 'owner', ?, ?)").run(String(i), `Listing ${i}`, now - 86400000, now);
  let calls = 0;
  const job = makeVerifyPlacementsJob({pauseMs: 0, fetch: (async () => { calls++; return new Response('<a href="https://example.com">Site</a>', {headers: {'content-type': 'text/html'}}); }) as typeof fetch});
  for (let hour = 0; hour < 5; hour++) await job({DB: db.d1, ADMIN_PASSWORD: 'pw'} as never, now + hour * 3600000);
  expect(calls).toBe(33);
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM placements WHERE last_checked_at IS NOT NULL').get()).toMatchObject({n: 33});
 });
 it('runs listing checks on the hourly cron trigger', () => {
  expect(jobs).toContain(verifyPlacementsJob);
  expect(jobsForCron('0 * * * *', Date.UTC(2026, 10, 23, 5))).toEqual(jobs);
  expect(jobsForCron('0 * * * *', Date.UTC(2026, 10, 23, 6))).toEqual(jobs);
  expect(jobsForCron('0 * * * *', Date.UTC(2026, 10, 23, 7))).toEqual(jobs);
  expect(jobsForCron('unknown')).toEqual([]);
 });
 it('exposes overdue eligible listings after thirty hours', () => {
  const p = {status: 'live', listing_url: 'https://example.com', archived_at: null, created_at: Date.now() - 31 * 3600000, last_checked_at: null} as Placement;
  expect(publicPlacement(p).overdue).toBe(true);
  expect(publicPlacement({...p, last_checked_at: Date.now()}).overdue).toBe(false);
 });
});

