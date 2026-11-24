# Launch directories

A free, public, maintained list of places to launch a product (Product Hunt, Show HN, Uneed, BetaList and more), published by DataMonster as a static site with one page per directory and a `directories.json` anyone can fetch.

- **Data:** `data/directories.json`, validated against `data/schema.json`. Licensed CC BY 4.0 (`LICENSE-DATA.md`).
- **Site:** `scripts/build.mjs` writes plain HTML into `dist/`. No framework, no dependencies.
- **Privacy:** the site sets no cookies, loads no analytics and makes no third-party requests. The font (General Sans) and images are served from the same origin, and `_headers` sets a same-origin Content-Security-Policy so nothing else can be added by accident.

The `datamonster-launch` agent skill and the Launches feature (`src/agent/placements.ts`) can read the published file at `https://<site>/directories.json`. Each entry's `referrer_domains` are bare hostnames in the same form as a launch's `match_domain`.

## Entry format

```json
{
  "slug": "uneed",                       // unique, lowercase-with-dashes; page lives at /directories/<slug>/
  "name": "Uneed",
  "url": "https://www.uneed.best",
  "submit_url": "https://www.uneed.best/submit-a-tool",
  "category": "general",                 // general | dev-tools | ai | saas | design | indie | regional
  "pricing": "freemium",                 // free | paid | freemium | null (null = not confirmed)
  "price_note": "…",                     // the actual cost, or null
  "audience": "…",
  "how_it_works": "Two or three plain sentences, in your own words.",
  "tips": ["…"],
  "referrer_domains": ["uneed.best"],    // no www., no scheme
  "last_checked": "2026-11-15",          // YYYY-MM-DD or null
  "check_source": "https://www.uneed.best/pricing",  // the page you actually read, or null
  "status": "verified"                   // or "unverified"
}
```

## Adding or updating an entry

1. Open the directory's own site (not an aggregator) and read its submit or pricing page.
2. Write the entry in your own words. Never copy descriptions from list sites such as LaunchRepo, and never guess: if you could not confirm a price or rule, set the field to `null`.
3. Set `status` to `"verified"` **only** if you fetched the directory's site that day and saw that it is live and taking submissions. Then set `last_checked` to that date and `check_source` to the page you read. Otherwise use `"unverified"` and leave `last_checked` as `null` (or the date of a check that could not confirm it).
4. Keep `referrer_domains` to domains that really send visitors (for example `news.ycombinator.com`, not `ycombinator.com`). A domain may belong to one entry only.
5. Validate and build (below), then open a pull request. Corrections from readers arrive as GitHub issues titled `Directory correction: <name>`; every page links to one.

## Validate

```sh
node directories/scripts/validate.mjs
```

Checks every field against `data/schema.json` plus the rules the schema cannot express: unique slugs and referrer domains, `verified` needs a date and a source, dates are real and not in the future. Warnings flag entries last checked more than 180 days ago.

## Build

```sh
node directories/scripts/build.mjs
# or, with the real public origin for canonical URLs and the sitemap:
SITE_URL=https://directories.example.com node directories/scripts/build.mjs
```

The build validates first and refuses bad data. It writes `dist/`:

| Path | What |
| --- | --- |
| `/` | the index, filterable by status, category and pricing (CSS `:has()` does the filtering, so it works without JavaScript; the script only keeps the count and the URL in step) |
| `/directories/<slug>/` | one page per directory, with its last-checked date and a correction link |
| `/directories.json`, `/schema.json` | the data and its schema, served with `Access-Control-Allow-Origin: *` |
| `/sitemap.xml`, `/robots.txt`, `/404.html` | for search engines |
| `_headers`, `_redirects` | Cloudflare Pages headers (CSP, CORS) and redirects |

`SITE_URL` defaults to `https://datamonster-directories.pages.dev`.

To preview, serve `dist/` with any static server, for example `npx serve directories/dist`.

## Deploy

Cloudflare Pages, separately from the app:

```sh
node directories/scripts/build.mjs
npx wrangler pages deploy directories/dist --project-name datamonster-directories
```

## Files

```
directories/
  data/directories.json   the list
  data/schema.json        JSON Schema (draft 2020-12)
  scripts/validate.mjs    validator, Node 18+, no dependencies
  scripts/build.mjs       static site generator, Node 18+, no dependencies
  site/site.css           styles (the build fills in the filter rules)
  site/site.js            entrances and filter count, no tracking or storage
  site/fonts/             General Sans (Fontshare, ITF Free Font Licence), self-hosted
  site/img/               compressed DataMonster mascot images
  LICENSE-DATA.md         CC BY 4.0 for the data
```
