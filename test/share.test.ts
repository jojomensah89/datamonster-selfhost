import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import app from '../src/worker/index';

const page = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const ASSETS = { fetch: async () => new Response(page, { headers: { 'Content-Type': 'text/html', ETag: '"stored"', 'X-Frame-Options': 'DENY' } }) };
const env = { ASSETS, ADMIN_PASSWORD: 'test', SESSION_SECRET: 'throwaway' } as never;
const get = (path: string) => app.request(`https://install.test${path}`, {}, env);

describe('link previews', () => {
  it('point at the install that serves the page', async () => {
    for (const path of ['/', '/terms', '/directories', '/?ref=x']) {
      const r = await get(path);
      const html = await r.text();
      expect([r.status, r.headers.get('ETag'), r.headers.get('X-Frame-Options'), r.headers.has('X-Robots-Tag')]).toEqual([200, null, 'DENY', false]);
      for (const tag of ['property="og:image"', 'name="twitter:image"']) expect(html).toContain(`<meta ${tag} content="https://install.test/og-image.png" />`);
      expect(html).toContain(`<meta property="og:url" content="https://install.test${path.split('?')[0]}" />`);
      expect(html).not.toContain('datamonster.dev/og-image.png');
    }
  });

  it('say nothing about private or unknown paths', async () => {
    for (const [path, status] of [['/site/abc', 200], ['/nope', 404]] as const) {
      const r = await get(path);
      expect([r.status, r.headers.get('X-Robots-Tag')]).toEqual([status, 'noindex']);
      expect(await r.text()).toContain('<meta property="og:url" content="https://install.test/" />');
    }
  });

  it('come with plain text that says what the landing page says', () => {
    const landing = readFileSync(new URL('../src/dashboard/pages/Landing.tsx', import.meta.url), 'utf8');
    const words = (s: string | undefined) => s?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const plain = /<main id="plain"[\s\S]*?<\/main>/.exec(page)![0];
    expect(words(/<h1>([\s\S]*?)<\/h1>/.exec(plain)?.[1])).toBe(words(/<h1>([\s\S]*?)<\/h1>/.exec(landing)?.[1]));
    expect(words(/<p>([\s\S]*?)<\/p>/.exec(plain)?.[1])).toBe(words(/className="hero-sub[^>]*>([\s\S]*?)<\/p>/.exec(landing)?.[1]));
  });

  it('get the home page through the Worker', () => {
    expect(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).toMatch(/"run_worker_first": \["\/",/);
  });
});
