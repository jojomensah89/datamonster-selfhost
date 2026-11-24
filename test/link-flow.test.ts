import { describe, expect, it } from 'vitest';
import { FLOW_TOP, flowItems, HAIRLINE, MIN_SLOT, NARROW_BAND, NARROW_LABEL, narrowLayout, OTHER, ribbonPath, wideLayout, type FlowEnd, type FlowLayout } from '../src/dashboard/lib/linkFlow';
import { barLength, barWidth, conversionOf, count, fmtEach, fmtShare, groupLinks, groupOf, groupTitle, isEmail, noSales, opens, refundNote, rowsToShow, searchLinks, sourceOf, type SavedLink } from '../src/dashboard/lib/links';

const link = (ref: string, visitors = 0, revenue = 0, over: Partial<SavedLink> = {}): SavedLink => ({
  id: `lnk_${ref}`, ref, destination: 'https://shipkit.dev/', label: null, created_by: 'owner', created_at: 0, archived_at: null,
  url: `https://shipkit.dev/?ref=${ref}`, visitors, customers: revenue > 0 ? 1 : 0, revenue, ...over,
});
const many = (n: number, of: (i: number) => [number, number]) => Array.from({ length: n }, (_, i) => link(`l${i}`, ...of(i)));
const refs = (links: SavedLink[]) => links.map((l) => l.ref);
const total = (ns: number[]) => ns.reduce((a, n) => a + n, 0);

/** Nothing overlaps, everything is inside, and no number is broken. */
function sound(layout: FlowLayout) {
  expect(Number.isFinite(layout.height)).toBe(true);
  for (const b of layout.bands) {
    for (const e of [b.left, b.right]) {
      for (const n of [e.top, e.size, e.slotTop, e.slot]) expect(Number.isFinite(n)).toBe(true);
      expect(e.size).toBeGreaterThanOrEqual(0);
      expect(e.slotTop).toBeGreaterThanOrEqual(-0.01);
      expect(e.top).toBeGreaterThanOrEqual(e.slotTop - 0.01);
      expect(e.top + e.size).toBeLessThanOrEqual(e.slotTop + e.slot + 0.01);
      expect(e.slotTop + e.slot).toBeLessThanOrEqual(layout.height + 0.01);
    }
    expect(ribbonPath(b)).not.toMatch(/NaN|Infinity/);
  }
  for (const end of ['left', 'right'] as const) {
    layout.bands.slice(1).forEach((b, i) => {
      const above: FlowEnd = layout.bands[i][end];
      expect(b[end].slotTop).toBeGreaterThan(above.slotTop + above.slot);
    });
  }
}
/** Every end thicker than the hairline is drawn at the same scale, on both sides. */
function oneScale(layout: FlowLayout) {
  const scales = layout.bands.flatMap((b) => [
    [b.left.size, b.item.visitorShare],
    [b.right.size, b.item.revenueShare],
  ]).filter(([size]) => size > HAIRLINE).map(([size, share]) => size / share);
  for (const s of scales) expect(s).toBeCloseTo(scales[0], 6);
}

