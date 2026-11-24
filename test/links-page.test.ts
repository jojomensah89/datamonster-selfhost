// @vitest-environment jsdom
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationFor, REF_PATTERN as SERVER_REF, taggedUrl } from '../src/agent/links';
import { RevenueSources } from '../src/dashboard/components/RevenueSources';
import { DashContext, type Dash } from '../src/dashboard/lib/context';
import { pageOf, PLACES, planLink, REF_PATTERN, suggestRef, typedRef, type SavedLink } from '../src/dashboard/lib/links';
import { Links } from '../src/dashboard/pages/Links';
import { classify } from '../src/shared/sources';

// theme.ts reads it while loading.
vi.hoisted(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
});

const place = (label: string) => PLACES.find((p) => p.label === label)!;
const DOMAIN = 'shipkit.dev';
const server = { id: 's1', domain: DOMAIN } as Parameters<typeof destinationFor>[0];
const site = { id: 's1', name: 'ShipKit', domain: DOMAIN, timezone: 'UTC', currency: 'USD', api_key: 'k', dodo_webhook_secret: null, created_at: 0 };
const link = (over: Partial<SavedLink>): SavedLink => {
  const ref = over.ref ?? 'a-link';
  const destination = over.destination ?? `https://${DOMAIN}/`;
  return {
    id: `lnk_${ref}`, ref, destination, label: null, created_by: 'owner', created_at: Date.UTC(2026, 10, 2), archived_at: null,
    url: taggedUrl(destination, ref), visitors: 0, customers: 0, revenue: 0, ...over,
  };
};

type Call = { method: string; path: string; body: any };
let calls: Call[];
let links: SavedLink[];
let scrolled: string[];
/** What POST answers instead of creating. */
let onPost: ((body: any) => { status: number; body: unknown }) | null;
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', json: async () => body }) as Response;

beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { if (this.id.startsWith('link-')) scrolled.push(this.id); };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  calls = [];
  links = [];
  scrolled = [];
  onPost = null;
  localStorage.clear();
  window.history.replaceState(null, '', '/links?site=s1');
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/sites') return json([site]);
    if (method === 'DELETE') {
      links = links.map((l) => (path.endsWith(`/${l.id}`) ? { ...l, archived_at: 1 } : l));
      return json({ ok: true });
    }
    if (method === 'POST') {
      if (onPost) {
        const r = onPost(body);
        return json(r.body, r.status);
      }
      const old = links.find((l) => l.ref === body.ref);
      if (old) {
        links = links.map((l) => (l === old ? { ...l, archived_at: null } : l));
        return json({ created: false, link: { ...old, archived_at: null } });
      }
      const made = link({ ref: body.ref, label: body.label ?? null, destination: destinationFor(server, body.path).toString() });
      links = [...links, made];
      return json({ created: true, link: made }, 201);
    }
    return json({ links });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = async () => {
  render(h(Links));
  await screen.findByRole('heading', { name: 'Links', hidden: true });
  await waitFor(() => expect(calls.some((c) => c.path.includes('/links?'))).toBe(true));
};
const posts = () => calls.filter((c) => c.method === 'POST');
/** The table, for what the bars do not repeat on every row. */
const asTable = () => localStorage.setItem('dm_links_view', '"table"');
const table = async () => within(await screen.findByRole('table', { hidden: true }));
async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('combobox', { name: "Where you'll post it" }));
  await user.click(await screen.findByRole('option', { name: label }));
}

