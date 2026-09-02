/**
 * Yandex Direct Job Runner — оркестратор.
 *
 * Читает конфиг job'а из yandex_direct_jobs, при необходимости генерирует
 * ключи (AI-режим), прогоняет XMLStock по (keyword × region), дедуплицирует
 * рекламодателей по домену и пишет в yandex_direct_results.
 *
 * Запускается из worker/index.ts.
 *
 * Защиты:
 *   - cancelled-check между запросами (юзер нажал «отменить»);
 *   - пауза между запросами к XMLStock (rate-limit аккаунта);
 *   - на ошибке отдельного запроса не падаем — пишем в errors_count.
 *
 * 02.09.2026 — единый жизненный цикл задач (app/src/lib/jobs/lifecycle.ts).
 * Из воркера функция вызывается с контекстом: курсор по номеру запроса в
 * чекпойнте, продолжение с него при следующем захвате, ограждение всех
 * записей жетоном. Без контекста поведение прежнее (worker/index.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildKeywordList } from './keywords';
import { parseXmlResponse, searchYandex, getXMLStockCreds, sleep, type XMLStockCreds } from './parser';
import { resolveRegions, type YDRegion } from './regions';

/** Пауза между запросами к XMLStock (мс). */
const REQUEST_DELAY_MS = Number(process.env.YANDEX_DIRECT_REQUEST_DELAY_MS ?? '600');

/**
 * Сколько уникальных текстов ошибок храним в `errors_sample`. Лонг-тейл редких
 * сообщений отбрасываем — обычно все ошибки укладываются в 1–3 типа,
 * 20 хватает для диагностики любых аномальных прогонов.
 */
const MAX_ERROR_GROUPS = 20;

interface YDJobRow {
  id: string;
  user_id: string;
  niche: string;
  keyword_mode: 'manual' | 'ai';
  audience: string;
  n_seeds: number;
  expand_suggest: boolean;
  include_organic: boolean;
  keywords: string[];
  regions: string[];
  status: string;
  processed_requests: number | null;
  found_advertisers: number | null;
  saved_total: number | null;
  errors_count: number | null;
  errors_sample: YDErrorGroup[] | null;
}

/**
 * Курсор задачи: номер последнего пройденного запроса в развёртке
 * регионы × ключи.
 *
 * Позиционный курсор здесь законен только при одной и той же
 * последовательности между заходами, и это условие пришлось обеспечивать
 * специально:
 *   - регионы берутся из `yandex_direct_jobs.regions` (массив в строке
 *     задачи) и раскрываются чистой функцией resolveRegions — порядок
 *     воспроизводится дословно;
 *   - ключи в ручном режиме лежат в `keywords` той же строки;
 *   - ключи в AI-режиме генерировались КАЖДЫЙ раз заново (LLM + Yandex
 *     Suggest), то есть при продолжении список был бы другой, а курсор по
 *     номеру указывал бы в другую пару. Поэтому генерация теперь идёт только
 *     при пустом `keywords`, а сгенерированный список сохраняется в строку
 *     задачи ДО первого запроса и переиспользуется при продолжении.
 * Дедуп Set по ключам порядок вставки сохраняет, обхода Map/Set по хешу нет.
 */
export interface YandexDirectCheckpoint {
  processed_requests: number;
}

/**
 * Контекст исполнения под единым жизненным циклом. Необязателен.
 */
export interface YandexDirectRunContext {
  /** Взводится на SIGTERM, при потере аренды и при перехвате строки. */
  signal: AbortSignal;
  /** Жетон захвата: им ограждается КАЖДАЯ запись в строку задачи. */
  runToken: string;
  /** Чекпойнт прошлого захвата — с него продолжаем. */
  checkpoint?: YandexDirectCheckpoint | null;
  /** false — строку перехватили, работу надо прекратить. */
  saveCheckpoint(data: YandexDirectCheckpoint): Promise<boolean>;
}

/** Терминальная запись снимает владение вместе со статусом. */
const CLEAR_OWNERSHIP = { lease_until: null, run_token: null, worker_id: null };

interface YDErrorGroup {
  message: string;
  count: number;
  first_keyword: string;
  first_region: string;
  last_seen_at: string;
}

function normalizeErrorMessage(msg: string): string {
  return msg.trim().replace(/\s+/g, ' ').slice(0, 300) || '(пустое сообщение)';
}