describe('link flow: which links', () => {
  it('is empty without two visited links or without revenue', () => {
    expect(flowItems([])).toEqual([]);
    expect(flowItems([link('a', 10, 100)])).toEqual([]);
    expect(flowItems([link('a', 10, 100), link('b')])).toEqual([]);
    expect(flowItems([link('a', 10), link('b', 5)])).toEqual([]);
    // Refunds as large as the sales leave no revenue.
    expect(flowItems([link('a', 10, 100), link('b', 5, -100)])).toEqual([]);
    // Archived links do not count.
    expect(flowItems([link('a', 10, 100), link('b', 5, 0, { archived_at: 1 })])).toEqual([]);
    expect(flowItems([link('a', 10, 100), link('b', 5)])).toHaveLength(2);
  });

  it('orders by revenue, then the visits that brought none', () => {
    const items = flowItems([link('none', 400), link('some', 10, 100), link('most', 5, 900), link('few', 3), link('unvisited')]);
    expect(items.map((i) => i.name)).toEqual(['most', 'some', 'none', 'few']);
  });

  it('keeps 7 and folds the rest into Other, so the shares still add up to everything', () => {
    const links = many(40, (i) => [i % 3 ? 400 - i * 9 : 3, i % 4 ? 0 : 90000 / (i + 1)]);
    const items = flowItems(links);
    expect(items).toHaveLength(FLOW_TOP + 1);
    const other = items.find((i) => i.id === OTHER)!;
    expect(other.link).toBeNull();
    expect(other.name).toBe('Other (33 links)');
    expect(total(items.map((i) => i.visitorShare))).toBeCloseTo(1);
    expect(total(items.map((i) => i.revenueShare))).toBeCloseTo(1);
    expect(total(items.map((i) => i.visitors))).toBe(total(links.map((l) => l.visitors)));
    expect(total(items.map((i) => i.revenue))).toBeCloseTo(total(links.map((l) => l.revenue)));
    // It sits between the links that earn and those that do not.
    const at = items.indexOf(other);
    expect(items.slice(0, at).every((i) => i.revenue > 0)).toBe(true);
    expect(items.slice(at + 1).every((i) => i.revenue === 0)).toBe(true);
  });

  it('shows an eighth link by name instead of an Other of one', () => {
    expect(flowItems(many(8, (i) => [10 + i, 100])).some((i) => i.id === OTHER)).toBe(false);
    expect(flowItems(many(9, (i) => [10 + i, 100])).find((i) => i.id === OTHER)!.name).toBe('Other (2 links)');
  });

  it('always includes both kinds: money without much traffic, and traffic without money', () => {
    const earners = flowItems([...many(20, () => [1, 1000]), link('busy', 2)]);
    expect(earners.some((i) => i.name === 'busy')).toBe(true);
    const traffic = flowItems([...many(20, () => [500, 0]), link('paid', 1, 10)]);
    expect(traffic[0].name).toBe('paid');
    // Every link earning a little less than the traffic it brings still leaves room for one earner.
    const flat = flowItems([...many(7, () => [1000, 0]), ...Array.from({ length: 50 }, (_, i) => link(`p${i}`, 1, 10))]);
    expect(flat.filter((i) => i.link && i.revenue > 0)).toHaveLength(1);
  });

  it('never gives refunds a share, and still prints them', () => {
    const items = flowItems([link('good', 10, 5000), link('bad', 30, -2000)]);
    expect(items.map((i) => [i.name, i.revenue, i.revenueShare])).toEqual([
      ['good', 5000, 1],
      ['bad', -2000, 0],
    ]);
  });
});

