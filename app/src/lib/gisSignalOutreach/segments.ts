/**
 * Выборка кандидатов gisSignalOutreach из 2GIS-датасета по сегментам.
 *
 * Для каждого активного сегмента (уже отсортированы по priority) стримим
 * карточки iterateTwoGisCards({ rubricGroups, hasWebsite: true }) и набираем
 * per-сегментную квоту, пропуская:
 *   - twogis_id или корпоративный домен из seen-журнала (батчевые lookup,
 *     чанк 100 —
 *     длинные 2GIS id в .in() упираются в 8K-лимит URL nginx, см. seenCompanies);
 *   - twogis_id со свежей проверкой в архиве gis_signal_company_signals
 *     (filterRecentlyCheckedIds, окно RECHECK_AFTER_DAYS=30: отсеянные вчера
 *     reject'ы не перепроверяем, через 30+ дней сайт мог восстановиться);
 *   - id/сайт, уже взятые РАНЕЕ в этом прогоне другим сегментом (cross-segment
 *     дедуп: рубрики сегментов и карточки филиалов пересекаются, компанию
 *     забирает ПЕРВЫЙ по приоритету сегмент).
 *
 * Квота: daily_limit делится на enabled-сегменты ПОРОВНУ (floor), остаток
 * деления раздаётся первым сегментам по одному (priority ASC). Осознанно
 * простая схема — пропорционально размеру рубрики считать нечем, а равные
 * доли предсказуемы и документируемы. Недобранная квота одного сегмента
 * другим НЕ передаётся (сегменты — независимые воронки).
 *
 * ИЗОЛЯЦИЯ: единственный санкционированный импорт из outreachos —
 * seenEmployers (обратный кросс-дедуп §4.2 дизайн-дока top-up'а: не писать
 * компаниям, которым OutreachOS писал за последние 45 дней). Mailganer-стек
 * по-прежнему не импортируется нигде.
 */

import 'server-only';
import { deriveDomain } from '@/lib/jobs/hhAutoParser';
import { RECONTACT_AFTER_DAYS, loadRecentlySeenDomains } from '@/lib/outreachos/seenEmployers';
import { iterateTwoGisCards } from '@/lib/twoGis/repository';
import type { TwoGisCard } from '@/lib/twoGis/types';
import { toTwoGisRubricGroups, type GisSignalSegment } from './config';
import { filterUnseenDomains, filterUnseenIds, filterRecentlyCheckedIds } from './seenCompanies';

// Переэкспорт для существующих потребителей (pipelineRunner): каноническое
// определение теперь в twoGis/repository (общая точка с OutreachOS top-up).
export { getLatestTwoGisSnapshotId } from '@/lib/twoGis/repository';

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

const SHARED_SITE_HOSTS = [
  '2gis.ru',
  'business.site',
  'facebook.com',
  'hipolink.me',
  'instagram.com',
  'linktr.ee',
  'ok.ru',
  'sites.google.com',
  't.me',
  'taplink.cc',
  'taplink.ru',
  'telegram.me',
  'vk.com',
  'wa.me',
  'whatsapp.com',
  'yandex.ru',
  'youtube.com',
] as const;

function parsedCandidateSite(site: string): { host: string; path: string } | null {
  try {
    const url = new URL(site.startsWith('http') ? site : `https://${site}`);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!host) return null;
    const path = `${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`.toLowerCase();
    return { host, path };
  } catch {
    return null;
  }
}

