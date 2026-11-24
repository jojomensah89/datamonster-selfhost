#!/usr/bin/env node
// Builds the static launch-directories site into directories/dist/. Node 18+, no dependencies.
// Usage: node directories/scripts/build.mjs            (SITE_URL=https://example.com to set the canonical origin)
// The output makes no third-party requests: fonts, images, CSS and JS are all served from the same origin.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const SITE = (process.env.SITE_URL || 'https://datamonster-directories.pages.dev').replace(/\/$/, '');
const APP = 'https://datamonster.dev';
const REPO = 'https://github.com/jojomensah89/datamonster-selfhost';

// Refuse to build bad data.
execFileSync(process.execPath, [join(root, 'scripts/validate.mjs')], { stdio: 'inherit' });

const data = JSON.parse(readFileSync(join(root, 'data/directories.json'), 'utf8'));
const list = [...data].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
const verified = list.filter((d) => d.status === 'verified').length;
const newestVerified = list.filter((d) => d.status === 'verified').map((d) => d.last_checked).filter(Boolean).sort().pop() ?? null;
const newest = newestVerified;

const CATEGORIES = {
  general: 'General',
  'dev-tools': 'Developer tools',
  ai: 'AI',
  saas: 'SaaS',
  design: 'Design',
  indie: 'Indie makers',
  regional: 'Regional',
};
const PRICING = { free: 'Free', freemium: 'Free + paid', paid: 'Paid' };
const POSES = ['analysing', 'waving', 'celebrating', 'sleepy'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null);
const pricingLabel = (p) => (p ? PRICING[p] : 'Pricing unconfirmed');
const issueUrl = (name) => `${REPO}/issues/new?title=${encodeURIComponent(`Directory correction: ${name}`)}`;
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const ext = (href, text, cls = '') => `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''} rel="noopener">${text}</a>`;
const checkedLine = (d) => d.status === 'verified'
  ? `Checked on ${esc(fmtDate(d.last_checked))}: live and taking submissions.`
  : d.last_checked
    ? `Last checked on ${esc(fmtDate(d.last_checked))}, but not confirmed. Treat the details as unconfirmed.`
    : 'Not yet checked by us. Treat the details as unconfirmed.';

function layout({ title, description, path, body, jsonld }) {
  const url = `${SITE}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="theme-color" content="#1f54f0">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/assets/img/mark-192.png">
<meta name="twitter:card" content="summary">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/img/favicon-32.png">
<link rel="icon" type="image/svg+xml" href="/assets/img/mark.svg">
<link rel="preload" href="/assets/fonts/general-sans-500.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/general-sans-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css">
<link rel="alternate" type="application/json" href="/directories.json" title="Launch directories (JSON)">
<script src="/assets/flag.js"></script>
<script src="/assets/site.js" defer></script>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="page">
<header class="bar">
  <a class="brand" href="/"><img src="/assets/img/mark.svg" width="36" height="36" alt="">Launch directories</a>
  <nav aria-label="Main">
    <a class="hide-sm" href="/#list">The list</a>
    <a class="hide-sm" href="/directories.json">JSON</a>
    <a class="hide-sm" href="${REPO}/tree/main/directories" rel="noopener">Contribute</a>
    ${ext(APP, 'DataMonster', 'btn btn--blue')}
  </nav>
</header>
<main id="main">
${body}
</main>
${footer()}
</div>
</body>
</html>
`;
}

function footer() {
  const word = 'DataMonster'.split('').map((c) => `<span>${c}</span>`).join('');
  return `<footer class="foot">
  <a href="${APP}" rel="noopener" aria-label="DataMonster"><div class="blocks" aria-hidden="true">${word}</div></a>
  <div class="foot-links">
    <div><h2>The list</h2><a href="/#list">All directories</a><a href="/directories.json">directories.json</a><a href="/schema.json">JSON Schema</a></div>
    <div><h2>Help keep it right</h2>${ext(`${REPO}/issues/new?title=${encodeURIComponent('Directory correction: ')}`, 'Report a correction')}${ext(`${REPO}/tree/main/directories`, 'Add a directory')}${ext(`${REPO}/blob/main/directories/README.md`, 'How entries are checked')}</div>
    <div><h2>Licence</h2>${ext('https://creativecommons.org/licenses/by/4.0/', 'Data: CC BY 4.0')}<span>Credit “DataMonster launch directories” with a link back.</span></div>
    <div><h2>DataMonster</h2>${ext(APP, 'Revenue analytics')}<span>This site sets no cookies and loads no analytics.</span></div>
  </div>
  <div class="foot-last"><span>© ${new Date().getUTCFullYear()} DataMonster. Directory names belong to their owners; we are not affiliated with them.</span>${ext(APP, 'See which launch paid you', 'btn')}</div>
</footer>`;
}