describe('link flow: layout', () => {
  const cases: Record<string, SavedLink[]> = {
    two: [link('a', 10, 100), link('b', 5)],
    even: many(8, () => [10, 100]),
    'one link at 98%': [link('big', 4900, 49), ...many(9, (i) => [10 - i, i < 3 ? 99000 : 0])],
    'one link earns all': [link('rich', 2, 99000), ...many(30, (i) => [300 - i, 0])],
    refunds: [link('a', 10, 100), link('b', 700, -90), link('c', 4, 30)],
    'no visits this period': [link('a', 10, 100), link('b', 5), link('old', 0, 900)],
    thousand: many(1000, (i) => [Math.ceil(5000 / (i + 1)), i % 3 ? 0 : Math.ceil(90000 / (i + 1))]),
  };
  for (const [name, links] of Object.entries(cases)) {
    it(`holds for ${name}`, () => {
      const items = flowItems(links);
      const wide = wideLayout(items);
      sound(wide);
      oneScale(wide);
      for (const b of wide.bands) for (const e of [b.left, b.right]) expect(e.slot).toBeGreaterThanOrEqual(MIN_SLOT);
      const narrow = narrowLayout(items);
      sound(narrow);
      oneScale(narrow);
      for (const b of narrow.bands) {
        expect(b.left.slot).toBeGreaterThanOrEqual(NARROW_BAND);
        // The text line above each ribbon stays clear of it.
        for (const e of [b.left, b.right]) expect(e.top).toBeGreaterThanOrEqual(e.slotTop + NARROW_LABEL - 0.01);
      }
    });
  }

  it('narrows to a point at no revenue, and never below a hairline otherwise', () => {
    const { bands } = wideLayout(flowItems([link('big', 100000, 100000), link('none', 50000), link('tiny', 1, 1)]));
    const of = (name: string) => bands.find((b) => b.item.name === name)!;
    expect(of('none').right.size).toBe(0);
    expect(of('none').left.size).toBeGreaterThan(20);
    expect(of('tiny').left.size).toBe(HAIRLINE);
    expect(of('tiny').right.size).toBe(HAIRLINE);
  });

  it('gives the ends of one ribbon comparable sizes: more than its share of visitors widens it', () => {
    const { bands } = wideLayout(flowItems([link('good', 100, 900), link('poor', 900, 100)]));
    expect(bands[0].right.size / bands[0].left.size).toBeCloseTo(9);
    expect(bands[1].left.size / bands[1].right.size).toBeCloseTo(9);
  });

  it('is a quarter shorter than one label of two lines each would need', () => {
    expect(wideLayout(flowItems(many(8, () => [10, 100]))).height).toBe(328);
    // A dominant link does not change the height.
    expect(wideLayout(flowItems(cases['one link at 98%'])).height).toBe(328);
  });

  it('has nothing to lay out without items', () => {
    expect(wideLayout([])).toEqual({ height: 0, bands: [] });
    expect(narrowLayout([])).toEqual({ height: 0, bands: [] });
  });
});

