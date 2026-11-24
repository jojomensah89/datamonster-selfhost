# DataMonster technology stack

## Runtime and hosting

- Cloudflare Workers runs the TypeScript API and scheduled handlers (`src/worker/index.ts`). `wrangler.jsonc` sets compatibility date `2025-09-01` and enables observability.
- Cloudflare D1 is the SQLite database, bound as `DB`; migrations live in `migrations/`.
- One cron trigger runs hourly (`0 * * * *`) to verify launch listings. Cron jobs are in `src/cron/`.
- Worker static assets come from `dist/`, bound as `ASSETS`. `/api/*` runs the Worker first; other asset paths use static asset handling.

## Backend and dependencies

The Worker uses Hono `^4.13.13`. TypeScript sources in `src/worker/` implement ingestion, analytics APIs, account/session/OAuth flows, payment webhooks, and agent endpoints. Cloudflare Workers types are `^5.20261023.1`.

Root package versions (semver ranges from `package.json`): React and React DOM `^18.3.1`; Vite `^6.4.5`; React Vite plugin `^4.7.0`; Tailwind CSS `^3.4.19`; Recharts `^2.15.4`; TypeScript `^5.9.3`; Vitest `^3.2.7`; Wrangler `^4.152.0`; PostCSS `^8.5.31`; Autoprefixer `^10.6.1`; concurrently `^10.0.6`; Node types `^22.20.5`; React types `^18.3.31` and `^18.3.7`.

## Dashboard

The dashboard is React 18, built with Vite. Vite serves `src/dashboard` and proxies `/api` to `http://localhost:8787`; production output is `dist/`. Tailwind uses CSS-variable color tokens from `src/dashboard/styles.css`; theme selection is based on `data-theme="dark"`. Recharts supplies charts. The live map uses generated Natural Earth land-dot masks (`src/dashboard/assets/land-dots.ts`) and country flags are fetched as separate static files.

## Tracking script and widget

The browser tracker and embeddable widget sources are in `src/tracker/` and `src/widget/`; static/public distribution assets are in `public/`. The tracker sends events to the Worker API. The widget is documented in `docs/widget.md` and supports the online widget feature. See `docs/agents.md` for agent integration details.

## Payments, authentication, and agents

Payment handling is implemented in Worker routes and migrations for Stripe, Dodo Payments, Polar, and a generic payment API. Provider webhook verification and event handling are in `src/worker/` (including `lib/crypto.ts`).

OAuth and account/session authentication are implemented in `src/worker/` and represented by migration `1002_oauth.sql`; migrations also cover accounts and login failures. Agent API and MCP server functionality are documented in `docs/agents.md`, implemented in the agent source/routes, and tested in `test/agent.test.ts` and `test/agent-write.test.ts`.

## Fonts, map data, and licenses

- General Sans is downloaded from Fontshare by `scripts/fetch-fonts.mjs` at predev/prebuild time and is not redistributed in the repository.
- IBM Plex Mono files in `public/fonts/` are licensed under SIL Open Font License 1.1; the license text is included beside the font assets.
- The 264 circle-flags country SVGs (version 2.8.3) are MIT licensed; `THIRD_PARTY_NOTICES.md` records the notice.
- Natural Earth 1:110m land data is public domain. `scripts/build-land-dots.mjs` generates the coarse display mask; it is not a boundary authority.
- `THIRD_PARTY_NOTICES.md` also records Minilytics-derived code under MIT.

`.gitattributes` normalizes text line endings to LF and marks image and font formats as binary.

## Testing and build/deploy tooling

- `npm run dev` starts Wrangler on port 8787 and Vite; `dev:api` and `dev:web` start them separately.
- `npm run build` runs Vite after downloading fonts via `prebuild`; `npm run typecheck` runs `tsc --noEmit`.
- `npm test` runs `vitest run`. `npm run smoke` and `npm run smoke:agent` run API smoke scripts.
- `db:migrate:local` and `db:migrate` apply D1 migrations locally or remotely. `seed` prepares demo data and inserts it into local D1.
- `deploy` builds, applies remote D1 migrations, then deploys the Worker with Wrangler.
- Root tooling includes `scripts/fetch-fonts.mjs`, `scripts/build-land-dots.mjs`, `scripts/seed-demo.mjs`, and smoke scripts.