describe('links: refs and URLs', () => {
  it('suggests a ref the server accepts', () => {
    expect(suggestRef(place('Reddit'), 'Launch')).toBe('reddit-launch');
    expect(suggestRef(place('Reddit'), 'Reddit launch!')).toBe('reddit-launch');
    expect(suggestRef(place('Other'), '  Café à Paris ')).toBe('cafe-a-paris');
    expect(suggestRef(place('X / Twitter'), '発表')).toBe('x-link');
    expect(suggestRef(place('Newsletter'), '   ')).toBe('');
    const long = suggestRef(place('Product Hunt'), 'a very long name '.repeat(10));
    expect(long.length).toBeLessThanOrEqual(49);
    for (const p of PLACES) for (const n of ['Launch', 'a-', '--x--y', '発表', 'n'.repeat(80), 'word '.repeat(20)]) expect(suggestRef(p, n)).toMatch(p.source || n.length > 2 ? SERVER_REF : /^[a-z0-9]/);
    expect(typedRef('-My Ref_2 ')).toBe('my-ref-2-');
    expect(REF_PATTERN.source).toBe(SERVER_REF.source);
  });

  it('adds the place\'s tags without overwriting typed ones, and keeps the page\'s own query and fragment', () => {
    const path = (page: string, label = 'Reddit') => (planLink(DOMAIN, page, place(label)) as { path: string }).path;
    expect(path('/pricing')).toBe('/pricing?utm_source=reddit&utm_medium=social');
    expect(path('')).toBe('/?utm_source=reddit&utm_medium=social');
    expect(path('https://shipkit.dev/pricing?plan=pro#top')).toBe('/pricing?plan=pro&utm_source=reddit&utm_medium=social#top');
    expect(path('shipkit.dev/pricing')).toBe('/pricing?utm_source=reddit&utm_medium=social');
    expect(path('/?utm_source=partner')).toBe('/?utm_source=partner&utm_medium=social');
    expect(path('/?utm_source=a&utm_medium=cpc')).toBe('/?utm_source=a&utm_medium=cpc');
    expect(path('https://www.shipkit.dev/a', 'Other')).toBe('https://www.shipkit.dev/a');
    expect(path('/pricing', 'Other')).toBe('/pricing');
    expect(pageOf('https://shipkit.dev/pricing?plan=pro&utm_source=x&utm_medium=social#top')).toBe('/pricing?plan=pro#top');
  });

  it('refuses the pages the server refuses', () => {
    for (const page of ['https://evil.example/', '//evil.example', 'javascript:alert(1)', 'https://shipkit.dev:8080/', 'https://a:b@shipkit.dev/', '/?ref=a', '/?via=b']) {
      expect(planLink(DOMAIN, page, place('Reddit'))).toHaveProperty('error');
      expect(() => destinationFor(server, page)).toThrow();
    }
  });

  it('previews exactly the URL the server saves', () => {
    for (const page of ['/', '/pricing?plan=pro#top', 'https://www.shipkit.dev/a b?x=ü', '/a?utm_source=z', 'https://shipkit.dev//double']) {
      for (const p of PLACES) {
        const plan = planLink(DOMAIN, page, p);
        if ('error' in plan) throw new Error(plan.error);
        expect(plan.url('my-ref')).toBe(taggedUrl(destinationFor(server, plan.path).toString(), 'my-ref'));
      }
    }
  });

  it('reports under the place\'s source and channel, and under the ref', () => {
    const report = (label: string, page = '/pricing', referrerDomain: string | null = null) => {
      const plan = planLink(DOMAIN, page, place(label)) as { path: string };
      const q = new URL(taggedUrl(destinationFor(server, plan.path).toString(), 'launch-1')).searchParams;
      // The same reads as src/worker/collect.ts.
      const ref = q.get('ref') ?? q.get('via');
      const { source, channel } = classify({ referrerDomain, utmSource: q.get('utm_source'), utmMedium: q.get('utm_medium'), ref });
      return [source, channel, ref];
    };
    expect(report('X / Twitter')).toEqual(['X', 'Organic Social', 'launch-1']);
    expect(report('LinkedIn')).toEqual(['LinkedIn', 'Organic Social', 'launch-1']);
    expect(report('Reddit')).toEqual(['Reddit', 'Organic Social', 'launch-1']);
    expect(report('YouTube')).toEqual(['YouTube', 'Organic Social', 'launch-1']);
    expect(report('Medium')).toEqual(['Medium', 'Referral', 'launch-1']);
    expect(report('Newsletter')).toEqual(['Newsletter', 'Email', 'launch-1']);
    expect(report('Product Hunt')).toEqual(['Product Hunt', 'Referral', 'launch-1']);
    // Other adds no source: a known referrer still names it, else the ref does.
    expect(report('Other', '/', 'news.ycombinator.com')).toEqual(['Hacker News', 'Organic Social', 'launch-1']);
    expect(report('Other')).toEqual(['launch-1', 'Referral', 'launch-1']);
    // Typed tags win.
    expect(report('Reddit', '/?utm_source=reddit&utm_medium=cpc')).toEqual(['Reddit', 'Paid', 'launch-1']);
  });
});

