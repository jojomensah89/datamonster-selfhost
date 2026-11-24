import type { Hono } from 'hono';
import { byCategory, CATEGORY_LABEL, directoriesMarkdown, DIRECTORY_NOTE, filterDirectories, parseDirectoryFilter } from '../shared/directories';
import type { AppEnv } from './env';
import { sharePage } from './share';

const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' };
const TITLE = 'Launch directories | DataMonster';
const DESCRIPTION = 'A list of places to launch your product, for you and your agent.';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The public list of launch directories: a page, and the same list as JSON and Markdown for agents. */
export function mountDirectories(app: Hono<AppEnv>) {
  const listed = (url: string) => filterDirectories(parseDirectoryFilter(new URL(url).searchParams));

  app.get('/directories.json', (c) =>
    c.body(JSON.stringify({ note: DIRECTORY_NOTE, directories: listed(c.req.url) }, null, 2), 200, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' }),
  );
  app.get('/directories.md', (c) => c.body(directoriesMarkdown(listed(c.req.url)), 200, { ...HEADERS, 'Content-Type': 'text/markdown; charset=utf-8' }));

  app.on('GET', ['/directories', '/directories/'], async (c) => {
    const index = await c.env.ASSETS.fetch(new URL('/', c.req.url));
    // The app's own headers (framing, referrer policy) stay.
    const { html: page, headers } = await sharePage(index, c.req.url, '/directories');
    // For agents and crawlers that read the page without JavaScript.
    const plain = byCategory(listed(c.req.url))
      .map(([cat, rows]) => `<h2>${esc(CATEGORY_LABEL[cat])}</h2><ul>${rows.map((d) => `<li><a href="${esc(d.url)}">${esc(d.name)}</a></li>`).join('')}</ul>`)
      .join('');
    const html = page
      .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${TITLE}</title>`)
      .replace(/(<meta\b[^>]*\bname="description"[^>]*\bcontent=")[^"]*/i, (_, a: string) => a + DESCRIPTION)
      .replace(/(<link\b[^>]*\brel="canonical"[^>]*\bhref=")[^"]*/i, (_, a: string) => `${a}https://datamonster.dev/directories`)
      .replace(
        /<\/head>/i,
        () => '<link rel="alternate" type="text/markdown" href="/directories.md"><link rel="alternate" type="application/json" href="/directories.json"></head>',
      )
      .replace(/<\/body>/i, () => `<noscript><h1>Launch directories</h1><p>${esc(DIRECTORY_NOTE)}</p>${plain}</noscript></body>`);
    return new Response(html, { headers });
  });
}
