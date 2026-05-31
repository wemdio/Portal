/**
 * One-shot CLI: backfill ОЧИЩЕННЫХ названий (company_name) для уже собранных
 * dry-run строк клиента. Чистит ТЕМ ЖЕ AI, что кнопка «Очистить названия».
 *
 * Self-invoking (как autoPipelineCron) — запускается напрямую node'ом, без
 * .mjs-обёртки, чтобы работать в прод-контейнере, где node гоняет бандлы из
 * /app/workers/:
 *
 *   docker exec portal-worker-hh node /app/workers/autoPipelineCleanNamesCli.js <client_user_id>
 *
 * Локально:
 *   npm run build:workers
 *   node --env-file=../.env dist/workers/autoPipelineCleanNamesCli.js <client_user_id>
 *
 * Печатает total / updated / changed / errors. changed≈total → чистка работает;
 * changed=0 → prod-AI не отвечает (ключ/модель/квота).
 *
 * Зачем отдельный entry — runNameBackfill использует `server-only` + Next.js
 * path aliases (@/lib/*) и тянет stepNameCleanup; esbuild (--conditions=
 * react-server) собирает граф в один файл с резолвленными alias'ами.
 */

import { runNameBackfill } from '@/lib/jobs/autoPipelineNameBackfill';

async function main(): Promise<number> {
  const clientId = process.argv[2];
  if (!clientId) {
    console.error('[clean-names][FATAL] укажи client_user_id первым аргументом');
    return 1;
  }
  // Опц. 2-й аргумент — limit для контрольного теста (напр. 50).
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

  console.log(
    `[clean-names] backfill очистки названий для клиента ${clientId}${limit ? ` (limit=${limit})` : ''}…`,
  );
  const r = await runNameBackfill(clientId, limit);
  console.log(
    `[clean-names] РЕЗУЛЬТАТ: total=${r.total} updated=${r.updated} changed=${r.changed} errors=${r.errors}`,
  );
  if (r.total > 0 && r.changed === 0) {
    console.warn(
      '[clean-names] ⚠️ ни одно имя не изменилось — prod-AI чистки не отвечает (ключ/модель/квота).',
    );
  }
  // Ошибка только если ничего не записали при наличии работы.
  return r.total > 0 && r.updated === 0 ? 1 : 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[clean-names][FATAL]', err);
    process.exit(1);
  });
