// @vitest-environment jsdom
import { createElement as h, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SelectField, SelectItem } from '../src/dashboard/components/primitives/select-field';
import { Checkbox } from '../src/dashboard/components/primitives/checkbox';
import { DatePicker, parseCalendarDate, serializeCalendarDate } from '../src/dashboard/components/primitives/date-picker';
import { Dialog } from '../src/dashboard/components/Dialog';
import { Button } from '../src/dashboard/components/primitives/button';

beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

function Choices({ initial = '', onChange = () => {} }: { initial?: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return h(SelectField, { 'aria-label': 'Status', value, onValueChange: v => { setValue(v); onChange(v); }, children: [
    h(SelectItem, { key: 'empty', value: '', children: 'Draft' }),
    h(SelectItem, { key: 'live', value: 'live', children: 'Live' }),
  ] });
}

describe('dashboard shadcn controls', () => {
  it('supports keyboard selection and the deliberate empty choice without value collisions', async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(h(Choices, { onChange: change }));
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    await waitFor(() => expect(trigger.textContent).toContain('Draft'));
    trigger.focus();
    await user.keyboard('{Enter}{End}{Enter}');
    expect(change).toHaveBeenLastCalledWith('live');
    await user.keyboard('{Enter}{Home}{Enter}');
    expect(change).toHaveBeenLastCalledWith('');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps a portalled select interactive within a dialog and restores focus on Escape', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return h('div', null,
        h(Button, { onClick: () => setOpen(true) }, 'Edit site'),
        h(Dialog, { open, onClose: () => setOpen(false), label: 'Site settings', children: h(Choices), backdropClassName: 'fixed inset-0' }));
    }
    render(h(Harness));
    const opener = screen.getByRole('button', { name: 'Edit site' });
    await user.click(opener);
    const select = screen.getByRole('combobox');
    await user.click(select);
    expect(screen.getByRole('listbox')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Site settings' })).toBeTruthy();
    expect(document.activeElement).toBe(select);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('toggles a labelled checkbox by keyboard and preserves disabled state', async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(h(Checkbox, { 'aria-label': 'Allow write', onCheckedChange: change }));
    screen.getByRole('checkbox').focus();
    await user.keyboard(' ');
    expect(change).toHaveBeenLastCalledWith(true);
    cleanup();
    render(h(Checkbox, { 'aria-label': 'Allow write', disabled: true, onCheckedChange: change }));
    change.mockClear();
    await user.click(screen.getByRole('checkbox'));
    expect(change).not.toHaveBeenCalled();
  });

  it('round-trips calendar dates locally and rejects impossible dates', () => {
    for (const value of ['2024-02-29', '2026-01-01', '2026-03-08', '2026-11-01', '2026-12-31']) {
      expect(serializeCalendarDate(parseCalendarDate(value)!)).toBe(value);
    }
    for (const value of ['', '2026-02-30', '2025-02-29', '2026-13-01', '2026-1-1']) expect(parseCalendarDate(value)).toBeUndefined();
  });

  it('opens the calendar, selects a day, and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(h(DatePicker, { 'aria-label': 'Launch date', value: '2026-11-16', onValueChange: change }));
    const trigger = screen.getByRole('button', { name: 'Launch date' });
    await user.click(trigger);
    const day = screen.getAllByRole('button').find(b => b.getAttribute('data-day') === new Date(2026, 10, 17).toLocaleDateString())!;
    await user.click(day);
    expect(change).toHaveBeenCalledWith('2026-11-17');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
