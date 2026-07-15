import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { searchCount, searchRows } from '@/lib/companiesSearch/rpcSearch';
import { getSeenStats } from '@/lib/companiesSearch/seenJournal';
import {
  getClientTariffRow,
  resolveEffectiveLimits,
  getBillingPeriodStart,
  countClientRows,
  getClientStatus,
  isClientToolAccessAllowed,
  TOOL_ACCESS_DENIED_MESSAGE,
} from '@/lib/tariffs';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export interface CompaniesSearchFilters {
  regionCodes?: string[];
  activityTypes?: string[];
  /**
   * Выбранные узлы дерева ОКВЭД-2 (любого уровня — раздел/класс/подкласс/группа/...).
   * На бэке схлопывается до минимального набора префиксов и матчится через
   * `okved_code LIKE 'X%'` в companies_directory.
   */
  okvedCodes?: string[];
  hasPhone?: boolean;
  hasEmail?: boolean;
  legalForms?: string[];
  hasWebsite?: boolean;
  hasEdo?: boolean;
  hasEgais?: boolean;
  revenueFrom?: number | null;
  revenueTo?: number | null;
  costFrom?: number | null;
  costTo?: number | null;
  employeesFrom?: number | null;
  employeesTo?: number | null;
  includeIp?: boolean;
  innList?: string[];
  countOnly?: boolean;
  limit?: number;
  /**
   * Показать и уже выгружавшиеся этим клиентом компании (seen-журнал).
   * По умолчанию false — повторы исключаются, чтобы клиент каждый месяц
   * получал СЛЕДУЮЩИЙ срез базы, а не те же первые N.
   */
  includeSeen?: boolean;
}

interface SearchResponse {
  count: number;
  rows?: Array<Record<string, unknown>>;
  remaining?: number;
  /** Всего компаний в seen-журнале клиента (для строки «уже выгружено вами»). */
  seenTotal?: number;
  /** Дата последней выгрузки (ISO) или null. */
  lastExportedAt?: string | null;
}

const MAX_LIMIT = 200;

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);

  let body: CompaniesSearchFilters;
  try {
    body = (await req.json()) as CompaniesSearchFilters;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const wantCount = body.countOnly === true;
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), MAX_LIMIT);

  const tariffRow = await getClientTariffRow(result.auth.userId);
  // Серверный гейт оплаты (страничная проверка — только UI, её можно обойти
  // прямым вызовом API). Пускаем оплаченных: active + setup; режем inactive/expired.
  if (!isClientToolAccessAllowed(getClientStatus(tariffRow))) {
    return jsonError(TOOL_ACCESS_DENIED_MESSAGE, 403);
  }
  const limits = resolveEffectiveLimits(tariffRow);
  const periodStart = getBillingPeriodStart(tariffRow);
  const usedRows = await countClientRows(result.auth.userId, periodStart);
  const remaining = Math.max(0, limits.max_rows - usedRows);

  if (!wantCount && remaining <= 0) {
    return jsonError(
      `Лимит запросов по тарифу исчерпан. Доступно 0 из ${limits.max_rows.toLocaleString('ru-RU')} запросов.`,
      429,
    );
  }

  try {
    // Дедуп по seen-журналу включён по умолчанию; галочка include_seen его снимает.
    const seenOpts = body.includeSeen === true
      ? undefined
      : { excludeSeenForUser: result.auth.userId };

    const [{ count, error: countErr }, seenStats] = await Promise.all([
      searchCount(body, seenOpts),
      getSeenStats(result.auth.userId),
    ]);
    if (countErr) return jsonError(countErr, 500);

    const response: SearchResponse = {
      count,
      remaining,
      seenTotal: seenStats.seenTotal,
      lastExportedAt: seenStats.lastExportedAt,
    };

    if (!wantCount && count > 0) {
      // Превью тоже не должно перешагивать остаток тарифа (списание идёт по
      // факту показанных строк).
      const effLimit = Math.min(limit, remaining);
      const { rows, error } = await searchRows(body, effLimit, 0, seenOpts);
      if (error) return jsonError(error, 500);
      response.rows = rows;

      const exportedCount = rows?.length ?? 0;
      if (exportedCount > 0 && supabaseAdmin) {
        await supabaseAdmin
          .from('client_companies_search_exports')
          .insert({ user_id: result.auth.userId, row_count: exportedCount });
      }
      // ВАЖНО: превью seen-журнал НЕ пишет — иначе показанные на экране строки
      // исключились бы из последующего экспорта файла. Журнал пишет только
      // реальная выгрузка (export/route.ts).
    }

    return NextResponse.json(response);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