function chip(name, value, label, checked) {
  const prefix = name === 'category' ? 'cat' : name === 'pricing' ? 'price' : name;
  const id = `${prefix}-${value}`;
  return `<input type="radio" name="${name}" id="${id}" value="${value}"${checked ? ' checked' : ''}><label for="${id}">${esc(label)}</label>`;
}

function entryRow(d, i) {
  const facts = [
    ['Category', CATEGORIES[d.category]],
    ['Pricing', pricingLabel(d.pricing)],
    d.price_note ? ['Cost', d.price_note] : null,
    ['Status', d.status === 'verified' ? `<span class="pill pill--ok">Checked ${esc(fmtDate(d.last_checked))}</span>` : '<span class="pill">Unconfirmed</span>'],
  ].filter(Boolean);
  return `<details class="entry" data-category="${d.category}" data-pricing="${d.pricing ?? 'unknown'}" data-status="${d.status}"${i === 0 ? ' open' : ''}>
  <summary><h3>${esc(d.name)}${d.status === 'unverified' ? ' <span class="pill">Unconfirmed</span>' : ''}</h3><span class="meta">${esc(CATEGORIES[d.category])} · ${esc(pricingLabel(d.pricing))}</span><span class="plus" aria-hidden="true">+</span></summary>
  <div class="panel">
    <div><p>${esc(d.how_it_works)}</p><p class="small soft" style="margin-top:10px">For: ${esc(d.audience)}</p></div>
    <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${k === 'Status' ? v : esc(v)}</dd>`).join('')}</dl>
    <div class="actions"><a class="btn btn--blue" href="/directories/${d.slug}/">Read the guide</a>${d.submit_url ? ext(d.submit_url, `Submit on ${esc(host(d.submit_url))}`, 'btn btn--light') : ''}</div>
  </div>
</details>`;
}

function indexPage() {
  const cats = Object.keys(CATEGORIES).filter((c) => list.some((d) => d.category === c));
  const free = list.filter((d) => d.pricing === 'free').length;
  const body = `
<section class="board hero" aria-labelledby="title">
  <div class="name-band rise"><h1 id="title">Where to launch your product</h1></div>
  <div class="tile statement rise" style="--d:80ms">
    <p>${list.length} launch directories, ${verified} verified${newestVerified ? ` on ${esc(fmtDate(newestVerified))}` : ''}, what each one costs and how it works.</p>
    <div class="row"><a class="btn btn--blue" href="#list">Browse the list</a><a class="btn btn--light" href="/directories.json">Get the JSON</a></div>
  </div>
  <figure class="tile tile--pic hero-pic rise" style="--d:160ms"><img class="float" src="/assets/img/monster-analysing.webp" width="640" height="640" alt="The DataMonster mascot, a blue furry monster, studying a rising chart"></figure>
  <div class="rail">
    <div class="tile tile--sky rise" style="--d:120ms"><b>${list.length}</b><span class="small">directories</span></div>
    <div class="tile tile--sky rise" style="--d:170ms"><b>${verified}</b><span class="small">checked live${newest ? ` on ${esc(fmtDate(newest))}` : ''}</span></div>
    <div class="tile tile--deep rise" style="--d:220ms"><b>${free}</b><span class="small">free to submit</span></div>
    <div class="tile tile--navy rise" style="--d:270ms"><b>0</b><span class="small">cookies or trackers here</span></div>
  </div>
  <div class="tile tile--sky facts">
    <div class="rise" style="--d:200ms"><h2>Real rules</h2><p class="small">Prices, queues and backlink conditions, read from each site.</p></div>
    <div class="rise" style="--d:260ms"><h2>Dated</h2><p class="small">Every page says when we last looked, and what we could not confirm.</p></div>
    <div class="rise" style="--d:320ms"><h2>Open data</h2><p class="small">One JSON file, CC BY 4.0, for your scripts and your agent.</p></div>
  </div>
</section>

