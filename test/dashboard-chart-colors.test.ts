// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DashContext, type Dash } from '../src/dashboard/lib/context';
import { OverviewCard, type OverviewData } from '../src/dashboard/components/OverviewCard';

vi.mock('recharts', () => {
  const wrap = ({ children }: any) => h('div', null, children);
  const series = (kind: string) => ({ dataKey, yAxisId, fill, stroke, shape }: any) => h('span', { 'data-testid': kind, 'data-key': dataKey, 'data-axis': yAxisId, 'data-color': fill ?? stroke, 'data-segmented': !!shape });
  return { ResponsiveContainer: wrap, ComposedChart: wrap, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Bar: series('bar'), Line: series('line') };
});
const kpis = { visitors: 20, sessions: 20, pageviews: 30, revenue: 12000, payments: 2, customers: 2, conversionRate: .1, revenuePerVisitor: 600, bounceRate: .2, avgDuration: 1000 };
function mount(revenue = 12000) {
  const data = { current: kpis, previous: kpis, range: { granularity: 'day' }, series: [{ bucket: '2026-11-18', visitors: 20, revenue, payments: 2 }] } as unknown as OverviewData;
  render(h(DashContext.Provider, { value: { money: (n: number) => `GHS ${n / 100}` } as Dash }, h(OverviewCard, { data })));
}
beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe('metric identity in charts', () => {
  it('compares actual revenue bars and visitor lines on separate axes', () => {
    mount();
    expect(screen.getByTestId('bar').dataset).toMatchObject({ key: 'revenue', axis: 'revenue', color: 'var(--chart-revenue)' });
    expect(screen.getByTestId('line').dataset).toMatchObject({ key: 'visitors', axis: 'm', color: 'var(--chart-visitors)' });
    fireEvent.click(screen.getByRole('button', { name: 'Chart data' }));
    expect(screen.getByRole('columnheader', { name: 'Visitors' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Revenue' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'GHS 120' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '20' })).toBeTruthy();
  });
  it('keeps revenue amber in Line and visitors blue in Bar', () => {
    mount();
    fireEvent.click(document.querySelector('[data-metric="revenue"]')!);
    fireEvent.click(screen.getByRole('button', { name: /^Line$/ }));
    expect(screen.getByTestId('line').dataset).toMatchObject({ key: 'revenue', color: 'var(--chart-revenue)' });
    fireEvent.click(document.querySelector('[data-metric="visitors"]')!);
    expect(screen.getByTestId('bar').dataset).toMatchObject({ key: 'visitors', color: 'var(--chart-visitors)' });
  });
  it('ignores the obsolete segmented preference and keeps signed revenue solid', () => {
    localStorage.setItem('dm_chart_segmented', 'true');
    mount(-1200);
    expect(screen.getByTestId('bar').dataset.segmented).toBe('false');
    expect(screen.queryByRole('checkbox', { name: 'Segmented bars' })).toBeNull();
    expect(screen.getByTestId('bar').dataset.color).toBe('var(--chart-revenue)');
  });
  it('does not color conversion as visitors or revenue', () => {
    mount();
    fireEvent.click(document.querySelector('[data-metric="conversion"]')!);
    expect(screen.getByTestId('bar').dataset).toMatchObject({ key: 'conversion', color: 'var(--chart-neutral)' });
  });
});
