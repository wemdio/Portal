/**
 * Выборка кандидатов gisSignalOutreach из 2GIS-датасета по сегментам.
 *
 * Для каждого активного сегмента (уже отсортированы по priority) стримим
 * карточки iterateTwoGisCards({ rubricGroups, hasWebsite: true }) и набираем
 * per-сегментную квоту, пропуская:
 *   - twogis_id из seen-журнала (батчевый lookup filterUnseenIds, чанк 500);
 *   - id, уже взятые РАНЕЕ в этом прогоне другим сегментом (cross-segment
 *     дедуп: рубрики сегментов пересекаются, компанию забирает ПЕРВЫЙ по
 *     приоритету сегмент — порядок массива segments решает).
 *
 * Квота: daily_limit делится на enabled-сегменты ПОРОВНУ (floor), остаток
 * деления раздаётся первым сегментам по одному (priority ASC). Осознанно
 * простая схема — пропорционально размеру рубрики считать нечем, а равные
 * доли предсказуемы и документируемы. Недобранная квота одного сегмента
 * другим НЕ передаётся (сегменты — независимые воронки).
 */

import 'server-only';
import { iterateTwoGisCards } from '@/lib/twoGis/repository';
import { twoGisDatasetQuery } from '@/lib/twoGisDataset';
import type { TwoGisCard } from '@/lib/twoGis/types';
import { toTwoGisRubricGroups, type GisSignalSegment } from './config';
import { filterUnseenIds } from './seenCompanies';

export interface SegmentCandidate {
  twogisId: string;
  segmentKey: string;
  name: string;
  site: string;
  phone: string;
  email: string;
  cityName: string;
  category: string;
  subcategory: string;
}

type Logger = (msg: string) => void;

/**
 * Равные доли + остаток первым. Порядок возврата = порядку segments
 * (который уже priority ASC): computeSegmentQuotas(100, 3) → [34, 33, 33].
 */
export function computeSegmentQuotas(dailyLimit: number, segmentCount: number): number[] {
  if (segmentCount <= 0) return [];
  const base = Math.floor(dailyLimit / segmentCount);
  const remainder = dailyLimit - base * segmentCount;
  return Array.from({ length: segmentCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Id текущего снапшота 2GIS-датасета — iterateTwoGisCards требует его явно
 * (стрим привязан к снапшоту, чтобы импорт нового среза не ломал курсор).
 * null → датасет недоступен, прогон пропускаем.
 */
export async function getLatestTwoGisSnapshotId(): Promise<number | null> {
  try {
    const rows = await twoGisDatasetQuery<{ id: string | number }>(
      `SELECT id
       FROM public.dataset_snapshots
       ORDER BY imported_at DESC
       LIMIT 1`,
    );
    const id = Number(rows[0]?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function cardToCandidate(card: TwoGisCard, segmentKey: string): SegmentCandidate {
  return {
    twogisId: card.id ?? '',
    segmentKey,
    name: card.name ?? '',
    site: card.website ?? '',
    phone: card.phone ?? '',
    email: card.email ?? '',
    cityName: card.city_name ?? '',
    category: card.category ?? '',
    subcategory: card.subcategory ?? '',
  };
}

/**
 * Тянет кандидатов по всем сегментам одного прогона. Сегменты обрабатываются
 * последовательно (порядок = приоритет) — cross-segment дедуп через takenIds.
 * Возвращает плоский список с segmentKey на каждом кандидате.
 */
export async function pullSegmentCandidates(
  segments: GisSignalSegment[],
  opts: { dailyLimit: number; snapshotId: number; log?: Logger },
): Promise<SegmentCandidate[]> {
  const log = opts.log ?? (() => {});
  const quotas = computeSegmentQuotas(opts.dailyLimit, segments.length);
  const takenIds = new Set<string>(); // cross-segment дедуп этого прогона
  const out: SegmentCandidate[] = [];

  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s];
    const quota = quotas[s];
    if (quota <= 0) continue;

    const filters = {
      rubricGroups: toTwoGisRubricGroups(segment.rubric_groups),
      hasWebsite: true,
    };
    let pulled = 0;
    let scanned = 0;

    for await (const batch of iterateTwoGisCards(filters, { snapshotId: opts.snapshotId })) {
      scanned += batch.length;
      // Дедуп внутри батча + против уже взятых в этом прогоне.
      const fresh = batch.filter((c) => c.id && c.website && !takenIds.has(c.id));
      const unseen = await filterUnseenIds(fresh.map((c) => c.id));
      for (const card of fresh) {
        if (pulled >= quota) break;
        if (!unseen.has(card.id)) continue;
        takenIds.add(card.id);
        out.push(cardToCandidate(card, segment.key));
        pulled += 1;
      }
      if (pulled >= quota) break;
    }
    log(
      `[segments] ${segment.key}: pulled=${pulled}/${quota} ` +
        `(scanned=${scanned}, seen/cross-segment отсев=${scanned - pulled})`,
    );
  }

  return out;
}