<section class="board list" id="list" aria-labelledby="list-title">
  <div class="list-side">
    <div class="tile list-head rise"><h2 id="list-title">The list</h2><p>Open a row for the short version, or read the full guide for tips and the exact cost.</p></div>
    <form class="tile filters rise" style="--d:80ms" action="/" method="get" aria-describedby="filter-count">
      <fieldset><legend>Status</legend><div class="chips">${chip('status', 'all', 'All', true)}${chip('status', 'verified', 'Verified only')}</div></fieldset>
      <fieldset><legend>Category</legend><div class="chips">${chip('category', 'all', 'All', true)}${cats.map((c) => chip('category', c, CATEGORIES[c])).join('')}</div></fieldset>
      <fieldset><legend>Pricing</legend><div class="chips">${chip('pricing', 'all', 'Any', true)}${Object.entries(PRICING).map(([k, v]) => chip('pricing', k, v)).join('')}</div></fieldset>
      <p class="small count" id="filter-count" data-count aria-live="polite">${list.length} directories</p>
    </form>
    <figure class="tile tile--pic tile--sky rise" style="--d:160ms;min-height:240px"><img src="/assets/img/monster-waving.webp" width="480" height="480" loading="lazy" alt="The DataMonster mascot waving"></figure>
  </div>
  <div class="entries">
    ${list.map(entryRow).join('\n    ')}
    <p class="empty">Nothing matches the filters. Try another category, pricing or status.</p>
  </div>
</section>

<div class="marquee" aria-hidden="true"><div class="marquee__track">${'<span>Upvotes are not revenue.</span><span>Count what each launch paid.</span>'.repeat(3)}</div></div>

<section class="board about" aria-labelledby="about-title">
  <div class="about-head rise"><h2 id="about-title">How we keep it honest</h2></div>
  <div class="tile tile--blue rise"><b>${verified}</b><div><h3>Checked live</h3><p class="small soft">We opened the site that day and saw it taking submissions.</p></div></div>
  <div class="tile rise" style="--d:80ms"><b>${list.length - verified}</b><div><h3>Not yet confirmed</h3><p class="small">The site blocked us or hid its terms. Those pages say so and leave unknown prices blank.</p></div></div>
  <figure class="tile tile--pic tile--sky rise" style="--d:160ms"><img src="/assets/img/monster-sleepy.webp" width="480" height="480" loading="lazy" alt="The DataMonster mascot asleep on its chart"></figure>
  <div class="tile tile--navy rise" style="--d:240ms"><div><h3>Spot something wrong?</h3><p class="small soft">Each page links to a pre-filled GitHub issue. Corrections are welcome.</p></div>${ext(`${REPO}/issues/new?title=${encodeURIComponent('Directory correction: ')}`, 'Report a correction', 'btn btn--light')}</div>
</section>

${ctaRow()}`;
  return layout({
    title: `Where to launch your product: ${list.length} launch directories, ${verified} verified`,
    description: `A free, maintained list of ${list.length} places to launch a product (${verified} verified live${newestVerified ? ` on ${fmtDate(newestVerified)}` : ''}), from Product Hunt and Show HN to BetaList and Uneed: what each costs, how it works and when we last checked.`,
    path: '/',
    body,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Launch directories',
      numberOfItems: list.length,
      itemListElement: list.map((d, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/directories/${d.slug}/`, name: d.name })),
    },
  });
}

function ctaRow() {
  return `<section class="board cta" aria-labelledby="cta-title">
  <div class="tile tile--navy flank" aria-hidden="true"></div>
  <div class="tile tile--blue main rise">
    <h2 id="cta-title">See which launch actually paid you</h2>
    <p>Upvotes are not revenue. DataMonster matches each launch to the visitors it sent and the money they paid, so you know where to launch next time.</p>
    <div class="row">${ext(APP, 'Try DataMonster', 'btn btn--light')}</div>
  </div>
  <figure class="tile tile--pic flank rise" style="--d:120ms"><img src="/assets/img/monster-celebrating.webp" width="560" height="560" loading="lazy" alt="The DataMonster mascot celebrating a first sale with a gold coin"></figure>
</section>`;
}

