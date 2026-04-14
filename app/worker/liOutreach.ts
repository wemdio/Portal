/**
 * LinkedIn Outreach worker: processes active campaigns by calling runCampaignTick
 * for each campaign with status='running'.
 *
 * Runs every LI_CAMPAIGN_TICK_INTERVAL_MS (default 5 min) and processes all
 * running campaigns sequentially.
 */

import { runCampaignTick } from '@/lib/liOutreach/campaignRunner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const TICK_INTERVAL_MS = Number(process.env.LI_CAMPAIGN_TICK_INTERVAL_MS ?? String(5 * 60 * 1000));
const WORKER_ID = `li-outreach-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

let lastTickAt = 0;

async function pollOnce(): Promise<boolean> {
  const db = requireSupabaseAdmin(log);
  if (!db) return false;

  const now = Date.now();
  if (now - lastTickAt < TICK_INTERVAL_MS) return false;
  lastTickAt = now;

  const { data: campaigns, error } = await db
    .from('li_campaigns')
    .select('id, user_id, name')
    .eq('status', 'running')
    .order('updated_at', { ascending: true });

  if (error) {
    log('error', `Failed to fetch running campaigns: ${error.message}`);
    return false;
  }

  if (!campaigns || campaigns.length === 0) return false;

  log('info', `Processing ${campaigns.length} running campaign(s)`);
  let anyWork = false;

  for (const c of campaigns) {
    try {
      const result = await runCampaignTick(c.id as string, c.user_id as string);
      if (result.processed > 0 || result.errors > 0) {
        log('info', `Campaign "${c.name}" (${c.id}): processed=${result.processed}, errors=${result.errors}`);
        anyWork = true;
      }
    } catch (err) {
      log('error', `Campaign "${c.name}" (${c.id}) tick failed`, err);
    }
  }

  return anyWork;
}

async function main(): Promise<void> {
  log('info', `Starting LinkedIn Outreach worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['li_campaigns'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