describe('links: groups and text', () => {
  it('sorts each group its own way', () => {
    const g = groupLinks([
      link('p2', 1, 50), link('p1', 9, 100), link('v1', 3), link('v2', 8), link('n1', 0, 0, { created_at: 1 }), link('n2', 0, 0, { created_at: 2 }),
      link('a1', 5, 500, { archived_at: 1 }), link('a2', 0, 0, { archived_at: 2 }),
    ]);
    expect(refs(g.earning)).toEqual(['p1', 'p2']);
    expect(refs(g.visited)).toEqual(['v2', 'v1']);
    expect(refs(g.unvisited)).toEqual(['n2', 'n1']);
    expect(refs(g.archived)).toEqual(['a2', 'a1']);
  });

  it('files refunded links where they can be seen, and says why', () => {
    expect(groupOf(link('a', 5, -100))).toBe('visited');
    expect(groupOf(link('a', 5, 0, { customers: 2 }))).toBe('visited');
    expect(groupOf(link('a', 0, -100))).toBe('visited');
    expect(groupOf(link('a', 0, 100))).toBe('earning');
    expect(groupOf(link('a'))).toBe('unvisited');
    expect(refundNote(link('a', 5, -100))).toBe('refunded');
    expect(refundNote(link('a', 5, 0, { customers: 2 }))).toBe('refunded or free');
    expect(refundNote(link('a', 5))).toBeNull();
    expect(refundNote(link('a', 5, 10))).toBeNull();
  });

  it('says "yet" only of all time', () => {
    expect(groupTitle('visited', true)).toBe('Visits, no sales yet');
    expect(groupTitle('unvisited', true)).toBe('No visits yet');
    expect(groupTitle('visited', false)).toBe('Visits, no sales in this period');
    expect(groupTitle('unvisited', false)).toBe('No visits in this period');
    expect(noSales(true)).toBe('No sales yet');
    expect(noSales(false)).toBe('No sales in this period');
  });

  it('finds links by name, ref and page', () => {
    const links = [link('x-launch', 0, 0, { label: 'Launch Tweet' }), link('b', 0, 0, { destination: 'https://shipkit.dev/pricing?utm_source=x' })];
    expect(refs(searchLinks(links, ' TWEET '))).toEqual(['x-launch']);
    expect(refs(searchLinks(links, 'x-lau'))).toEqual(['x-launch']);
    expect(refs(searchLinks(links, '/pric'))).toEqual(['b']);
    // The tags are not part of the page.
    expect(searchLinks(links, 'utm')).toEqual([]);
    expect(searchLinks(links, '  ')).toBe(links);
  });

  it('reveals whole steps of rows', () => {
    expect([0, 9, 10, 29, 30, 999].map(rowsToShow)).toEqual([10, 10, 30, 30, 50, 1010]);
  });

  it('names the source a link was made for', () => {
    const of = (ref: string, search = '') => sourceOf({ ref, destination: `https://shipkit.dev/${search}` });
    expect(of('anything', '?utm_source=twitter')).toBe('X');
    expect(of('reddit-post', '?utm_source=acme')).toBe('acme');
    expect(of('reddit')).toBe('Reddit');
    expect(of('hn-comment')).toBe('Hacker News');
    expect(of('podcast-3')).toBeNull();
    expect(sourceOf({ ref: 'a1', destination: 'not a url' })).toBeNull();
  });

  it('knows a link made for an email', () => {
    const of = (ref: string, search = '') => isEmail({ ref, destination: `https://shipkit.dev/${search}` });
    expect(of('nov', '?utm_source=newsletter&utm_medium=email')).toBe(true);
    expect(of('nov', '?utm_source=acme-weekly&utm_medium=email')).toBe(true);
    expect(of('newsletter-nov')).toBe(true);
    expect(of('reddit-nov', '?utm_source=reddit&utm_medium=social')).toBe(false);
    expect(of('podcast')).toBe(false);
    expect(isEmail({ ref: 'a1', destination: 'not a url' })).toBe(false);
  });

  it('says which page a link opens', () => {
    expect(opens('https://shipkit.dev/?utm_source=x&utm_medium=social')).toBe('your homepage');
    expect(opens('https://shipkit.dev/pricing?plan=pro')).toBe('/pricing?plan=pro');
    expect(refs(searchLinks([link('a'), link('b', 0, 0, { destination: 'https://shipkit.dev/docs' })], 'homepage'))).toEqual(['a']);
  });

  it('never prints a broken number', () => {
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(-5, 10)).toBe(0);
    expect(barWidth(1, 100000)).toBe(1);
    expect(barWidth(20, 10)).toBe(100);
    expect([barLength(0, 10), barLength(-5, 10), barLength(5, 10), barLength(1, 100000)]).toEqual(['0px', '0px', 'max(2px, 50%)', 'max(2px, 1%)']);
    expect([0, -1, NaN, 0.004, 0.5, 0.998, 1].map(fmtShare)).toEqual(['0%', '0%', '0%', '<1%', '50%', '>99%', '100%']);
    expect(conversionOf(link('a'))).toBeNull();
    expect(conversionOf(link('a', 10, 0, { customers: 12 }))).toBeNull();
    expect(conversionOf(link('a', 10))).toBe('0%');
    expect(conversionOf(link('a', 422, 1, { customers: 5 }))).toBe('1.2%');
    expect(conversionOf(link('a', 9000, 1))).toBe('<0.1%');
    expect(fmtEach(180, 'USD', 2)).toBe('$1.80');
    expect(fmtEach(0.4, 'USD', 2)).toBe('<$0.01');
    expect(fmtEach(0, 'USD', 2)).toBe('$0');
    expect(fmtEach(-64, 'USD', 2)).toBe('-$0.64');
    expect(fmtEach(12.4, 'JPY', 0)).toBe('¥12');
    expect(count(1, 'link')).toBe('1 link');
    expect(count(0, 'link')).toBe('0 links');
  });
});
