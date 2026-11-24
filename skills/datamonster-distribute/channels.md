# Distribution channels

Reference for the `datamonster-distribute` skill: the kinds of places to draw a weekly plan from, how each shows up in DataMonster, and how the owner does it without spamming. Pick from here only what the data supports, or label it a test. The owner writes and publishes everything; the agent drafts, tags links and measures.

| Channel | Shows up as | How to measure it | Done right |
|---|---|---|---|
| **Communities** (subreddits, forums, Slack and Discord groups, Indie Hackers, Hacker News comments) | `channel` Organic Social or Referral; `source` such as "Reddit" or "Hacker News"; `referrer` gives the thread when the site passes it | One `create_link` ref per post (`reddit-sideproject-nov`). Chat apps strip referrers, so without the ref the visits land in Direct | Only communities the owner already takes part in. Read the rules first: many allow self-promotion only on a set day or thread, or not at all. Lead with something useful (a lesson, numbers, a free resource), say they built it, answer replies themselves. Never the same text in several places |
| **Owner's own social posts** (X, LinkedIn, Bluesky, Mastodon, Threads, YouTube) | `source` "X", "LinkedIn"...; all posts lumped together | A ref per post or thread (`x-thread-templates`); the source alone cannot tell posts apart | Posted from the owner's own account, at their own pace. No engagement pods or bought followers |
| **Newsletters** (the owner's own list, features in others' newsletters, paid sponsorships) | `channel` Email when tagged with `utm_medium=email`, else often Direct (mail clients strip referrers) | A ref per issue or placement (`nl-weekly-dev-dec`); `add_annotation` on the send day | The owner pitches editors and pays for sponsorships themselves. Only email people who opted in |
| **SEO pages** (templates, how-tos, guides on the owner's site) | `channel` Organic Search; `entry_page` shows which page brought the buyer | `get_breakdown` with `dimension: "entry_page"` and `filters: { "channel": "Organic Search" }`; give it 4 to 12 weeks | Pages that genuinely answer the question buyers search for, written or approved by the owner. No mass-generated pages, keyword stuffing or link schemes |
| **Answers in AI assistants** (ChatGPT, Claude, Perplexity, Gemini, Copilot citing the site) | `channel` AI; `source` "ChatGPT", "Perplexity"... | `get_breakdown` with `dimension: "source"` and `filters: { "channel": "AI" }`, plus `entry_page` for the cited pages | Clear public pages that state what the product does, for whom and what it costs, so assistants can cite them. No hidden text, fake reviews or planted answers |
| **Directories and launch sites** | `channel` Referral; `source` "Product Hunt"... | `list_placements` | Hand over to the `datamonster-launch` skill, which records each listing with `add_placement` and keeps the one-submission-per-directory rule |
| **Partners and integrations** (a tool that links to the owner's, a guest post, a podcast) | `channel` Referral; `referrer` shows the page | A ref per partner (`partner-acme-docs`) | The owner agrees it with the partner directly |

## Ref names

`<place>-<topic or issue>-<month>` keeps them readable later: `reddit-sideproject-nov`, `ih-pricing-story`, `li-launch-recap`, `nl-weekly-dev-dec`, `partner-acme-docs`. Lowercase letters, digits and hyphens, 2 to 49 characters, one per post, never reused.

## Reading a week

| Signal | What it suggests |
|---|---|
| Many visitors, no customers | The audience is curious but not buying, or the landing page is wrong for them. Try the best-converting page before dropping the place |
| Few visitors, a customer or two | Promising but thin. Repeat once before calling it |
| Revenue per visitor above the site-wide figure over 90 days with 3+ customers | A real channel: give it a weekly slot |
| 90 days, enough visitors, nothing paid | Pause it and spend the time on what pays |
| Spike right after a launch or feature | Check `list_annotations` and `list_placements`; a one-off is not a trend |
