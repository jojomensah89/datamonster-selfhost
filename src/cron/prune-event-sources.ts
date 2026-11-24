import type { Env } from '../worker/env';

/** Per-address event counts (src/worker/collect.ts) and agent call counts (src/agent/tokens.ts) are only needed on the day they count. */
export async function pruneEventSourcesJob(env: Env, now: number) {
  const today = new Date(now).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM event_sources WHERE day < ?').bind(today),
    env.DB.prepare("DELETE FROM usage_monthly WHERE month LIKE '____-__-__/agent' AND month < ?").bind(today),
  ]);
}
