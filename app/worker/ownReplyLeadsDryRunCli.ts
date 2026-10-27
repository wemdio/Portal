import { dryRunOwnReplies } from '@/lib/ownReplyLeads/process';
import { loadOwnLeadCriteria } from '@/lib/ownReplyLeads/settings';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { createWorkerLogger, requireSupabaseAdmin } from './_shared';

/**
 * Холостой прогон квалификатора по последним ответам «N. Polza»: ничего не
 * пишет, в AMO и чат не шлёт. Запуск на 139:
 *   docker exec portal-worker-sender-leads node /app/workers/ownReplyLeadsDryRunCli.js 50
 */
const log = createWorkerLogger('own-reply-leads-dry-run');

async function main(): Promise<void> {
  const limit = Math.min(Math.max(Number(process.argv[2]) || 50, 1), 200);
  const db = requireSupabaseAdmin(log);
  if (!supabaseInstantly) throw new Error('База Instantly не настроена');
  const criteria = await loadOwnLeadCriteria(db);
  const rows = await dryRunOwnReplies(supabaseInstantly, criteria, limit, log);
  console.log(['verdict', 'campaign', 'email', 'reply', 'reason'].join('\t'));
  for (const r of rows) console.log([r.verdict, r.campaign, r.email, r.reply, r.reason].join('\t'));
  const leads = rows.filter((r) => r.verdict === 'lead').length;
  console.log(`\nИтого ${rows.length}: лидов ${leads}, не лидов ${rows.filter((r) => r.verdict === 'not_lead').length}, ошибок ${rows.filter((r) => r.verdict === 'error').length}`);
}

main().then(() => process.exit(0)).catch((err) => {
  log('error', 'Холостой прогон упал', err);
  process.exit(1);
});