function isSharedSiteHost(host: string): boolean {
  return SHARED_SITE_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`));
}

/** Ключ дедупа сайта: корпоративный домен либо конкретный shared-hosting URL. */
export function candidateSiteIdentity(site: string): string | null {
  const parsed = parsedCandidateSite(site);
  if (!parsed) return null;
  return isSharedSiteHost(parsed.host)
    ? `url:${parsed.host}${parsed.path}`
    : `domain:${parsed.host}`;
}

/** Домен, который безопасно сравнивать с seen-журналом между 2GIS-карточками. */
function candidateCorporateDomain(site: string): string | null {
  const parsed = parsedCandidateSite(site);
  if (!parsed || isSharedSiteHost(parsed.host)) return null;
  return parsed.host;
}

/**
 * Дневной лимит → квоты по сегментам. Порядок возврата = порядку segments
 * (уже priority ASC).
 *
 * Второй аргумент — либо ЧИСЛО сегментов (равные доли, прежнее поведение:
 * computeSegmentQuotas(100, 3) → [34, 33, 33]), либо МАССИВ ВЕСОВ
 * (gis_signal_segments.quota_weight): доля сегмента = его вес от суммы весов.
 *
 * Веса нужны потому, что базы ниш различаются на порядок: при равном делении
 * (замер 18.08.2026) мебели с её 54 тыс. компаний хватало на 135 рабочих дней,
 * а консалтингу с 3,6 тыс. — на девять. Веса пропорционально остатку выравнивают
 * это: все ниши вырабатываются примерно одновременно, а не по очереди.
 *
 * Остаток от деления раздаётся по наибольшей дробной части (метод наибольших
 * остатков), при равенстве — более приоритетному сегменту. Сумма квот всегда
 * равна dailyLimit.
 *
 * Защиты: отрицательный/нечисловой вес считается нулём (сегмент не тянется —
 * это законный способ поставить нишу на паузу, не выключая её); но если НУЛЕВЫМИ
 * оказались ВСЕ веса, делим поровну — иначе одна кривая строка в конфиге молча
 * оставила бы весь прогон без работы.
 */
export function computeSegmentQuotas(
  dailyLimit: number,
  segmentsOrWeights: number | number[],
): number[] {
  const weights =
    typeof segmentsOrWeights === 'number'
      ? Array.from({ length: Math.max(0, Math.floor(segmentsOrWeights)) }, () => 1)
      : segmentsOrWeights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  if (weights.length === 0) return [];

  const limit = Number.isFinite(dailyLimit) && dailyLimit > 0 ? Math.floor(dailyLimit) : 0;
  if (limit === 0) return weights.map(() => 0);

  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  const effective = weightSum > 0 ? weights : weights.map(() => 1);
  const effectiveSum = weightSum > 0 ? weightSum : effective.length;

  const exact = effective.map((w) => (limit * w) / effectiveSum);
  const quotas = exact.map((x) => Math.floor(x));
  let rest = limit - quotas.reduce((sum, q) => sum + q, 0);
  const byFraction = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % byFraction.length) {
    quotas[byFraction[k].i] += 1;
    rest -= 1;
  }
  return quotas;
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
  const quotas = computeSegmentQuotas(opts.dailyLimit, segments.map((s) => s.quota_weight));
  const takenIds = new Set<string>(); // cross-segment дедуп этого прогона
  const takenSiteIdentities = new Set<string>();
  const out: SegmentCandidate[] = [];

  // Обратный кросс-дедуп (§4.2 дизайн-дока 2026-08-11-outreachos-2gis-topup):
  // компании, которым OutreachOS (HH+SJ или 2GIS top-up) писал за последние
  // RECONTACT_AFTER_DAYS дней, этот пайплайн не трогает — общий ключ миров =
  // домен сайта. Единое окно ре-контакта 45д (решение §7.3 дока).
  const outreachosSeenDomains = await loadRecentlySeenDomains(RECONTACT_AFTER_DAYS);

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
    let seenDropped = 0;
    let seenDomainDropped = 0;
    let recentDropped = 0;
    let duplicateSiteDropped = 0;
    let outreachosDropped = 0;

    for await (const batch of iterateTwoGisCards(filters, { snapshotId: opts.snapshotId })) {
      scanned += batch.length;
      // Дедуп внутри батча + против уже взятых в этом прогоне.
      const fresh = batch.filter((c) => c.id && c.website && !takenIds.has(c.id));
      // Сначала seen-журнал (залитые — навсегда)…
      const unseen = await filterUnseenIds(fresh.map((c) => c.id));
      const survivors = fresh.filter((c) => unseen.has(c.id));
      seenDropped += fresh.length - survivors.length;
      // …потом архив проверок (отсеянные за последние RECHECK_AFTER_DAYS дней).
      const notCheckedRecently = await filterRecentlyCheckedIds(survivors.map((c) => c.id));
      // Один бизнес часто представлен несколькими 2GIS-карточками филиалов.
      // Успешно залитые карточки отсекаем ещё и по корпоративному домену.
      const corporateDomains = survivors
        .map((card) => candidateCorporateDomain(card.website))
        .filter((domain): domain is string => !!domain);
      const unseenDomains = await filterUnseenDomains(corporateDomains);
      for (const card of survivors) {
        if (pulled >= quota) break;
        if (!notCheckedRecently.has(card.id)) {
          recentDropped += 1;
          continue;
        }
        const corporateDomain = candidateCorporateDomain(card.website);
        if (corporateDomain && !unseenDomains.has(corporateDomain)) {
          seenDomainDropped += 1;
          continue;
        }
        const siteIdentity = candidateSiteIdentity(card.website);
        if (siteIdentity && takenSiteIdentities.has(siteIdentity)) {
          duplicateSiteDropped += 1;
          continue;
        }
        // Домен в seen-журнале OutreachOS (45д) — пропускаем: компания уже
        // получила письмо от основного пайплайна (или его 2GIS top-up'а).
        const domain = deriveDomain(card.website);
        if (domain && outreachosSeenDomains.has(domain)) {
          outreachosDropped += 1;
          continue;
        }
        takenIds.add(card.id);
        if (siteIdentity) takenSiteIdentities.add(siteIdentity);
        out.push(cardToCandidate(card, segment.key));
        pulled += 1;
      }
      if (pulled >= quota) break;
    }
    log(
      `[segments] ${segment.key}: pulled=${pulled}/${quota} ` +
        `(scanned=${scanned}, seen-id-отсев=${seenDropped}, seen-domain-отсев=${seenDomainDropped}, ` +
        `дубли-сайта-отсев=${duplicateSiteDropped}, недавние-проверки-отсев=${recentDropped}, ` +
        `outreachos-${RECONTACT_AFTER_DAYS}д-отсев=${outreachosDropped})`,
    );
  }

  return out;
}
