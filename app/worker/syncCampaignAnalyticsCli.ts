/**
 * One-shot CLI: запускает реальный мульти-аккаунтный синк аналитики кампаний
 * (syncInstantlyCampaignAnalytics) — тот же код, что воркер гоняет раз в час.
 * Нужен чтобы проверить/форсировать заполнение каталога (вкл. account-2) без
 * ожидания часового тика.
 *
 *   docker exec portal-worker-hh node /app/workers/syncCampaignAnalyticsCli.js
 */

import { syncInstantlyCampaignAnalytics } from '@/lib/tools/instantlyCampaignCatalog';

async function main(): Promise<number> {
  console.log('[sync-analytics] старт мульти-аккаунтного синка аналитики…');
  const r = await syncInstantlyCampaignAnalytics();
  console.log(`[sync-analytics] ГОТОВО: обновлено строк = ${r.rows}`);
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[sync-analytics][FATAL]', err);
    process.exit(1);
  });