describe('links page', () => {
  it('lists links by revenue then visitors, with totals, pages and who made them', async () => {
    links = [
      link({ ref: 'quiet', visitors: 3 }),
      link({ ref: 'busy', visitors: 90 }),
      link({ ref: 'x-launch', label: 'Launch tweet', destination: 'https://shipkit.dev/pricing?utm_source=x&utm_medium=social', visitors: 40, customers: 2, revenue: 5800, created_by: 'agt_9f3c' }),
      link({ ref: 'old-one', archived_at: 5, visitors: 7, revenue: 100 }),
    ];
    asTable();
    await open();
    const rows = (await table()).getAllByRole('row', { hidden: true }).slice(1);
    expect(rows.map((r) => r.querySelector('b')!.textContent)).toEqual(['Launch tweet', 'busy', 'quiet']);
    expect(rows[0].textContent).toContain('https://shipkit.dev/pricing?utm_source=x&utm_medium=social&ref=x-launch');
    expect(rows[0].textContent).toContain('x-launch');
    expect([...rows[0].querySelectorAll('td')].map((td) => td.textContent).slice(1, 6)).toEqual(['/pricing', '40', '2', '$58', 'Nov 2, 2026by an agent']);
    expect(rows[1].textContent).not.toContain('by an agent');
    expect(document.body.textContent).not.toContain('agt_9f3c');
    expect(document.body.textContent).toContain('$58 from 133 visitors across 3 links');
    expect(calls.find((c) => c.path.includes('/links?'))!.path).toBe('/api/sites/s1/links?period=all&include_archived=true');
    expect(screen.getByRole('button', { name: 'Archived 1' }).getAttribute('aria-expanded')).toBe('false');
    // Every action is an icon named after its link.
    const first = within(rows[0]);
    for (const name of ['Copy link for Launch tweet', 'QR code for Launch tweet', 'Archive Launch tweet']) {
      expect(first.getByRole('button', { name, hidden: true }).querySelector('svg')).toBeTruthy();
    }
  });

  it('asks for the chosen period', async () => {
    const user = userEvent.setup();
    links = [link({ ref: 'one' })];
    await open();
    await user.click(screen.getByRole('combobox', { name: 'Period' }));
    await user.click(await screen.findByRole('option', { name: 'Last 30 days' }));
    await waitFor(() => expect(calls.at(-1)!.path).toBe('/api/sites/s1/links?period=30d&include_archived=true'));
  });

  it('creates a link with the tags in its path, then offers the URL and its QR code', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: 'Make your first link' }));
    const page = screen.getByLabelText('Page it opens');
    await waitFor(() => expect(document.activeElement).toBe(page));
    const create = screen.getByRole('button', { name: 'Create link' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.clear(page);
    await user.type(page, '/pricing?plan=pro');
    await pick(user, 'Reddit');
    await user.type(screen.getByLabelText('Name'), 'Launch post');
    expect((screen.getByLabelText('Link tag') as HTMLInputElement).value).toBe('reddit-launch-post');
    const url = 'https://shipkit.dev/pricing?plan=pro&utm_source=reddit&utm_medium=social&ref=reddit-launch-post';
    expect(screen.getByText(url)).toBeTruthy();
    await user.click(create);
    expect(await screen.findByText(/is ready to share/)).toBeTruthy();
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/sites/s1/links', body: { ref: 'reddit-launch-post', path: '/pricing?plan=pro&utm_source=reddit&utm_medium=social', label: 'Launch post' } },
    ]);
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(url)).toBeTruthy();
    expect(dialog.getByRole('img', { name: `QR code that opens ${url}` })).toBeTruthy();
    for (const name of ['Copy link for', 'Download the QR code for']) expect(dialog.getAllByRole('button', { name: new RegExp(`^${name} Launch post`) }).length).toBe(name.startsWith('Copy') ? 1 : 2);
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    const made = await screen.findByRole('button', { name: /^Launch post/ });
    expect(made.getAttribute('aria-expanded')).toBe('true');
    // The button that opened the form went away with the empty page.
    await waitFor(() => expect(document.activeElement).toBe(made));
    expect(scrolled).toEqual(['link-lnk_reddit-launch-post-item']);
  });

  it('keeps an edited ref when the name changes, and sends a typed label', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'New link' }));
    await pick(user, 'Other');
    const ref = screen.getByLabelText('Link tag') as HTMLInputElement;
    await user.type(ref, 'My Ref');
    await user.type(screen.getByLabelText('Name'), 'Something else');
    expect(ref.value).toBe('my-ref');
    await user.type(screen.getByLabelText('Label (optional)'), 'Podcast');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/is ready to share/);
    expect(posts()[0].body).toEqual({ ref: 'my-ref', path: '/', label: 'Podcast' });
  });

  it('shows the server\'s 409 inline and keeps the form', async () => {
    const user = userEvent.setup();
    const error = 'ref "x-launch" already points to https://shipkit.dev/. Choose another ref, or use the existing link.';
    onPost = () => ({ status: 409, body: { error } });
    await open();
    await user.click(screen.getByRole('button', { name: 'New link' }));
    await user.type(screen.getByLabelText('Name'), 'launch');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect((await screen.findByRole('alert')).textContent).toBe(error);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('launch');
  });

  it('says why a page is not allowed and does not send it', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'New link' }));
    await user.type(screen.getByLabelText('Name'), 'launch');
    const page = screen.getByLabelText('Page it opens');
    await user.clear(page);
    await user.type(page, 'https://evil.example/');
    expect(screen.getByRole('alert').textContent).toBe('The page must be on shipkit.dev.');
    expect((screen.getByRole('button', { name: 'Create link' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when the link already existed, and that it came back from the archive', async () => {
    const user = userEvent.setup();
    links = [link({ ref: 'instagram-launch', label: 'Old launch', archived_at: 5 })];
    await open();
    await user.click(await screen.findByRole('button', { name: 'Make a new link' }));
    await user.type(screen.getByLabelText('Name'), 'launch');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    const status = await screen.findByText(/This link already existed/);
    expect(status.textContent).toContain('Old launch');
    expect(status.textContent).toContain('back in your list');
  });

  it('archives a link and restores it with the same ref and page', async () => {
    const user = userEvent.setup();
    const destination = 'https://shipkit.dev/pricing?utm_source=x&utm_medium=social';
    links = [link({ ref: 'x-launch', destination }), link({ ref: 'stays' })];
    asTable();
    await open();
    await user.click((await table()).getByRole('button', { name: 'Archive x-launch', hidden: true }));
    const show = await screen.findByRole('button', { name: 'Archived 1' });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/sites/s1/links/lnk_x-launch')).toBe(true);
    expect(screen.getByText('x-launch archived. The link still works.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(show));
    expect((await table()).queryByText('x-launch', { selector: 'b' })).toBeNull();

    await user.click(show);
    const archived = within(screen.getAllByRole('table', { hidden: true })[1]);
    await user.click(archived.getByRole('button', { name: 'Restore x-launch', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull());
    expect(posts()).toEqual([{ method: 'POST', path: '/api/sites/s1/links', body: { ref: 'x-launch', path: destination } }]);
    expect((await table()).getByText('x-launch', { selector: 'b' })).toBeTruthy();
  });

  it('opens a link\'s QR code', async () => {
    const user = userEvent.setup();
    links = [link({ ref: 'poster' })];
    asTable();
    await open();
    await user.click((await table()).getByRole('button', { name: 'QR code for poster', hidden: true }));
    const dialog = within(await screen.findByRole('dialog', { name: 'QR code for poster' }));
    expect(dialog.getByRole('img', { name: 'QR code that opens https://shipkit.dev/?ref=poster' })).toBeTruthy();
  });

  it('opens the form from ?new=1 and takes it out of the address', async () => {
    window.history.replaceState(null, '', '/links?site=s1&new=1');
    await open();
    expect(await screen.findByRole('dialog', { name: 'New link' })).toBeTruthy();
    expect(window.location.search).toBe('?site=s1');
  });

  it('shows a load error with a retry', async () => {
    const fetched = fetch;
    let fail = true;
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => (fail && path.includes('/links?') ? Promise.resolve(json({ error: 'boom' }, 500)) : fetched(path, init)));
    render(h(Links));
    expect(await screen.findByText("Couldn't load links: boom.")).toBeTruthy();
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'See which post brings you customers' })).toBeTruthy();
  });
});

