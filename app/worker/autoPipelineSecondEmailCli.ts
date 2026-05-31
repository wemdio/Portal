/**
 * One-shot CLI: backfill ВТОРОЙ почты (email2) для собранных dry-run контактов.
 * Перескрейпивает домены, берёт адрес ≠ первичного, валидирует, пишет email2.
 *
 * Self-invoking (как autoPipelineCron) — для прод-контейнера:
 *   docker exec portal-worker-hh node /app/workers/autoPipelineSecondEmailCli.js <client_user_id> [limit]
 *
 * Метрики: found2 — у скольки доменов есть 2-я почта; ready2 — у скольки она
 * готова (= столько новых контактов добавится).
 */

import { runSecondEmailBackfill } from '@/lib/jobs/autoPipelineSecondEmailBackfill';

async function main(): Promise<number> {
  const clientId = process.argv[2];
  if (!clientId) {
    console.error('[2nd-email][FATAL] укажи client_user_id первым аргументом');
    return 1;
  }
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

  console.log(`[2nd-email] перескрейп 2-й почты для ${clientId}${limit ? ` (limit=${limit})` : ''}…`);
  const r = await runSecondEmailBackfill(clientId, limit);
  console.log(
    `[2nd-email] РЕЗУЛЬТАТ: total=${r.total} scraped=${r.scraped} found2=${r.found2} ready2=${r.ready2} errors=${r.errors}`,
  );
  return r.total > 0 && r.scraped === 0 ? 1 : 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[2nd-email][FATAL]', err);
    process.exit(1);
  });