function recordError(
  groups: Map<string, YDErrorGroup>,
  rawMessage: string,
  keyword: string,
  regionName: string,
): void {
  const message = normalizeErrorMessage(rawMessage);
  const existing = groups.get(message);
  const nowIso = new Date().toISOString();
  if (existing) {
    existing.count += 1;
    existing.last_seen_at = nowIso;
    return;
  }
  if (groups.size >= MAX_ERROR_GROUPS) return;
  groups.set(message, {
    message,
    count: 1,
    first_keyword: keyword,
    first_region: regionName,
    last_seen_at: nowIso,
  });
}

function errorsToJson(groups: Map<string, YDErrorGroup>): YDErrorGroup[] {
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

async function isCancelled(db: SupabaseClient, jobId: string): Promise<boolean> {
  const { data } = await db
    .from('yandex_direct_jobs')
    .select('status')
    .eq('id', jobId)
    .maybeSingle();
  return data?.status === 'cancelled';
}

/**
 * Запись в строку задачи.
 *
 * Возвращает, ЛЕГЛА ЛИ правка: под ограждением жетоном update по перехваченной
 * строке совпадает с нулём строк и НЕ возвращает ошибку — молчаливый ноль тут
 * неотличим от успеха, если на него не смотреть. Для записей-индикаторов это
 * терпимо (прогресс перепишется следующей), но там, где от факта записи
 * зависит дальнейшая работа, результат обязателен к проверке.
 */
async function updateJob(
  db: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
  ctx?: YandexDirectRunContext,
): Promise<boolean> {
  const query = db.from('yandex_direct_jobs').update(patch).eq('id', jobId);
  // Тип билдера — any по той же причине, что в lib/jobs/lifecycle.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fenced = ctx ? (query as any).eq('run_token', ctx.runToken) : query;
  const { data, error } = await fenced.select('id');
  if (error) {
    console.error(`[yandex-direct][${jobId}] updateJob failed:`, error.message);
    return false;
  }
  return Array.isArray(data) ? data.length > 0 : !!data;
}

/** Восстанавливает накопленные группы ошибок из строки задачи при продолжении. */
function seedErrorGroups(sample: YDErrorGroup[] | null): Map<string, YDErrorGroup> {
  const groups = new Map<string, YDErrorGroup>();
  if (!Array.isArray(sample)) return groups;
  for (const item of sample) {
    if (!item || typeof item.message !== 'string') continue;
    if (groups.size >= MAX_ERROR_GROUPS) break;
    groups.set(item.message, item);
  }
  return groups;
}

export async function runYandexDirectJob(
  db: SupabaseClient,
  jobId: string,
  ctx?: YandexDirectRunContext,
): Promise<void> {
  const resumeFrom = Math.max(0, Number(ctx?.checkpoint?.processed_requests ?? 0));
  console.log(`[yandex-direct][${jobId}] starting${resumeFrom > 0 ? `, RESUME from request ${resumeFrom}` : ''}`);

  const { data: job, error } = await db
    .from('yandex_direct_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle<YDJobRow>();
  if (error || !job) {
    console.error(`[yandex-direct][${jobId}] job not found:`, error?.message);
    return;
  }

  // При продолжении счётчики и накопленные ошибки не обнуляем; started_at на
  // захвате ставит раннер (claimPatch), поэтому здесь он только для вызовов
  // без контекста.
  await updateJob(db, jobId, resumeFrom > 0
    ? { status: 'processing', error_message: null }
    : {
      status: 'processing',
      ...(ctx ? {} : { started_at: new Date().toISOString() }),
      errors_count: 0,
      error_message: null,
      errors_sample: [],
    }, ctx);

  const errorGroups = resumeFrom > 0
    ? seedErrorGroups(job.errors_sample)
    : new Map<string, YDErrorGroup>();

  try {
    // ── XMLStock creds ───────────────────────────────────────────────────────
    let creds: XMLStockCreds;
    try {
      creds = getXMLStockCreds();
    } catch (e) {
      throw new Error((e as Error).message);
    }

    // ── Регионы ──────────────────────────────────────────────────────────────
    const regions: YDRegion[] = resolveRegions(
      Array.isArray(job.regions) ? job.regions : ['msk'],
    );
    if (regions.length === 0) {
      throw new Error('Не распознан ни один регион');
    }

    // ── Ключевые слова ───────────────────────────────────────────────────────
    let keywords: string[] = Array.isArray(job.keywords) ? job.keywords.filter(Boolean) : [];
    // Генерируем ТОЛЬКО когда списка ещё нет. Иначе продолжение задачи в
    // AI-режиме получало бы каждый раз новый список ключей, и курсор по номеру
    // запроса указывал бы в другую пару (ключ × регион) — часть работы просто
    // не была бы сделана, и никто бы этого не заметил.
    if (job.keyword_mode === 'ai' && keywords.length === 0) {
      console.log(`[yandex-direct][${jobId}] AI-генерация ключей...`);
      keywords = await buildKeywordList(
        job.audience,
        regions[0].code,
        job.n_seeds || 20,
        job.expand_suggest,
        ctx?.signal,
      );
      // Генерация — самый долгий шаг задачи (LLM + до 60 запросов к Suggest,
      // две-три минуты), и за это время строку могли перехватить. Проверяем
      // сразу, ДО первого платного запроса к XMLStock.
      if (ctx?.signal.aborted) {
        console.log(`[yandex-direct][${jobId}] stopped during keyword generation — leaving job for reclaim`);
        return;
      }
      // Сохраняем сгенерированные ключи в job: и для прозрачности, и как
      // фиксацию последовательности для будущего продолжения.
      //
      // Успех записи здесь обязателен к проверке. Незаписанный список — это
      // ровно та потеря данных, ради которой фиксация и делается: следующий
      // захват увидит keywords=[], сгенерирует ДРУГОЙ список, а курсор по
      // номеру запроса будет указывать в другую пару. Ноль совпавших строк
      // означает вдобавок, что задача уже не наша, и продолжать её — жечь
      // лимит XMLStock за чужой счёт.
      const persisted = await updateJob(db, jobId, { keywords }, ctx);
      if (!persisted) {
        console.warn(`[yandex-direct][${jobId}] keywords not persisted (row reclaimed or write failed) — leaving job for reclaim`);
        return;
      }
    }
    keywords = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));
    if (keywords.length === 0) {
      throw new Error('Нет ключевых слов для парсинга');
    }

    const totalRequests = keywords.length * regions.length;
    await updateJob(db, jobId, { total_requests: totalRequests }, ctx);
    console.log(
      `[yandex-direct][${jobId}] ${keywords.length} ключей × ${regions.length} регионов = ${totalRequests} запросов`,
    );

    // ── Парсинг ──────────────────────────────────────────────────────────────
    // Дедуп по домену в рамках всего job'а (один домен = одна строка).
    //
    // При продолжении множество пустое: домены, сохранённые в прошлом заходе,
    // снова пройдут фильтр и снова уйдут в запись. Ни данные, ни счётчик от
    // этого не портятся — upsert с ignoreDuplicates по (job_id, domain) не
    // создаёт дублей, а saved_total кредитуется по реально записанным строкам.
    // Завышаться может только found_advertisers: он считает найденные объявления
    // и ничем не управляет.
    //
    // В отличие от архива HH, здесь ни один счётчик НЕ управляет работой (нет
    // аналога max_results), поэтому seed'ить их из базы незачем — берём из
    // строки задачи.
    const seenDomains = new Set<string>();
    // Курсор: позиция в развёртке регионы × ключи. processed — она же.
    let position = 0;
    let processed = resumeFrom;
    let foundAdvertisers = resumeFrom > 0 ? (job.found_advertisers ?? 0) : 0;
    let savedTotal = resumeFrom > 0 ? (job.saved_total ?? 0) : 0;
    let errorsCount = resumeFrom > 0 ? (job.errors_count ?? 0) : 0;

    for (const region of regions) {
      if (await isCancelled(db, jobId)) {
        console.log(`[yandex-direct][${jobId}] cancelled by user`);
        return;
      }

      for (const keyword of keywords) {
        position += 1;
        // Пара уже пройдена в прошлом заходе — пропускаем без запроса.
        if (position <= resumeFrom) continue;
        if (await isCancelled(db, jobId)) return;

        processed = position;
        try {
          const xml = await searchYandex(creds, keyword, region.code, 0, ctx?.signal);
          const ads = parseXmlResponse(xml, job.include_organic);
          foundAdvertisers += ads.length;

          // Берём только новые домены — дедуп.
          const rows = ads
            .filter((a) => a.domain && !seenDomains.has(a.domain))
            .map((a) => {
              seenDomains.add(a.domain);
              return {
                job_id: jobId,
                niche: job.niche,
                domain: a.domain,
                title: a.title,
                ad_text: a.text,
                url: a.url,
                region: region.name,
                region_code: region.code,
                keyword,
                block: a.block,
                source: a.source,
              };
            });

          if (rows.length > 0) {
            // upsert с ignoreDuplicates вместо insert: при продолжении задачи
            // дедуп-множество доменов пустое, и обычный insert падал бы целым
            // батчем из-за одного уже сохранённого домена, теряя вместе с ним
            // и новые строки того же запроса.
            //
            // Счётчик кредитуем по РЕАЛЬНО записанным строкам: при ON CONFLICT
            // DO NOTHING ответ содержит только их. Проверки на «duplicate» в
            // тексте ошибки больше нет — с ignoreDuplicates конфликт вообще не
            // доходит до ошибки, и прежняя ветка была мёртвой: любая настоящая
            // ошибка со словом duplicate молча засчиталась бы как успех.
            const { data: inserted, error: insErr } = await db
              .from('yandex_direct_results')
              .upsert(rows, { onConflict: 'job_id,domain', ignoreDuplicates: true })
              .select('domain');
            if (insErr) {
              console.error(`[yandex-direct][${jobId}] insert error:`, insErr.message);
            } else {
              savedTotal += inserted?.length ?? 0;
            }
          }
        } catch (e) {
          // Остановка — по состоянию сигнала, не по имени ошибки: оборванный
          // нами fetch не должен попасть в статистику ошибок задачи, а чужой
          // таймаут с тем же AbortError — должен.
          if (ctx?.signal.aborted) {
            console.log(`[yandex-direct][${jobId}] stopped mid-request — leaving job for reclaim`);
            return;
          }
          errorsCount += 1;
          const message = (e as Error).message;
          recordError(errorGroups, message, keyword, region.name);
          console.error(
            `[yandex-direct][${jobId}] '${keyword}' / ${region.name}:`,
            message,
          );
        }

        // Прогресс — каждые 10 запросов, чтобы не дёргать БД на каждом.
        // Чекпойнт идёт той же пачкой и по той же причине: писать курсор на
        // каждый запрос значило бы один UPDATE на каждые 600 мс. Цена — при
        // подборе задачи переигрываются до девяти запросов; они идемпотентны
        // (upsert по домену).
        if (processed % 10 === 0 || processed === totalRequests) {
          await updateJob(db, jobId, {
            processed_requests: processed,
            found_advertisers: foundAdvertisers,
            saved_total: savedTotal,
            errors_count: errorsCount,
            errors_sample: errorsToJson(errorGroups),
          }, ctx);
          if (ctx) {
            const owned = await ctx.saveCheckpoint({ processed_requests: processed });
            // Строку перехватили: терминальный статус не наш.
            if (!owned) return;
          }
        }
        // Остановка: выходим без терминальной записи, аренду отпустит
        // библиотека, продолжит соседняя реплика с последнего чекпойнта.
        if (ctx?.signal.aborted) return;

        await sleep(REQUEST_DELAY_MS, ctx?.signal);
      }
    }

    await updateJob(db, jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      processed_requests: processed,
      found_advertisers: foundAdvertisers,
      saved_total: savedTotal,
      errors_count: errorsCount,
      errors_sample: errorsToJson(errorGroups),
      ...CLEAR_OWNERSHIP,
    }, ctx);
    console.log(
      `[yandex-direct][${jobId}] completed: saved ${savedTotal} уник. доменов (${errorsCount} ошибок)`,
    );
  } catch (e) {
    // Остановка — по сигналу, а не по имени ошибки (см. развилку внутри цикла).
    if (ctx?.signal.aborted) {
      console.log(`[yandex-direct][${jobId}] stopped mid-run — leaving job for reclaim`);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[yandex-direct][${jobId}] FAILED:`, message);
    await updateJob(db, jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: message.slice(0, 500),
      errors_sample: errorsToJson(errorGroups),
      ...CLEAR_OWNERSHIP,
    }, ctx);
  }
}