describe('links: nothing yet', () => {
  it('explains the page with a labelled example and one primary button', async () => {
    const user = userEvent.setup();
    await open();
    const empty = await screen.findByRole('region', { name: 'See which post brings you customers' });
    expect(empty.textContent).toContain('Make a link for each place you share: a post, an ad, a newsletter or a QR code on a flyer. Its visitors, customers and revenue show up here.');
    // The drawing is only for the eye, and says it is an example; the text says it for everyone else.
    const drawn = empty.querySelector('[aria-hidden="true"]')!;
    expect(drawn.textContent).toContain('Example');
    expect(drawn.querySelectorAll('.link-ribbon')).toHaveLength(3);
    expect(drawn.querySelector('button')).toBeNull();
    expect(drawn.textContent).not.toMatch(/\d/);
    expect(within(empty).getByText(/^Example chart\. Each link is a ribbon/)).toBeTruthy();
    expect(document.querySelectorAll('.btn-dark')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Bars' })).toBeNull();
    await user.click(within(empty).getByRole('button', { name: 'Make your first link' }));
    expect(await screen.findByRole('dialog', { name: 'New link' })).toBeTruthy();
  });

  it('keeps to one line when every link is archived', async () => {
    links = [link({ ref: 'old', archived_at: 5 })];
    await open();
    expect(await screen.findByText(/Every link is archived\. Archived links still work\./)).toBeTruthy();
    expect(document.querySelector('.link-sample')).toBeNull();
    expect(screen.queryByText('See which post brings you customers')).toBeNull();
  });
});

describe('links as bars', () => {
  const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} \\d`) });
  const rows = () => [...document.querySelectorAll('.link-row-main')].map((r) => r.querySelector('.truncate')!.textContent);
  const openRows = () => [...document.querySelectorAll('.link-row-main[aria-expanded="true"]')].map((r) => r.querySelector('.truncate')!.textContent);
  const group = (name: RegExp) => screen.queryByRole('heading', { name });
  const ribbon = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}: `) });
  const listed = async () => {
    await open();
    await waitFor(() => expect(document.querySelector('.card .link-rows')).toBeTruthy());
  };
  const paid = (ref: string, visitors: number, revenue: number, over: Partial<SavedLink> = {}) => link({ ref, visitors, revenue, customers: 1, ...over });
  const manyPaid = (n: number) => Array.from({ length: n }, (_, i) => paid(`paid-${i + 1}`, 10, 100000 - i));

  it('groups links, hides empty groups and folds the ones that brought nothing', async () => {
    const user = userEvent.setup();
    links = [paid('earner', 40, 5800), link({ ref: 'busy', visitors: 90 }), link({ ref: 'older', created_at: 1 }), link({ ref: 'newer', created_at: 2 }), link({ ref: 'gone', archived_at: 5 })];
    await listed();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Bringing in money 1', 'Visits, no sales yet 1', 'No visits yet 2', 'Archived 1']);
    expect(rows()).toEqual(['earner', 'busy']);
    await user.click(screen.getByRole('button', { name: 'No visits yet 2' }));
    expect(rows()).toEqual(['earner', 'busy', 'newer', 'older']);
    await user.click(screen.getByRole('button', { name: 'Archived 1' }));
    expect(rows()).toEqual(['earner', 'busy', 'newer', 'older', 'gone']);
    expect(row('earner').textContent).toContain('40 visitors');
    expect(document.body.textContent).toContain('Each side has its own scale: a full blue bar is 90 visitors, a full amber bar is $58.');
  });

  it('shows new links at once when there is nothing else, and says "period" in a period', async () => {
    const user = userEvent.setup();
    links = [link({ ref: 'one' }), link({ ref: 'two' })];
    await listed();
    expect(rows()).toHaveLength(2);
    expect(group(/Bringing in money|Archived/)).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Period' }));
    await user.click(await screen.findByRole('option', { name: 'Last 30 days' }));
    await waitFor(() => expect(group(/No visits in this period/)).toBeTruthy());
  });

  it('opens one row at a time, with the figures, the URL and the QR code', async () => {
    const user = userEvent.setup();
    links = [
      paid('x-launch', 422, 96500, { label: 'Launch tweet', customers: 5, created_by: 'agt_1', destination: 'https://shipkit.dev/pricing?utm_source=x&utm_medium=social' }),
      link({ ref: 'quiet', visitors: 3 }),
    ];
    await listed();
    const launch = row('Launch tweet');
    expect(launch.getAttribute('aria-expanded')).toBe('false');
    await user.click(launch);
    expect(openRows()).toEqual(['Launch tweet']);
    const card = screen.getByRole('region', { name: /^Launch tweet/ });
    expect(launch.getAttribute('aria-controls')).toBe(card.id);
    for (const text of ['https://shipkit.dev/pricing?utm_source=x&utm_medium=social&ref=x-launch', '1.2% paid', '$2.29 per visitor', '$965', 'Opens /pricing', 'Created Nov 2, 2026 by an agent']) {
      expect(card.textContent).toContain(text);
    }
    expect(within(card).getByRole('img', { name: /^QR code that opens/ })).toBeTruthy();
    for (const f of ['SVG', 'PNG']) expect(within(card).getByRole('button', { name: `Download the QR code for Launch tweet as ${f}` })).toBeTruthy();
    expect(document.querySelector('button button')).toBeNull();
    await user.click(row('quiet'));
    expect(openRows()).toEqual(['quiet']);
    await user.click(row('quiet'));
    expect(openRows()).toEqual([]);
  });

  it('prints refunds and missing visits without broken numbers', async () => {
    const user = userEvent.setup();
    links = [link({ ref: 'refunded', visitors: 47, customers: 1, revenue: -3000 }), link({ ref: 'evened', visitors: 5, customers: 1 }), paid('no-visits', 0, 900), link({ ref: 'fresh' })];
    await listed();
    expect(row('refunded').textContent).toContain('-$30');
    expect(row('refunded').textContent).toContain('-$0.64 per visitor, refunded');
    expect(row('evened').textContent).toContain('$0 per visitor, refunded or free');
    await user.click(screen.getByRole('button', { name: /^No visits yet/ }));
    for (const name of ['refunded', 'evened', 'no-visits', 'fresh']) {
      await user.click(row(name));
      expect(document.querySelector('.link-card')!.textContent).not.toMatch(/NaN|Infinity|undefined/);
    }
    await user.click(row('refunded'));
    expect(document.querySelector('.link-card')!.textContent).toContain('More was refunded than paid.');
    expect([...document.querySelectorAll<HTMLElement>('.link-row-bars i')].every((i) => /^(0px|max\(2px, \d+(\.\d+)?%\))$/.test(i.style.getPropertyValue('--bar')))).toBe(true);
  });

  it('shows money per visitor on every row, or why there is none', async () => {
    const user = userEvent.setup();
    links = [paid('earner', 422, 96500, { customers: 5 }), link({ ref: 'unpaid', visitors: 370 }), paid('late', 0, 900), link({ ref: 'fresh' })];
    await listed();
    expect(document.querySelector('.link-rows-head')!.textContent).toBe('VisitorsRevenuePer visitor');
    expect(screen.getByRole('button', { name: 'earner 422 visitors $965 revenue $2.29 per visitor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'unpaid 370 visitors $0 revenue $0 per visitor' })).toBeTruthy();
    const late = screen.getByRole('button', { name: 'late 0 visitors $9 revenue no visits to divide by' });
    expect(within(late).getByText('–').getAttribute('aria-hidden')).toBe('true');
    await user.click(screen.getByRole('button', { name: /^No visits yet/ }));
    expect(screen.getByRole('button', { name: 'fresh 0 visitors $0 revenue no visits to divide by' })).toBeTruthy();
    // Customers are in the open card.
    expect(document.querySelector('.link-rows')!.textContent).not.toContain('customer');
    await user.click(row('earner'));
    expect(document.querySelector('.link-card')!.textContent).toContain('5 customers');
  });

  it('says there are no sales instead of zero rates, with "yet" only for all time', async () => {
    const user = userEvent.setup();
    links = [link({ ref: 'unpaid', visitors: 370 })];
    await listed();
    await user.click(row('unpaid'));
    const card = () => document.querySelector('.link-card')!.textContent!;
    expect(card()).toContain('No sales yet');
    expect(card()).not.toMatch(/0% paid|\$0 per visitor/);
    expect(card()).toContain('Opens your homepage');
    await user.click(screen.getByRole('combobox', { name: 'Period' }));
    await user.click(await screen.findByRole('option', { name: 'Last 30 days' }));
    await waitFor(() => expect(card()).toContain('No sales in this period'));
    expect(card()).not.toContain('yet');
  });

  it('moves for a pointer and not for a key', async () => {
    const user = userEvent.setup();
    links = [paid('one', 4, 500), link({ ref: 'quiet', visitors: 3 }), link({ ref: 'new' })];
    await listed();
    const moving = () => !!document.querySelector('[data-moving]');
    expect(moving()).toBe(false);
    await user.click(row('one'));
    expect([openRows(), moving()]).toEqual([['one'], true]);
    row('quiet').focus();
    await user.keyboard('{Enter}');
    expect([openRows(), moving()]).toEqual([['quiet'], false]);
    const fold = screen.getByRole('button', { name: /^No visits yet/ });
    await user.click(fold);
    expect(moving()).toBe(true);
    await user.keyboard(' ');
    expect([fold.getAttribute('aria-expanded'), moving()]).toEqual(['false', false]);
    ribbon('one').focus();
    await user.keyboard('{Enter}');
    expect([openRows(), moving()]).toEqual([['one'], false]);
    await user.click(ribbon('quiet'));
    expect([openRows(), moving()]).toEqual([['quiet'], true]);
  });

  it('names every icon after its link, and says what it does on hover and focus', async () => {
    const user = userEvent.setup();
    links = [paid('x-launch', 40, 900)];
    await listed();
    await user.click(row('x-launch'));
    const card = within(screen.getByRole('region', { name: /^x-launch/ }));
    const tip = () => document.querySelector('.link-hint-tip')?.textContent;
    for (const [name, text] of [['Copy link for x-launch', 'Copy link'], ['QR code for x-launch', 'QR code'], ['Archive x-launch', 'Archive. The link keeps working'], ['Download the QR code for x-launch as SVG', 'Download SVG']]) {
      const button = card.getByRole('button', { name });
      expect(button.querySelector('svg')).toBeTruthy();
      await user.hover(button);
      await waitFor(() => expect(tip()).toBe(text));
      await user.unhover(button);
      expect(tip()).toBeUndefined();
    }
    const matches = Element.prototype.matches;
    const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, q) { return q === ':focus-visible' || matches.call(this, q); });
    const archive = card.getByRole('button', { name: 'Archive x-launch' });
    while (document.activeElement !== archive) await user.tab();
    expect(tip()).toBe('Archive. The link keeps working');
    // A key gets it at once, and Escape puts it away.
    expect(document.querySelector('.link-hint-tip')!.hasAttribute('data-instant')).toBe(true);
    await user.keyboard('{Escape}');
    expect(tip()).toBeUndefined();
    spy.mockRestore();
  });

  it('copies from a closed row without opening it', async () => {
    const user = userEvent.setup();
    links = [paid('x-launch', 4, 500)];
    await listed();
    const copy = screen.getByRole('button', { name: 'Copy link for x-launch' });
    expect(copy.textContent).toBe('Copy link for x-launch');
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe('https://shipkit.dev/?ref=x-launch');
    expect(await screen.findByRole('button', { name: 'Copied link for x-launch' })).toBeTruthy();
    expect(document.querySelector('.link-row [aria-live="polite"]')!.textContent).toBe('Copied');
    expect(openRows()).toEqual([]);
  });

  it('shows 10 rows of a group, then 20 more, and carries on from the first new one', async () => {
    const user = userEvent.setup();
    links = manyPaid(45);
    await listed();
    expect(rows()).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: /^Show 20 more/ }));
    expect(rows()).toHaveLength(30);
    expect(document.activeElement).toBe(row('paid-11'));
    await user.click(screen.getByRole('button', { name: /^Show 15 more/ }));
    expect(rows()).toHaveLength(45);
    expect(screen.queryByRole('button', { name: /^Show \d+ more/ })).toBeNull();
  });

  it('searches every group once there are more than 8 links', async () => {
    const user = userEvent.setup();
    links = [...manyPaid(6), link({ ref: 'zebra-busy', visitors: 4 }), link({ ref: 'plain', label: 'Zebra new' }), link({ ref: 'gone', archived_at: 1, destination: 'https://shipkit.dev/zebra' })];
    await listed();
    const search = screen.getByRole('searchbox', { name: 'Search links' });
    expect(search.getAttribute('placeholder')).toBe('Search 9 links');
    await user.type(search, 'zebra');
    expect(rows()).toEqual(['zebra-busy', 'Zebra new', 'gone']);
    expect(group(/Bringing in money/)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('3 links found');
    await user.type(search, '-none');
    expect(rows()).toEqual([]);
    expect(document.body.textContent).toContain('No links match “zebra-none”.');
    await user.keyboard('{Escape}');
    expect(rows()).toHaveLength(7);
  });

  it('has no search for 8 links', async () => {
    links = manyPaid(8);
    await listed();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('remembers the chosen view', async () => {
    const user = userEvent.setup();
    links = [paid('one', 4, 500)];
    await listed();
    expect(screen.getByRole('button', { name: 'Bars' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Table' }));
    expect((await table()).getByText('one', { selector: 'b' })).toBeTruthy();
    expect(rows()).toEqual([]);
    cleanup();
    await open();
    expect(await table()).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Bars' }));
    expect(localStorage.getItem('dm_links_view')).toBe('"bars"');
    expect(rows()).toEqual(['one']);
  });

  it('archives and restores from the open row, keeping focus near it', async () => {
    const user = userEvent.setup();
    links = [paid('x-launch', 40, 900), paid('stays', 4, 100)];
    await listed();
    await user.click(row('x-launch'));
    await user.click(screen.getByRole('button', { name: 'Archive x-launch' }));
    const fold = await screen.findByRole('button', { name: 'Archived 1' });
    await waitFor(() => expect(document.activeElement).toBe(fold));
    expect(rows()).toEqual(['stays']);
    expect(openRows()).toEqual([]);
    await user.click(fold);
    await user.click(row('x-launch'));
    expect(document.body.textContent).toContain('Archived links keep working');
    await user.click(screen.getByRole('button', { name: 'Restore x-launch' }));
    await waitFor(() => expect(group(/^Archived/)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row('x-launch')));
    expect(openRows()).toEqual(['x-launch']);
  });

  it('opens a link that was just made, past the fold and the search', async () => {
    const user = userEvent.setup();
    links = [...manyPaid(9), ...Array.from({ length: 12 }, (_, i) => link({ ref: `new-${i}`, created_at: Date.UTC(2026, 11, i + 1) }))];
    await listed();
    await user.type(screen.getByRole('searchbox'), 'paid-1');
    await user.click(screen.getByRole('button', { name: 'New link' }));
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/is ready to share/);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(openRows()).toEqual(['Fresh']));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(scrolled.at(-1)).toBe('link-lnk_instagram-fresh-item');
  });

  describe('flow', () => {
    it('shows only with two visited links and revenue', async () => {
      const flow = () => screen.queryByRole('region', { name: 'Share of visitors and revenue per link' });
      for (const [list, shown] of [
        [[], false],
        [[paid('a', 5, 100)], false],
        [[paid('a', 5, 100), link({ ref: 'b' })], false],
        [[link({ ref: 'a', visitors: 5 }), link({ ref: 'b', visitors: 5 })], false],
        [[paid('a', 5, 100), link({ ref: 'b', visitors: 5, revenue: -100 })], false],
        [[paid('a', 5, 100), link({ ref: 'b', visitors: 5, archived_at: 1 })], false],
        [[paid('a', 5, 100), link({ ref: 'b', visitors: 5 })], true],
      ] as [SavedLink[], boolean][]) {
        links = list;
        await open();
        await waitFor(() => expect(document.querySelector('[aria-busy]')).toBeNull());
        expect(!!flow()).toBe(shown);
        cleanup();
      }
    });

    it('opens, focuses and scrolls to the row, with a click or a key', async () => {
      const user = userEvent.setup();
      links = [paid('earner', 40, 5800, { label: 'Earner' }), link({ ref: 'busy', visitors: 90 })];
      await listed();
      const busy = ribbon('busy');
      expect(busy.getAttribute('aria-label')).toBe('busy: 90 visitors, 69% of visitors. 0 customers. $0 revenue, $0 per visitor. Show details');
      await user.click(busy);
      expect(openRows()).toEqual(['busy']);
      expect(document.activeElement).toBe(row('busy'));
      expect(scrolled).toEqual(['link-lnk_busy-item']);
      ribbon('Earner').focus();
      await user.keyboard('{Enter}');
      expect(openRows()).toEqual(['Earner']);
      ribbon('busy').focus();
      await user.keyboard(' ');
      expect(openRows()).toEqual(['busy']);
      // The drawn ribbon works too.
      fireEvent.click(document.querySelector('.link-ribbon[data-link="lnk_earner"]')!);
      expect(openRows()).toEqual(['Earner']);
    });

    it('reaches a row behind "Show more", a search and the table view', async () => {
      const user = userEvent.setup();
      // Big earners first; the busiest of them is last in its group.
      links = [...manyPaid(15), paid('last', 900, 1)];
      await listed();
      expect(rows()).not.toContain('last');
      await user.click(ribbon('last'));
      expect(openRows()).toEqual(['last']);
      expect(rows()).toHaveLength(16);

      await user.click(row('last'));
      await user.type(screen.getByRole('searchbox'), 'paid-1');
      expect(rows()).not.toContain('last');
      await user.click(ribbon('last'));
      expect(openRows()).toEqual(['last']);
      expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');

      await user.click(screen.getByRole('button', { name: 'Table' }));
      await user.click(ribbon('last'));
      expect(openRows()).toEqual(['last']);
      // Looking at one link does not change the remembered view.
      expect(localStorage.getItem('dm_links_view')).toBe('"table"');
    });

    it('lights a ribbon and its row together, and shows a tooltip', async () => {
      const user = userEvent.setup();
      links = [paid('earner', 40, 5800), link({ ref: 'busy', visitors: 90 })];
      await listed();
      const drawn = document.querySelector<HTMLElement>('.link-ribbon[data-link="lnk_earner"]')!;
      const item = row('earner').closest<HTMLElement>('.link-row')!;
      await user.hover(item);
      expect(drawn.hasAttribute('data-lit')).toBe(true);
      await user.unhover(item);
      expect(drawn.hasAttribute('data-lit')).toBe(false);
      await user.hover(drawn);
      expect(item.hasAttribute('data-hot')).toBe(true);
      expect(row('busy').closest('.link-row')!.hasAttribute('data-hot')).toBe(false);
      expect(document.querySelector('.v3-tooltip')!.textContent).toBe('earnerVisitors40 (31%)Customers1Revenue$58 (100%)Per visitor$1.45');
      await user.unhover(drawn);
      expect(document.querySelector('.v3-tooltip')).toBeNull();
      // jsdom does not settle :focus-visible; a browser does after a Tab.
      const matches = Element.prototype.matches;
      const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, q) { return q === ':focus-visible' || matches.call(this, q); });
      await user.tab();
      while (document.activeElement !== ribbon('earner')) await user.tab();
      expect(item.hasAttribute('data-hot')).toBe(true);
      while (document.activeElement !== row('busy')) await user.tab();
      expect(document.querySelector('.link-ribbon[data-lit]')!.getAttribute('data-link')).toBe('lnk_busy');
      spy.mockRestore();
    });

    it('keeps the open row\'s ribbon marked, under one that is pointed at', async () => {
      const user = userEvent.setup();
      links = [paid('earner', 40, 5800), link({ ref: 'busy', visitors: 90 })];
      await listed();
      const drawn = (id: string) => document.querySelector(`.link-ribbon[data-link="lnk_${id}"]`)!;
      const kept = () => [...document.querySelectorAll('.link-ribbon[data-kept]')].map((r) => r.getAttribute('data-link'));
      expect(kept()).toEqual([]);
      await user.click(row('earner'));
      await user.unhover(row('earner'));
      expect(kept()).toEqual(['lnk_earner']);
      expect(document.querySelector('.link-flow[data-lit]')).toBeNull();
      await user.hover(drawn('busy'));
      expect(drawn('busy').hasAttribute('data-lit')).toBe(true);
      expect(drawn('earner').hasAttribute('data-lit')).toBe(false);
      await user.unhover(drawn('busy'));
      expect(document.querySelector('.link-ribbon[data-lit]')).toBeNull();
      expect(kept()).toEqual(['lnk_earner']);
      // Not while its row is out of sight.
      await user.click(screen.getByRole('button', { name: 'Table' }));
      expect(kept()).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Bars' }));
      expect(kept()).toEqual(['lnk_earner']);
      await user.click(row('earner'));
      expect(kept()).toEqual([]);
    });

    it('marks nothing for a link inside Other', async () => {
      const user = userEvent.setup();
      links = manyPaid(9);
      await listed();
      await user.click(row('paid-9'));
      expect(openRows()).toEqual(['paid-9']);
      expect(document.querySelector('[data-kept]')).toBeNull();
    });

    it('fades the first tooltip in and shows the next one at once', async () => {
      const user = userEvent.setup();
      links = [paid('earner', 40, 5800), link({ ref: 'busy', visitors: 90 })];
      await listed();
      const tip = () => document.querySelector('.link-tip');
      await user.hover(document.querySelector('.link-ribbon[data-link="lnk_earner"]')!);
      expect(tip()!.hasAttribute('data-instant')).toBe(false);
      await user.hover(document.querySelector('.link-ribbon[data-link="lnk_busy"]')!);
      expect(tip()!.hasAttribute('data-instant')).toBe(true);
      expect(tip()!.textContent).toContain('busy');
    });

    it('says how to read it, with the figures beside each ribbon', async () => {
      links = [paid('earner', 1240, 5800), link({ ref: 'busy', visitors: 90 })];
      await listed();
      expect(screen.getByText('Left: share of visitors. Right: share of revenue. Wider on the right means it earns more than its share.')).toBeTruthy();
      expect(ribbon('earner').textContent).toBe('earner1,240');
    });

    it('leaves the rest together unselectable', async () => {
      links = manyPaid(12);
      await listed();
      expect(screen.getByText(/^Other \(5 links\): 50 visitors/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Other/ })).toBeNull();
      fireEvent.click(document.querySelector('.link-ribbon[data-other]')!);
      expect(openRows()).toEqual([]);
    });
  });
});

describe('Overview, Tagged links tab', () => {
  it('sends an empty tab to the new link form', () => {
    const dash = { site, money: (n: number) => `$${n}`, addFilter: () => {} } as unknown as Dash;
    render(h(DashContext.Provider, { value: dash }, h(RevenueSources, { tab: 'ref', onTab: () => {}, rows: [], totalRevenue: 0 })));
    expect(screen.getByRole('link', { name: 'Build a link' }).getAttribute('href')).toBe('/links?site=s1&new=1');
  });
});
