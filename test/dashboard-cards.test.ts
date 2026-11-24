import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardLayouts } from '../src/dashboard/lib/cardLayout';
import { toggledFilter, withoutFilter } from '../src/dashboard/lib/filters';
import { CARDS, DEFAULT_CARDS, isDefaultCards, parseCards, readCards, storeCards, type CardPref } from '../src/shared/dashboardCards';
import type { Env } from '../src/worker/env';
import { forgetAllSites } from '../src/worker/env';
import app from '../src/worker/index';
import { createSession } from '../src/worker/auth';
import { makeD1 } from './helpers/d1';

const body = (r: Response) => r.json() as Promise<any>;
const off = (id: string) => DEFAULT_CARDS.map((c) => ({ ...c, on: c.id !== id }));

describe('card layouts', () => {
  it('drops unknown and repeated cards and adds the ones a saved layout does not know', () => {
    const cards = parseCards([{ id: 'goals', on: false }, { id: 'nope', on: true }, { id: 'goals', on: true }, { id: 'live', on: true }]);
    expect(cards.slice(0, 2)).toEqual([{ id: 'goals', on: false }, { id: 'live', on: true }]);
    expect(cards).toHaveLength(CARDS.length);
    expect(new Set(cards.map((c) => c.id)).size).toBe(CARDS.length);
    expect(cards.slice(2).every((c) => c.on)).toBe(true);
  });
  it('falls back to the default for anything else', () => {
    for (const bad of [null, undefined, 'x', 4, {}, [1], [{ id: 'live' }], [{ id: 'live', on: 'yes' }], [null]]) expect(isDefaultCards(parseCards(bad))).toBe(true);
    for (const bad of [null, undefined, '', '{', '"x"', JSON.stringify(DEFAULT_CARDS)]) expect(readCards(bad)).toBeNull();
    expect(storeCards(DEFAULT_CARDS)).toBeNull();
    expect(storeCards([])).toBeNull();
    expect(readCards(storeCards(off('live')))).toEqual(off('live'));
  });
});

describe('filters', () => {
  it('removes a filter when its value is chosen again, Direct/None included', () => {
    expect(toggledFilter({}, 'country', 'DE')).toEqual({ country: 'DE' });
    expect(toggledFilter({ country: 'DE', source: '' }, 'country', 'US')).toEqual({ country: 'US', source: '' });
    expect(toggledFilter({ country: 'DE', source: '' }, 'source', '')).toEqual({ country: 'DE' });
    expect(toggledFilter({ country: 'DE' }, 'source', '')).toEqual({ country: 'DE', source: '' });
    expect(withoutFilter({ country: 'DE', source: '' }, 'country')).toEqual({ source: '' });
  });
});

describe('saving a layout', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('shows a change at once and saves the last of several', async () => {
    const save = vi.fn(async () => {});
    const l = new CardLayouts(save);
    l.set('s', off('live'), [...DEFAULT_CARDS]);
    l.set('s', off('goals'), off('live'));
    expect(l.entry('s')?.cards).toEqual(off('goals'));
    vi.advanceTimersByTime(500);
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('s', off('goals'), false);
    expect(l.entry('s')).toMatchObject({ pending: false, error: false });
  });
  it('goes back to the last saved layout when a save fails', async () => {
    const l = new CardLayouts(async () => {
      throw new Error('500');
    });
    l.set('s', off('live'), [...DEFAULT_CARDS]);
    l.set('s', off('goals'), off('live'));
    vi.advanceTimersByTime(500);
    await settle();
    expect(l.entry('s')).toMatchObject({ cards: DEFAULT_CARDS, pending: false, error: true });
  });
  it('sends one save at a time, so an older one cannot land last', async () => {
    const done: (() => void)[] = [];
    const save = vi.fn((_id: string, _cards: CardPref[], _leaving: boolean) => new Promise<void>((r) => done.push(r)));
    const l = new CardLayouts(save);
    l.set('s', off('live'), [...DEFAULT_CARDS]);
    vi.advanceTimersByTime(500);
    l.set('s', off('goals'), off('live'));
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
    done[0]();
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    done[1]();
    await settle();
    expect(l.entry('s')).toMatchObject({ cards: off('goals'), pending: false });
  });
  it('saves a waiting change when leaving', () => {
    const save = vi.fn(async () => {});
    const l = new CardLayouts(save);
    l.set('s', off('live'), [...DEFAULT_CARDS]);
    l.flush('s', true);
    expect(save).toHaveBeenCalledWith('s', off('live'), true);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /api/sites/:id dashboard_cards', () => {
  function setup() {
    const db = makeD1();
    forgetAllSites();
    const future = Date.now() + 1e9;
    db.raw.exec(
      `INSERT INTO users (id, email, created_at, plan_status, plan_until) VALUES ('u1', 'a@example.com', 0, 'active', ${future}), ('u2', 'b@example.com', 0, 'active', ${future});
       INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES ('mine', 'Mine', 'a.example.com', 'UTC', 'USD', 'k1', 0, 'u1'), ('theirs', 'Theirs', 'b.example.com', 'UTC', 'USD', 'k2', 0, 'u2');`,
    );
    const env = { DB: db.d1, SESSION_SECRET: 'secret', ADMIN_PASSWORD: 'pw', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec' } as Env;
    const call = async (path: string, json?: unknown) =>
      app.request(
        'https://dm.test' + path,
        { method: json === undefined ? 'GET' : 'PATCH', body: json === undefined ? undefined : JSON.stringify(json), headers: { cookie: 'dm_auth=' + (await createSession(env, 'u:u1')) } },
        env,
        { waitUntil() {} } as any,
      );
    const stored = (id = 'mine') => db.raw.prepare('SELECT * FROM sites WHERE id = ?').get(id) as Record<string, unknown>;
    return { call, stored };
  }

  it('cleans, stores and returns the layout, and resets to NULL', async () => {
    const { call, stored } = setup();
    expect((await body(await call('/api/sites/mine'))).dashboard_cards).toBeNull();
    const res = await call('/api/sites/mine', { dashboard_cards: [{ id: 'nope', on: true }, ...off('live')] });
    expect(res.status).toBe(200);
    expect((await body(res)).dashboard_cards).toEqual(off('live'));
    expect((await body(await call('/api/sites/mine'))).dashboard_cards).toEqual(off('live'));
    expect((await body(await call("/api/sites")))[0].dashboard_cards).toEqual(off('live'));
    await call('/api/sites/mine', { dashboard_cards: null });
    expect(stored().dashboard_cards).toBeNull();
  });
  it('leaves the layout alone in other changes, and the other settings alone in this one', async () => {
    const { call, stored } = setup();
    await call('/api/sites/mine', { dashboard_cards: off('live') });
    await call('/api/sites/mine', { name: 'Renamed' });
    expect(stored()).toMatchObject({ name: 'Renamed', dashboard_cards: JSON.stringify(off('live')) });
    await call('/api/sites/mine', { name: 'Both', dashboard_cards: off('goals') });
    expect(stored()).toMatchObject({ name: 'Both', domain: 'a.example.com', dashboard_cards: JSON.stringify(off('goals')) });
  });
  it('refuses something that is not a list, and the site of another owner', async () => {
    const { call, stored } = setup();
    expect((await call('/api/sites/mine', { dashboard_cards: 'x' })).status).toBe(400);
    expect((await call('/api/sites/theirs', { dashboard_cards: off('live') })).status).toBe(404);
    expect(stored('theirs').dashboard_cards).toBeNull();
  });
});
