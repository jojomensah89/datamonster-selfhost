import { describe, expect, it } from 'vitest';
import { axisDomain, axisTicks } from '../src/dashboard/lib/chartAxis';
import { fmtMoney } from '../src/dashboard/lib/format';

const gaps = (t: number[]) => new Set(t.slice(1).map((v, i) => Number((v - t[i]).toPrecision(9))));

describe('axisTicks', () => {
  it('spaces ticks evenly and covers the largest value', () => {
    for (const max of [1, 2, 3, 6, 7, 11, 42, 99, 101, 380, 4220, 123456]) {
      const t = axisTicks([0, max], 1);
      expect(gaps(t).size).toBe(1);
      expect(t[0]).toBe(0);
      expect(t[t.length - 1]).toBeGreaterThanOrEqual(max);
      expect(t.every(Number.isInteger)).toBe(true);
      expect(new Set(t).size).toBe(t.length);
    }
    expect(axisTicks([2, 6], 1)).toEqual([0, 2, 4, 6]);
  });
  it('never steps by less than a label can show', () => {
    expect(axisTicks([1], 1)).toEqual([0, 1]);
    expect(axisTicks([3], 1)).toEqual([0, 1, 2, 3]);
  });
  it('shows only 0 when there is nothing to plot', () => {
    expect(axisTicks([0, 0], 1)).toEqual([0]);
    expect(axisTicks([], 1)).toEqual([0]);
    expect(axisTicks([NaN, Infinity], 1)).toEqual([0]);
    expect(axisDomain([0])).toEqual([0, 1]);
  });
  it('fits small rates instead of stretching to 100%', () => {
    const t = axisTicks([0.004, 0.021], 0.0001);
    expect(t[t.length - 1]).toBeLessThan(0.05);
    expect(gaps(t).size).toBe(1);
  });
  it('covers refunds below zero, with a tick on 0', () => {
    const t = axisTicks([-1200, 3000], 1);
    expect(t).toContain(0);
    expect(t[0]).toBeLessThanOrEqual(-1200);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(3000);
  });
  it('can match another axis, so both sit on the same gridlines', () => {
    const left = axisTicks([6], 1);
    const right = axisTicks([12345], 1, left.length - 1);
    expect(right.length).toBe(left.length);
    expect(right[right.length - 1]).toBeGreaterThanOrEqual(12345);
  });
});

describe('fmtMoney', () => {
  it('writes cents in full, and only where they matter', () => {
    expect(fmtMoney(150, 'USD', 2)).toBe('$1.50');
    expect(fmtMoney(-150, 'USD', 2)).toBe('-$1.50');
    expect(fmtMoney(1, 'USD', 2)).toBe('$0.01');
    expect(fmtMoney(500, 'USD', 2)).toBe('$5');
    expect(fmtMoney(0, 'USD', 2)).toBe('$0');
    expect(fmtMoney(225500, 'USD', 2)).toBe('$2,255');
    expect(fmtMoney(1250, 'USD', 2)).toBe('$13');
    expect(fmtMoney(5, 'JPY', 0)).toBe('¥5');
  });
});
