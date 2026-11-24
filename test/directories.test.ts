import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createToken } from '../src/agent/tokens';
import { agentPrompt, byCategory, CATEGORY_LABEL, DIRECTORIES, directoriesMarkdown, directoryQuery, filterDirectories, parseDirectoryFilter } from '../src/shared/directories';
import app from '../src/worker/index';
import { makeD1 } from './helpers/d1';

const ASSETS = {
  fetch: async (u: URL) =>
    new Response(new URL(u).pathname === '/' ? '<html><head><title>Old</title><meta name="description" content="old"><link rel="canonical" href="https://datamonster.dev/"></head><body></body></html>' : '', {
      headers: { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' },
    }),
};
const bindings = { ASSETS, ADMIN_PASSWORD: 'test', SESSION_SECRET: 'throwaway' };
const env = bindings as never;

describe('launch directories', () => {
  it('is a plain list: name, https address and a known category, each address once', () => {
    expect(DIRECTORIES.length).toBeGreaterThan(200);
    for (const d of DIRECTORIES) {
      expect(Object.keys(d).sort()).toEqual(['category', 'name', 'url']);
      expect(d.url).toMatch(/^https:\/\//);
      expect(CATEGORY_LABEL[d.category]).toBeTruthy();
    }
    expect(new Set(DIRECTORIES.map((d) => d.url.replace(/\/+$/, ''))).size).toBe(DIRECTORIES.length);
    expect(byCategory(DIRECTORIES).flatMap(([, rows]) => rows)).toHaveLength(DIRECTORIES.length);
  });

  it('filters by name, address and category, and ignores unknown categories', () => {
    expect(filterDirectories({ search: 'PRODUCTHUNT' }).map((d) => d.name)).toContain('Product Hunt');
    expect(filterDirectories({ category: 'press' }).every((d) => d.category === 'press')).toBe(true);
    expect(parseDirectoryFilter(new URLSearchParams('category=toString&search= x '))).toEqual({ search: 'x' });
    expect(directoryQuery({ category: 'press', search: 'a b' })).toBe('?search=a+b&category=press');
  });

  it('serves the page, JSON and Markdown to anyone', async () => {
    const json = await app.request('/directories.json?category=press', {}, env);
    expect(json.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(((await json.json()) as any).directories).toEqual(filterDirectories({ category: 'press' }));
    const md = await app.request('/directories.md', {}, env);
    expect(md.headers.get('Content-Type')).toContain('text/markdown');
    expect(await md.text()).toBe(directoriesMarkdown(DIRECTORIES));
    for (const path of ['/directories', '/directories/']) {
      const r = await app.request(path, {}, env);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(r.headers.get('X-Frame-Options')).toBe('DENY');
      expect(r.headers.has('X-Robots-Tag')).toBe(false);
      expect(html).toContain('<title>Launch directories | DataMonster</title>');
      expect(html).toContain('href="https://datamonster.dev/directories"');
      expect(html).toMatch(/<noscript>.*Product Hunt/s);
    }
    expect((await app.request('/directories/product-hunt', {}, env)).status).toBe(404);
    expect(await (await app.request('/llms.txt', {}, env)).text()).toContain('/directories.json');
  });

  it('is a read tool that needs a token and no site', async () => {
    const db = makeD1();
    const e = { ...bindings, DB: db.d1 } as never;
    expect((await app.request('/api/agent/v1/list_directories', {}, e)).status).toBe(401);
    const { secret } = await createToken(db.d1, 'admin', { name: 'directories' });
    const r = await app.request('/api/agent/v1/list_directories?category=press', { headers: { Authorization: `Bearer ${secret}` } }, e);
    expect(((await r.json()) as any).directories).toEqual(filterDirectories({ category: 'press' }));
  });

  it('keeps the human in charge in the prompt, and uses shared controls on the page', () => {
    const p = agentPrompt('https://install.test', { category: 'press' });
    expect(p).toContain('https://install.test/directories.json?category=press');
    for (const stop of ['account', 'paying', 'CAPTCHA', 'submitting']) expect(p).toContain(stop);
    const page = readFileSync(new URL('../src/dashboard/pages/Directories.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/<(select|option|details|summary|dialog|textarea|input|button)\b/);
  });
});
