/** @type {import('tailwindcss').Config} */

// DataMonster "framed sheet" tokens (design/dashboard/index.html). The frame is a low-chroma step of the brand blue;
// the brand blue (#1f54f0) goes on data and the one selected state only. Navy ink, near-black primary buttons.
//
// Every colour is a CSS variable (RGB channels) defined in src/dashboard/styles.css for light and dark, switched by
// <html data-theme>. Classes keep their names (bg-surface, text-muted …) and follow the theme; `/alpha` modifiers work.
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

// `stone` is remapped to the same tokens, so every neutral utility in the app speaks the palette in both themes.
const neutral = {
  50: v('raised'), // wells, hover rows
  100: v('rule'), // row dividers
  200: v('line'), // panel edges
  300: v('control'), // inputs, outlined buttons
  400: v('faint'), // faint text that still holds 4.5:1
  500: v('muted'), // muted text
  600: v('muted'),
  700: v('ink'),
  800: v('ink'),
  900: v('ink'),
  950: v('ink'),
};

export default {
  content: ['./src/dashboard/**/*.{ts,tsx,html}'],
  // `dark:` follows <html data-theme="dark"> (or any ancestor carrying it), not the OS setting directly.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      // The sidebar folds into a top bar and menu sheet below this width.
      screens: { frame: '861px' },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '"Segoe UI"', 'sans-serif'],
        // One job: code, tool names, tokens and URLs.
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      colors: {
        stone: neutral,
        ground: v('ground'), // the frame
        surface: v('surface'), // the sheet, cards, menus
        sheetEdge: v('sheet-edge'),
        raised: v('raised'),
        well: v('well'),
        active: v('active'),
        hover: v('hover'), // hover on the frame (sidebar rows)
        line: v('line'),
        rule: v('rule'),
        control: v('control'),
        ink: v('ink'),
        onInk: v('on-ink'), // label on an ink fill (primary button, toast)
        inkHover: v('ink-hover'),
        muted: v('muted'),
        faint: v('faint'),
        accent: v('accent'),
        accentSoft: v('accent-soft'),
        accentInk: v('accent-ink'),
        positive: v('positive'),
        negative: v('negative'),
        // Floating tooltips.
        tip: v('tip'),
        tipInk: v('tip-ink'),
        tipMuted: v('tip-muted'),
        // Code blocks: the one dark surface in the light theme, the deepest one in the dark theme.
        code: v('code'),
        codeInk: v('code-ink'),
        codeMuted: v('code-muted'),
        codeRaised: v('code-raised'),
        codeHover: v('code-hover'),
        // Status pills and notices.
        pill: v('pill'),
        pillInk: v('pill-ink'),
        posSoft: v('pos-soft'),
        posInk: v('pos-ink'),
        warnSoft: v('warn-soft'),
        warnInk: v('warn-ink'),
        warnLine: v('warn-line'),
        negSoft: v('neg-soft'),
        negInk: v('neg-ink'),
        negLine: v('neg-line'),
        live: v('live'),
        // Chart roles. Revenue is the main series and carries the brand blue; visitors take its pale partner.
        revenue: v('revenue'),
        revenueSoft: v('revenue-soft'),
        visitors: v('visitors'),
        visitorsSoft: v('visitors-soft'),
        // Kept for pages that still name it (legal): the frame colour now.
        paper: v('ground'),
      },
      boxShadow: {
        // Only what floats: menus, dialogs, toasts.
        float: 'var(--shadow-float)',
        card: 'none',
      },
      transitionTimingFunction: { out: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    },
  },
  plugins: [],
};
