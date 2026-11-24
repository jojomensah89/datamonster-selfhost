import type { Site } from './api';

/**
 * A copy-paste prompt for the site owner's coding AI (Claude Code, Cursor, Copilot…),
 * filled with this site's real values so the AI can install tracking and revenue attribution itself.
 * The API key and webhook secret are deliberately left out: the integration doesn't need them in code.
 */
export function buildAiPrompt(site: Site, origin: string, hosted = true): string {
  const script = `<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`;
  return `You are setting up DataMonster analytics + revenue attribution in this codebase. ${hosted ? 'DataMonster records visits and payments for your site:' : 'DataMonster is the self-hosted analytics I run in my own Cloudflare account:'} it shows which posts, launches and pages bring paying customers. Do the work directly in the code. Only ask me questions about things you cannot find out by reading the codebase, and ask them all together, up front, before making changes.

To stop counting your own visits, open https://${site.domain}/?dm_ignore=true once in each browser you use (undo with ?dm_ignore=false).

## My DataMonster values (already correct, use them as-is)
- Dashboard / API host: ${origin}
- Website ID: ${site.id}
- Tracked domain: ${site.domain} (all subdomains such as app.${site.domain} count as the same site)
- Revenue currency: ${site.currency}
- Script tag:
  ${script}

## Task 1: Install the tracking script on every page
- Find how this project renders the HTML <head> (e.g. Next.js app/layout.tsx or pages/_document.tsx, Vite/CRA index.html, Astro/Nuxt/SvelteKit/Remix root layout, plain HTML files, WordPress header.php…) and add the script tag so it loads on EVERY page, including the logged-in app and any subdomains that live in this repo.
- Next.js: use next/script: <Script defer data-website-id="${site.id}" src="${origin}/js/script.js" strategy="afterInteractive" />
- Keep the exact attributes. Load it once only. Single-page-app navigation is tracked automatically; do not add manual pageview calls.
- If the project has a Content-Security-Policy, allow ${origin} in script-src and connect-src.

## Task 2: Revenue attribution (most important)
The script stores two first-party cookies: \`dm_vid\` (visitor id) and \`dm_sid\` (session id). Every payment must carry the visitor id (and the session id where the provider allows it) so DataMonster knows which visitor, and which post, launch or page, brought the customer. First find which provider(s) this codebase uses, then follow only those sections.
- Search for payment code. Dodo: "dodopayments", "checkoutSessions.create", "payments.create", "subscriptions.create", "checkout.dodopayments.com". Stripe: "stripe", "checkout.sessions.create", "buy.stripe.com". Polar: "@polar-sh/sdk", "polar.checkouts.create", "buy.polar.sh", "polar.sh/checkout".
- Always MERGE into existing metadata or custom data; never drop keys that are already there.
- Reading the cookies on the server (Next.js App Router): const jar = await cookies(); jar.get('dm_vid')?.value. If the checkout API is on a different domain than the site, read the ids in the browser with window.datamonster?.attribution?.() (returns { dm_visitor_id, dm_session_id }) and send them in the request body.

### Dodo Payments
- Server-created checkouts, payments and subscriptions: metadata: { ...existing, dm_visitor_id: <dm_vid>, dm_session_id: <dm_sid> }
- Static payment links (<a href="https://checkout.dodopayments.com/buy/...">) need no change; the script adds the metadata on click. If code redirects to a payment link with JavaScript, append ?metadata_dm_visitor_id=<id>&metadata_dm_session_id=<id> yourself.
- Return page: set return_url (or ?redirect_url= on payment links) to a page on ${site.domain} that loads the script, e.g. https://${site.domain}/thanks. Dodo adds ?payment_id=... (or ?subscription_id=...); keep those params on the URL until the page has loaded.

### Stripe
- Checkout Sessions: metadata: { ...existing, dm_visitor_id: <dm_vid>, dm_session_id: <dm_sid> }
- Return page: success_url: 'https://${site.domain}/thanks?session_id={CHECKOUT_SESSION_ID}' (Stripe fills it in; that page must load the script).
- Payment Links (buy.stripe.com) need no change; the script sets client_reference_id on click unless the code already sets one.

### Polar
- API checkouts (polar.checkouts.create): metadata: { ...existing, dm_visitor_id: <dm_vid> } (customer metadata with the same key also works).
- Hosted checkout links (buy.polar.sh, polar.sh/checkout) need no change; the script adds reference_id=dm_<visitor id> and keeps an existing custom reference.
- Return page: set the success URL to 'https://${site.domain}/thanks?checkout_id={CHECKOUT_ID}' (Polar fills it in; that page must load the script).

### Webhooks
Do NOT add or change payment webhooks in this codebase for DataMonster. I connect them myself in each provider's dashboard and paste the signing secret into DataMonster:
- Dodo: ${origin}/api/webhooks/dodo/${site.id}
- Stripe: ${origin}/api/webhooks/stripe/${site.id}
- Polar: ${origin}/api/webhooks/polar/${site.id}

## Task 3: Identify logged-in users
Right after a successful login/signup (and on app load when a user session exists), call:
  window.datamonster?.('identify', { user_id: user.id, email: user.email, name: user.name })
This links anonymous visits to the person, and is a fallback for attributing payments by email.

## Task 4: Track key buttons as goals
Add data attributes to the most important calls-to-action (no JS needed), using short snake_case names:
  <button data-dm-goal="signup_click">  ·  data-dm-goal="start_trial"  ·  data-dm-goal="pricing_cta"  ·  data-dm-goal="checkout_click"
Optional details: data-dm-goal-plan="pro". From code: window.datamonster?.('goal', 'signup_completed', { plan: 'pro' }).
Track at least: the main signup/get-started button(s), pricing-page plan buttons, and the checkout/buy button. Also fire window.datamonster?.('goal', 'signup_completed') after a successful signup.

## TypeScript
If the project uses TypeScript, add a global declaration so calls type-check:
  declare global { interface Window { datamonster?: ((cmd: 'goal' | 'identify' | 'pageview', a?: any, b?: any) => void) & { attribution?: () => { dm_visitor_id?: string; dm_session_id?: string } } } }
Always call it with optional chaining (window.datamonster?.(...)) so pages never break if the script is blocked.

## Rules
- Make minimal, focused changes that match the existing code style. Don't refactor unrelated code.
- Don't hardcode secrets. None are needed for this setup.
- The script ignores localhost by default. To test locally add data-allow-localhost to the script tag temporarily (remove it before committing), or test on the deployed site.

## When you are done, reply with
1. A list of every file you changed and why.
2. Which provider(s) you found, and which checkout/payment code paths now send dm_visitor_id (and dm_session_id where supported), with their return pages. List any you could not find or were unsure about.
3. Which goals you added and where.
4. How I can verify: open the site, in DevTools → Network a POST to ${origin}/api/event returns 202, and check the dashboard for the counted visit. To stop counting your own visits, open https://${site.domain}/?dm_ignore=true once in each browser you use (undo with ?dm_ignore=false).`;
}
