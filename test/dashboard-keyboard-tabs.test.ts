// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashContext, type Dash } from '../src/dashboard/lib/context';
import { Panel } from '../src/dashboard/components/Panel';
import { GoalsPanel } from '../src/dashboard/components/GoalsPanel';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }) });
});
vi.mock('../src/dashboard/lib/useApi', () => ({ useApi: () => ({ data: null, loading: true }) }));
const context = { site: { id: 'test' }, q: { filters: {} }, reloadKey: 0, money: (n: number) => String(n), addFilter: vi.fn() } as unknown as Dash;
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('dashboard tab keyboard access', () => {
  for (const view of ['breakdown', 'people'] as const) {
    it(`moves selection, focus and panel association together for ${view} tabs`, async () => {
      const user = userEvent.setup();
      const child = view === 'people' ? h(GoalsPanel, { totalVisitors: 0 }) : h(Panel, { tabs: [{ label: 'Country', dim: 'country' }, { label: 'Region', dim: 'region' }, { label: 'City', dim: 'city' }] });
      render(h(DashContext.Provider, { value: context }, child));
      const tabs = screen.getAllByRole('tab');
      const selected = () => tabs.filter(t => t.getAttribute('aria-selected') === 'true');
      selected()[0].focus();
      for (const [key, index] of [['{Home}', 0], ['{ArrowLeft}', tabs.length - 1], ['{ArrowRight}', 0], ['{End}', tabs.length - 1]] as const) {
        await user.keyboard(key);
        expect(selected()).toEqual([tabs[index]]);
        expect(document.activeElement).toBe(tabs[index]);
        expect(tabs.filter(t => t.tabIndex === 0)).toEqual([tabs[index]]);
        expect(document.getElementById(tabs[index].getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(tabs[index].id);
      }
    });
  }
});
