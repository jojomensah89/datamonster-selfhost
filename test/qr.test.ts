// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QrCode, downloadQr } from '../src/dashboard/components/QrCode';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const svgOf = (value: string, extra = {}) => render(h(QrCode, { value, ...extra })).container.querySelector('svg')!;
const viewBox = (svg: Element) => svg.getAttribute('viewBox')!.split(' ').map(Number);
const pathOf = (svg: Element) => svg.querySelector('path')!.getAttribute('d')!;

describe('QrCode', () => {
  it('renders an accessible SVG with a 4-module quiet zone on white', () => {
    const svg = svgOf('https://example.com/a');
    expect(svg.getAttribute('role')).toBe('img');
    expect(screen.getByRole('img', { name: 'QR code for https://example.com/a' })).toBe(svg);
    expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('#fff');
    expect(svg.querySelector('path')!.getAttribute('fill')).toBe('#000');
    const total = viewBox(svg)[2];
    const xs = [...pathOf(svg).matchAll(/M(\d+) (\d+)h(\d+)/g)].map(m => [+m[1], +m[2], +m[3]]);
    expect(Math.min(...xs.map(m => m[0]))).toBe(4);
    expect(Math.min(...xs.map(m => m[1]))).toBe(4);
    expect(Math.max(...xs.map(m => m[0] + m[2]))).toBeLessThanOrEqual(total - 4);
    expect(Math.max(...xs.map(m => m[1] + 1))).toBeLessThanOrEqual(total - 4);
  });

  it('uses a custom label and size', () => {
    const svg = svgOf('x', { label: 'Link QR', size: 120 });
    expect(screen.getByRole('img', { name: 'Link QR' })).toBe(svg);
    expect(svg.getAttribute('width')).toBe('120');
  });

  it('gives different codes for different values', () => {
    const a = pathOf(svgOf('https://example.com/one'));
    cleanup();
    const b = pathOf(svgOf('https://example.com/two'));
    expect(a).not.toBe(b);
  });

  it('encodes a 300+ character URL and a non-ASCII URL', () => {
    const long = 'https://example.com/?ref=' + 'a'.repeat(320);
    expect(pathOf(svgOf(long)).length).toBeGreaterThan(100);
    cleanup();
    const ascii = pathOf(svgOf('https://example.com/caf'));
    cleanup();
    const utf = svgOf('https://example.com/café/日本語?q=✓');
    expect(utf.getAttribute('role')).toBe('img');
    expect(pathOf(utf)).not.toBe(ascii);
  });

  it('encodes non-ASCII as UTF-8, not Latin-1', () => {
    const a = pathOf(svgOf('é'));
    cleanup();
    const b = pathOf(svgOf('éé')); // 2 chars would match 2 bytes only under Latin-1
    cleanup();
    expect(a).not.toBe(b);
    expect(viewBox(svgOf('é'))[2]).toBe(viewBox(svgOf('ab'))[2]);
  });

  it('shows a readable fallback when the value is too long to encode', () => {
    render(h(QrCode, { value: 'x'.repeat(5000) }));
    expect(screen.getByText(/too long to fit in a QR code/i)).toBeTruthy();
    expect(document.querySelector('svg')).toBeNull();
  });
});

describe('downloadQr', () => {
  let saved: { name: string; blob: Blob }[];
  let revoked: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    saved = []; revoked = [];
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:test-${n++}`);
    URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, blob: new Blob() });
    });
  });

  it('downloads an SVG with a sanitised filename and revokes the URL', async () => {
    const fetchSpy = vi.fn(); globalThis.fetch = fetchSpy as any;
    await downloadQr('https://example.com', '../my link: "promo"/2026?.png', 'svg');
    expect(saved[0].name).toBe('my-link-promo-2026.svg');
    expect(/[\/:*?"<>|]/.test(saved[0].name)).toBe(false);
    const blob = (URL.createObjectURL as any).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toContain('<svg');
    vi.advanceTimersByTime(2000);
    expect(revoked).toEqual(['blob:test-0']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to a default name and fixes the extension', async () => {
    await downloadQr('x', '***', 'svg');
    await downloadQr('x', 'Logo.SVG', 'svg');
    expect(saved.map(s => s.name)).toEqual(['qr-code.svg', 'Logo.svg']);
  });

  it('rejects with a readable error when the PNG cannot be created', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(downloadQr('x', 'a', 'png')).rejects.toThrow(/PNG/);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects for a value too long to encode', async () => {
    await expect(downloadQr('x'.repeat(5000), 'a', 'svg')).rejects.toThrow(/too long/);
  });

  it('draws a PNG at least 1024px wide via canvas', async () => {
    const calls: any[] = [];
    const ctx = { fillRect: (...a: number[]) => calls.push(a), set fillStyle(_: string) {} };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as any);
    let size = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
      size = this.width; cb(new Blob(['png'], { type: 'image/png' }));
    });
    await downloadQr('https://example.com', 'code.png', 'png');
    expect(size).toBeGreaterThanOrEqual(1024);
    expect(saved[0].name).toBe('code.png');
    expect(calls.length).toBeGreaterThan(10);
    vi.advanceTimersByTime(2000);
    expect(revoked.length).toBe(1);
  });
});
