import { describe, expect, it } from 'vitest';
import { plansFor } from '../src/dashboard/pages/Landing';
import type { PlanInfo } from '../src/dashboard/lib/api';

const basePlan: PlanInfo = {
  hosted: false,
  price: '$5',
  interval: 'month',
  checkout: false,
  supportEmail: 'hi@datamonster.dev',
};

describe('Landing plans', () => {
  it('has three: Free, Pro and your own copy', () => {
    expect(plansFor(basePlan).map((p) => [p.name, p.price])).toEqual([['Free', '$0'], ['Pro', '$5'], ['Self-host', '$0']]);
  });
  it('sells only what is ready', () => {
    const [free, pro, own] = plansFor(basePlan);
    expect([free.href, own.href, own.btn, own.note]).toEqual([null, null, 'Deploy to Cloudflare', 'Coming soon.']);
    expect([pro.btn, pro.href!.startsWith('mailto:hi@datamonster.dev')]).toEqual(['Join the waitlist', true]);
    expect(plansFor({ ...basePlan, supportEmail: null })[1].href).toBeNull();
    // Accounts are open but Pro isn't on sale: Free still is.
    const open = plansFor({ ...basePlan, hosted: true });
    expect([open[0].href, open[1].btn]).toEqual(['/api/auth/google', 'Join the waitlist']);
  });
  it('signs in with Google for both plans, Pro going on to Billing', () => {
    const [free, pro] = plansFor({ ...basePlan, hosted: true, checkout: true });
    expect([free.btn, free.href, free.mark]).toEqual(['Continue with Google', '/api/auth/google', 'google']);
    expect([pro.btn, pro.href, pro.mark]).toEqual(['Continue with Google', '/api/auth/google?plan=pro', 'google']);
  });
  it('offers the Cloudflare button once the code is public', () => {
    const own = plansFor({ ...basePlan, deployUrl: 'https://deploy.workers.cloudflare.com/?url=x' })[2];
    expect([own.btn, own.href, own.mark]).toEqual(['Deploy to Cloudflare', 'https://deploy.workers.cloudflare.com/?url=x', 'cloudflare']);
  });
  it('shows the limits the server set', () => {
    const [free, pro] = plansFor({ ...basePlan, eventLimit: 100_000, siteLimit: 25, free: { eventLimit: 1_000, siteLimit: 2 } });
    expect(free.list.slice(0, 2)).toEqual(['1,000 events a month', '2 websites']);
    expect(pro.list.slice(0, 2)).toEqual(['100,000 events a month', 'Up to 25 websites']);
    expect(plansFor(null)[0].list.slice(0, 2)).toEqual(['5,000 events a month', '1 website']);
  });
});
