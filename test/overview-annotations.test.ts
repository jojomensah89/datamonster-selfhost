// @vitest-environment jsdom
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucketForAnnotation, OverviewCard, type OverviewData } from '../src/dashboard/components/OverviewCard';
import { DashContext, type Dash } from '../src/dashboard/lib/context';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bucketForAnnotation', () => {
  it('matches day, hour, week, and month buckets cleanly', () => {
    expect(bucketForAnnotation('2026-11-12', ['2026-11-11', '2026-11-12', '2026-11-13'], 'day')).toBe('2026-11-12');
    expect(bucketForAnnotation('2026-11-12', ['2026-11-12 00:00', '2026-11-12 01:00'], 'hour')).toBe('2026-11-12 00:00');
    expect(bucketForAnnotation('2026-11-12', ['2026-11-02', '2026-11-09', '2026-11-16'], 'week')).toBe('2026-11-09');
    expect(bucketForAnnotation('2026-11-12', ['2026-10', '2026-11'], 'month')).toBe('2026-11');
    expect(bucketForAnnotation('2026-11-20', ['2026-11-11', '2026-11-12'], 'day')).toBeNull();
  });
});

describe('OverviewCard annotations UI', () => {
  const kpis = {
    visitors: 10,
    sessions: 12,
    pageviews: 25,
    bounceRate: 0.2,
    avgDuration: 45_000,
    revenue: 5000,
    payments: 2,
    customers: 2,
    conversionRate: 0.2,
    revenuePerVisitor: 500,
  };
  const overview: OverviewData = {
    range: { from: Date.UTC(2026, 10, 10), to: Date.UTC(2026, 10, 14), granularity: 'day' },
    currency: 'USD',
    decimals: 2,
    current: kpis,
    previous: kpis,
    online: 1,
    series: [
      { bucket: '2026-11-11', visitors: 4, pageviews: 10, revenue: 2000, payments: 1 },
      { bucket: '2026-11-12', visitors: 6, pageviews: 15, revenue: 3000, payments: 1 },
    ],
  };
  const dash: Dash = {
    site: { id: 'site-1', name: 'Demo', domain: 'demo.test', timezone: 'UTC', currency: 'USD', api_key: 'k', dodo_webhook_secret: null, created_at: 0 },
    q: { period: '7d', filters: {} },
    reloadKey: 0,
    decimals: 2,
    money: (minor) => `$${(minor / 100).toFixed(2)}`,
    addFilter: () => {},
    openVisitor: () => {},
  };

  it('loads annotations, creates a new note, and deletes an existing note', async () => {
    const notes = [{ id: 'ann_1', site_id: 'site-1', day: '2026-11-12', text: 'Raised prices', created_by: 'owner', created_at: 1 }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/annotations/ann_1') && init?.method === 'DELETE') {
        const idx = notes.findIndex((n) => n.id === 'ann_1');
        if (idx >= 0) notes.splice(idx, 1);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/annotations') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const created = { id: 'ann_2', site_id: 'site-1', day: body.day, text: body.text, created_by: 'owner', created_at: 2 };
        notes.push(created);
        return new Response(JSON.stringify({ created: true, annotation: created }), { status: 201 });
      }
      if (url.includes('/annotations')) {
        return new Response(JSON.stringify({ annotations: [...notes] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(DashContext.Provider, { value: dash }, h(OverviewCard, { data: overview })));

    expect(await screen.findByText('Raised prices')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByPlaceholderText('Started the spring sale'), { target: { value: 'Shipped v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(await screen.findByText('Shipped v2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete note Raised prices' }));
    await waitFor(() => {
      expect(screen.queryByText('Raised prices')).toBeNull();
    });
  });
});
