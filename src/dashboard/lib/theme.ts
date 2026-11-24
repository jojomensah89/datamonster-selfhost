import { useEffect, useSyncExternalStore } from 'react';

/**
 * Light, dark or follow the system. The choice is stored per browser; index.html applies it before first paint
 * (same key, same rules), and this module keeps <html data-theme> in step afterwards.
 * The colours themselves are CSS variables in styles.css, switched by that attribute.
 */
export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const KEY = 'dm_theme';
// Set when "/" shows the app (dashboard or sign-in), not the always-light landing page; read by the pre-paint script.
const SESSION_KEY = 'dm_app';
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let pref: ThemePref = readPref();
let locks = 0; // pages that must stay light (the landing page)
const listeners = new Set<() => void>();

function systemTheme(): Theme {
  return media?.matches ? 'dark' : 'light';
}
export function resolvedTheme(): Theme {
  if (locks > 0) return 'light';
  return pref === 'system' ? systemTheme() : pref;
}

function apply() {
  const theme = resolvedTheme();
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    // A short colour cross-fade, never on first paint and never with reduced motion (the class is ignored there).
    root.classList.add('theme-switching');
    root.dataset.theme = theme;
    window.setTimeout(() => root.classList.remove('theme-switching'), 220);
  }
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#131312' : '#efede8');
  listeners.forEach((l) => l());
}

media?.addEventListener('change', () => pref === 'system' && apply());

export function setThemePref(next: ThemePref) {
  pref = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
  apply();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The stored choice and the theme actually on screen. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, resolvedTheme, () => 'light' as Theme);
  const choice = useSyncExternalStore(subscribe, () => pref, () => 'system' as ThemePref);
  return { pref: choice, theme, setPref: setThemePref };
}

/** Keep this page light whatever the choice (the marketing landing page is the brand page). */
export function useLightOnly() {
  useEffect(() => {
    locks++;
    apply();
    return () => {
      locks--;
      apply();
    };
  }, []);
}

/**
 * Called once the app knows what "/" shows: remembers it for the pre-paint script (the landing page is light,
 * the dashboard or sign-in form follows the choice) and applies the theme.
 */
export function syncTheme(rootIsLanding: boolean) {
  try {
    if (rootIsLanding) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, '1');
  } catch {}
  apply();
}

/**
 * Colours for things drawn in JS (Recharts props, map markers), which cannot read CSS variables.
 * Keep in step with the variables in styles.css.
 */
export const CHART = {
  light: {
    revenue: '#a65f16',
    visitors: '#1f54f0',
    pageviews: '#d6d1c8',
    payments: '#dfe7fd',
    axis: '#706b62',
    grid: '#f0eee9',
    cursor: 'rgba(42,41,38,0.04)',
    dotRing: '#ffffff',
    refund: '#c4242a',
    neutral: '#c1bcb3',
    bar: '#a65f16',
    barMuted: '#e5e5df',
    line: '#1f54f0',
  },
  dark: {
    revenue: '#f2b66d',
    visitors: '#91afff',
    pageviews: '#57544c',
    payments: '#2a3a6e',
    axis: '#a7a195',
    grid: '#2c2b27',
    cursor: 'rgba(255,255,255,0.05)',
    dotRing: '#1c1c1a',
    refund: '#ef6b6b',
    neutral: '#66625a',
    bar: '#f2b66d',
    barMuted: '#3b3b35',
    line: '#91afff',
  },
} as const;

export function useChartColors() {
  return CHART[useTheme().theme];
}
