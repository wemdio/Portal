/**
 * One-shot CLI: промоут резерва (dry-run строк) в созданные Instantly-кампании
 * по score. Self-invoking (как autoPipelineCron) — для прод-контейнера:
 *
 *   docker exec portal-worker-hh node /app/workers/autoPipelinePromoteCli.js <client_user_id> [limit] [minScore] [maxScore]
 *
 * Тест (50 из chain3 = score ≥ 1000001):
 *   ... <client_user_id> 50 1000001
 *
 * Полный промоут всех 3 цепочек:
 *   ... <client_user_id>
 */

import { runPromoteReserve } from '@/lib/jobs/autoPipelinePromoteReserve';

async function main(): Promise<number> {
  const clientId = process.argv[2];
  if (!clientId) {
    console.error('[promote][FATAL] укажи client_user_id первым аргументом');
    return 1;
  }
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
  const minScore = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;
  const maxScore = process.argv[5] ? parseInt(process.argv[5], 10) : undefined;

  console.log(
    `[promote] клиент ${clientId}${limit ? ` limit=${limit}` : ''}${minScore != null ? ` minScore=${minScore}` : ''}${maxScore != null ? ` maxScore=${maxScore}` : ''}…`,
  );
  const r = await runPromoteReserve(clientId, { limit, minScore, maxScore });
  console.log(`[promote] РЕЗУЛЬТАТ: rows=${r.totalRows} skippedNoBucket=${r.skippedNoBucket}`);
  for (const x of r.results) {
    console.log(`  ${x.label}: домены=${x.domains} лидов=${x.leads} принято=${x.accepted} (campaign=${x.campaign})`);
  }
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[promote][FATAL]', err);
    process.exit(1);
  });
