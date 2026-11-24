import type { Env } from '../worker/env';
import { pruneEventSourcesJob } from './prune-event-sources';
import { verifyPlacementsJob } from './verify-placements';

/**
 * Scheduled work (wrangler.jsonc "triggers.crons"): one hourly trigger, so it fits the Workers Free limit of 5 crons per account.
 * Every hour drops old per-address event counts, then runs the launch listing check (`jobsForCron`). Each job gets the env and the scheduled time;
 * jobs run one after another, and one failing job never stops the others.
 */
export type Job = (env: Env, now: number) => Promise<void>;

export const jobs: Job[] = [pruneEventSourcesJob, verifyPlacementsJob];

export async function runJobs(env: Env, now: number, list: Job[] = jobs) {
  for (const job of list) {
    try {
      await job(env, now);
    } catch (e) {
      console.error(`cron job ${job.name || 'anonymous'} failed`, e);
    }
  }
}

export const jobsForCron = (cron: string, _now = Date.now()): Job[] => {
  if (cron !== '0 * * * *') return [];
  return jobs;
};

export const scheduled: ExportedHandlerScheduledHandler<Env> = (controller, env, ctx) => {
  const now = controller.scheduledTime || Date.now();
  ctx.waitUntil(runJobs(env, now, jobsForCron(controller.cron, now)));
};
