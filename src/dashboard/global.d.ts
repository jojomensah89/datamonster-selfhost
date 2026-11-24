// DataMonster tracker (only present on datamonster.dev; always call with optional chaining).
interface Window {
  datamonster?: ((cmd: 'goal' | 'identify' | 'pageview', a?: any, b?: any) => void) & {
    q?: unknown[];
    attribution?: () => { dm_visitor_id?: string; dm_session_id?: string };
  };
}

declare module '*.svg' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