function directoryPage(d, i) {
  const pose = POSES[i % POSES.length];
  const others = list.filter((x) => x.category === d.category && x.slug !== d.slug).slice(0, 5);
  const more = others.length ? others : list.filter((x) => x.slug !== d.slug).slice(0, 5);
  const facts = [
    ['Category', CATEGORIES[d.category]],
    ['Pricing', pricingLabel(d.pricing)],
    ['What it costs', d.price_note ?? 'Not confirmed. Check the site before you rely on it.'],
    ['Status', d.status === 'verified' ? `<span class="pill pill--ok">Checked ${esc(fmtDate(d.last_checked))}</span>` : '<span class="pill">Unconfirmed</span>'],
  ];
  const body = `
<article class="board directory" aria-labelledby="title">
  <div class="d-band rise"><nav class="crumb" aria-label="Breadcrumb"><a href="/#list">All launch directories</a></nav><h1 id="title">${esc(d.name)}</h1></div>
  <div class="tile d-statement rise" style="--d:80ms"><p>${esc(d.audience)}</p></div>
  <div class="tile tile--sky d-act rise" style="--d:140ms">
    <p class="small">${checkedLine(d)}${d.check_source ? ` Source: ${ext(d.check_source, esc(host(d.check_source) + new URL(d.check_source).pathname.replace(/\/$/, '')))}` : ''}</p>
    <div class="row">${d.submit_url ? ext(d.submit_url, 'Submit your product', 'btn btn--blue') : ''}${ext(d.url, `Visit ${esc(host(d.url))}`, 'btn btn--light')}</div>
  </div>
  <div class="tile d-facts rise" style="--d:100ms"><dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${k === 'Status' ? v : esc(v)}</dd></div>`).join('')}</dl></div>
  <section class="tile d-how rise" style="--d:160ms" aria-labelledby="how"><h2 id="how">How it works</h2><p>${esc(d.how_it_works)}</p></section>
  <figure class="tile tile--pic d-pic rise" style="--d:220ms"><img src="/assets/img/monster-${pose}.webp" width="480" height="480" alt="The DataMonster mascot, ${pose === 'sleepy' ? 'asleep on its chart' : pose}"></figure>
  <section class="tile d-tips rise" aria-labelledby="tips"><h2 id="tips">Tips before you submit</h2><ul>${d.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>
  <section class="tile tile--sky d-match rise" style="--d:80ms" aria-labelledby="match"><h2 id="match">Track what it sends you</h2><p class="small">Add ${esc(d.name)} as a launch in ${ext(APP, 'DataMonster')} and it counts the visitors and revenue that arrive from ${d.referrer_domains.map((r) => `<code>${esc(r)}</code>`).join(', ')}.</p>
    <figure class="ui" data-ui aria-label="The launch as it would be set up in DataMonster">
      <div class="ui-head"><span>Launches</span><span class="ui-btn">Add launch</span></div>
      <table><thead><tr><th scope="col">Launch</th><th scope="col">Match domain</th><th scope="col">Status</th></tr></thead>
      <tbody>${d.referrer_domains.map((r, k) => `<tr${k === 0 ? ' class="sel"' : ''}><td>${esc(d.name)}</td><td>${esc(r)}</td><td><span class="ui-tag">Draft</span></td></tr>`).join('')}</tbody></table>
      <dl class="ui-form"><div><dt>Listing URL</dt><dd>${esc(d.url.replace(/^https:\/\//, ''))}</dd></div><div><dt>Launched on</dt><dd class="ui-ph">Pick a date</dd></div><div><dt>Counts visitors from</dt><dd>${d.referrer_domains.map(esc).join(', ')}</dd></div></dl>
    </figure>
  </section>
  <section class="tile tile--navy d-fix rise" aria-labelledby="fix"><h2 id="fix">Is something here wrong?</h2><p class="small soft">Prices and rules change. Tell us and we will check it again.</p><div class="row">${ext(issueUrl(d.name), 'Report a correction', 'btn btn--light')}</div></section>
  <figure class="tile tile--pic tile--sky d-pic2 rise" style="--d:60ms"><img src="/assets/img/monster-${POSES[(i + 2) % POSES.length]}.webp" width="480" height="480" alt="The DataMonster mascot, ${POSES[(i + 2) % POSES.length] === 'sleepy' ? 'asleep on its chart' : POSES[(i + 2) % POSES.length]}"></figure>
  <section class="tile d-next rise" style="--d:80ms" aria-labelledby="next"><h2 id="next">${others.length ? `More ${esc(CATEGORIES[d.category])} directories` : 'More directories'}</h2><ul>${more.map((x) => `<li><a href="/directories/${x.slug}/">${esc(x.name)}</a> <span class="small soft">· ${esc(pricingLabel(x.pricing))}</span></li>`).join('')}</ul></section>
</article>

${ctaRow()}`;
  return layout({
    title: `Launching on ${d.name}: cost, rules and tips`,
    description: `${d.name}: ${d.how_it_works.split(/(?<=\.)\s/)[0]} ${d.price_note ?? ''}`.slice(0, 300).trim(),
    path: `/directories/${d.slug}/`,
    body,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `Launching on ${d.name}`,
      dateModified: d.last_checked ?? undefined,
      about: { '@type': 'WebSite', name: d.name, url: d.url },
      license: 'https://creativecommons.org/licenses/by/4.0/',
    },
  });
}

// ---------------------------------------------------------------- write
// Empty dist/ rather than deleting it, so a server holding the folder open does not block the build.
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });

const css = readFileSync(join(root, 'site/site.css'), 'utf8').replace(
  'CATEGORY_RULES',
  [
    '.list:has(#status-verified:checked) .entry:not([data-status="verified"]) { display: none; }',
    ...Object.keys(CATEGORIES).map((c) => `.list:has(#cat-${c}:checked) .entry:not([data-category="${c}"]) { display: none; }`),
    ...Object.keys(PRICING).map((p) => `.list:has(#price-${p}:checked) .entry:not([data-pricing="${p}"]) { display: none; }`),
  ].join('\n'),
);
writeFileSync(join(out, 'assets/site.css'), css);
cpSync(join(root, 'site/site.js'), join(out, 'assets/site.js'));
writeFileSync(join(out, 'assets/flag.js'), "document.documentElement.classList.add('js');\n");
// General Sans may be self-hosted but not redistributed (ITF Free Font License), so it is not in the repo:
// scripts/fetch-fonts.mjs downloads it into public/fonts/ and we copy it from there. Without it the site uses the system sans.
{
  const fonts = join(root, '..', 'public', 'fonts');
  if (!existsSync(join(fonts, 'GeneralSans-Medium.woff2'))) {
    try { execFileSync(process.execPath, [join(root, '..', 'scripts', 'fetch-fonts.mjs')], { stdio: 'inherit' }); } catch { /* offline: fall back */ }
  }
  mkdirSync(join(out, 'assets/fonts'), { recursive: true });
  for (const [from, to] of [['GeneralSans-Regular.woff2', 'general-sans-400.woff2'], ['GeneralSans-Medium.woff2', 'general-sans-500.woff2'], ['GeneralSans-Semibold.woff2', 'general-sans-600.woff2'], ['GeneralSans-FFL.txt', 'GeneralSans-FFL.txt']]) {
    if (existsSync(join(fonts, from))) cpSync(join(fonts, from), join(out, 'assets/fonts', to));
  }
}
cpSync(join(root, 'site/img'), join(out, 'assets/img'), { recursive: true });

writeFileSync(join(out, 'index.html'), indexPage());
list.forEach((d, i) => {
  const dir = join(out, 'directories', d.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), directoryPage(d, i));
});

// Public data: the source file as-is, plus its schema and licence.
cpSync(join(root, 'data/directories.json'), join(out, 'directories.json'));
cpSync(join(root, 'data/schema.json'), join(out, 'schema.json'));
if (existsSync(join(root, 'LICENSE-DATA.md'))) cpSync(join(root, 'LICENSE-DATA.md'), join(out, 'LICENSE-DATA.md'));

const urls = [{ loc: `${SITE}/`, lastmod: newest }, ...list.map((d) => ({ loc: `${SITE}/directories/${d.slug}/`, lastmod: d.last_checked }))];
writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`);
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

// Cloudflare Pages: open CORS on the data, a strict same-origin CSP, no cookies are ever set.
writeFileSync(join(out, '_headers'), `/*
  Content-Security-Policy: default-src 'self'; img-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Permissions-Policy: interest-cohort=(), browsing-topics=()

/directories.json
  Access-Control-Allow-Origin: *
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=3600

/schema.json
  Access-Control-Allow-Origin: *
  Content-Type: application/schema+json; charset=utf-8

/assets/*
  Cache-Control: public, max-age=86400
`);
writeFileSync(join(out, '_redirects'), '/directories / 301\n/directories/ / 301\n');
writeFileSync(join(out, '404.html'), layout({
  title: 'Page not found',
  description: 'This page does not exist.',
  path: '/404.html',
  body: `<section class="board" aria-labelledby="title"><div class="name-band"><h1 id="title">Not on the list</h1></div><div class="tile statement"><p>That page does not exist, or the directory was removed.</p><div class="row"><a class="btn btn--blue" href="/#list">See all directories</a></div></div></section>`,
}));

console.log(`✓ Built ${list.length} directory pages + index into ${out} (site URL ${SITE})`);
