/**
 * LinkedIn Outreach worker: processes active campaigns by calling runCampaignTick
 * for each campaign with status='running'.
 *
 * Concurrency model (changed 2026-05-20):
 *  - Within one LinkedIn account: campaigns run STRICTLY SERIAL. Two simultaneous
 *    invite/message bursts from the same account would race the per-account daily
 *    counter and trip LinkedIn's anti-bot detection (cooldown / restriction).
 *  - Across different accounts: campaigns run IN PARALLEL via Promise.all. Before
 *    this, a single sequential for-loop meant one daily-limited campaign with 20
 *    no-op leads × ~4 min delay would block every other account for ~80 minutes,
 *    which is what users hit on 2026-05-20 ("воркер последовательно добивает
 *    предыдущие running-кампании с уже достигнутым дневным лимитом").
 *  - Campaigns without an account_id (broken config) are grouped under the
 *    sentinel key '__no_account__' and still serialized — they'll log the
 *    misconfiguration on each tick.
 *
 * The per-account serialization is enforced here (not inside runCampaignTick)
 * because the cheapest correct unit of mutual exclusion is the worker's own
 * in-process Promise chain; a DB-level lock would cost a round-trip per tick.
 *
 * Runs every LI_CAMPAIGN_TICK_INTERVAL_MS (default 5 min).
 */

import { runCampaignTick } from '@/lib/liOutreach/campaignRunner';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const TICK_INTERVAL_MS = Number(process.env.LI_CAMPAIGN_TICK_INTERVAL_MS ?? String(5 * 60 * 1000));
const WORKER_ID = `li-outreach-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

const NO_ACCOUNT_KEY = '__no_account__';

let lastTickAt = 0;

type CampaignRow = { id: string; user_id: string; name: string; account_id: string | null };

async function runCampaignGroup(campaigns: CampaignRow[]): Promise<boolean> {
  let anyWork = false;
  for (const c of campaigns) {
    try {
      const result = await runCampaignTick(c.id, c.user_id);
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

async function pollOnce(): Promise<boolean> {
  const db = requireSupabaseAdmin(log);
  if (!db) return false;

  const now = Date.now();
  if (now - lastTickAt < TICK_INTERVAL_MS) return false;
  lastTickAt = now;

  const { data: campaigns, error } = await db
    .from('li_campaigns')
    .select('id, user_id, name, account_id')
    .eq('status', 'running')
    .order('updated_at', { ascending: true });

  if (error) {
    log('error', `Failed to fetch running campaigns: ${error.message}`);
    return false;
  }

  if (!campaigns || campaigns.length === 0) return false;

  // Group by account_id so we can run groups in parallel but campaigns within
  // a group strictly serial (see file-header rationale).
  const groups = new Map<string, CampaignRow[]>();
  for (const c of campaigns as CampaignRow[]) {
    const key = c.account_id ?? NO_ACCOUNT_KEY;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  const groupCount = groups.size;
  log(
    'info',
    `Processing ${campaigns.length} running campaign(s) across ${groupCount} account group(s)`,
  );

  const results = await Promise.all(
    Array.from(groups.values()).map((group) => runCampaignGroup(group)),
  );
  return results.some(Boolean);
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
