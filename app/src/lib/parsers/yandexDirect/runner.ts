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
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildKeywordList } from './keywords';
import { parseXmlResponse, searchYandex, getXMLStockCreds, sleep, type XMLStockCreds } from './parser';
import { resolveRegions, type YDRegion } from './regions';

/** Пауза между запросами к XMLStock (мс). */
const REQUEST_DELAY_MS = Number(process.env.YANDEX_DIRECT_REQUEST_DELAY_MS ?? '600');

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
}

async function isCancelled(db: SupabaseClient, jobId: string): Promise<boolean> {
  const { data } = await db
    .from('yandex_direct_jobs')
    .select('status')
    .eq('id', jobId)
    .maybeSingle();
  return data?.status === 'cancelled';
}

async function updateJob(
  db: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('yandex_direct_jobs').update(patch).eq('id', jobId);
  if (error) console.error(`[yandex-direct][${jobId}] updateJob failed:`, error.message);
}

export async function runYandexDirectJob(db: SupabaseClient, jobId: string): Promise<void> {
  console.log(`[yandex-direct][${jobId}] starting`);

  const { data: job, error } = await db
    .from('yandex_direct_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle<YDJobRow>();
  if (error || !job) {
    console.error(`[yandex-direct][${jobId}] job not found:`, error?.message);
    return;
  }

  await updateJob(db, jobId, {
    status: 'processing',
    started_at: new Date().toISOString(),
    errors_count: 0,
    error_message: null,
  });

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
    if (job.keyword_mode === 'ai') {
      console.log(`[yandex-direct][${jobId}] AI-генерация ключей...`);
      keywords = await buildKeywordList(
        job.audience,
        regions[0].code,
        job.n_seeds || 20,
        job.expand_suggest,
      );
      // Сохраняем сгенерированные ключи в job для прозрачности.
      await updateJob(db, jobId, { keywords });
    }
    keywords = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));
    if (keywords.length === 0) {
      throw new Error('Нет ключевых слов для парсинга');
    }

    const totalRequests = keywords.length * regions.length;
    await updateJob(db, jobId, { total_requests: totalRequests });
    console.log(
      `[yandex-direct][${jobId}] ${keywords.length} ключей × ${regions.length} регионов = ${totalRequests} запросов`,
    );

    // ── Парсинг ──────────────────────────────────────────────────────────────
    // Дедуп по домену в рамках всего job'а (один домен = одна строка).
    const seenDomains = new Set<string>();
    let processed = 0;
    let foundAdvertisers = 0;
    let savedTotal = 0;
    let errorsCount = 0;

    for (const region of regions) {
      if (await isCancelled(db, jobId)) {
        console.log(`[yandex-direct][${jobId}] cancelled by user`);
        return;
      }

      for (const keyword of keywords) {
        if (await isCancelled(db, jobId)) return;

        processed += 1;
        try {
          const xml = await searchYandex(creds, keyword, region.code);
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
            const { error: insErr } = await db.from('yandex_direct_results').insert(rows);
            if (insErr && !insErr.message.includes('duplicate')) {
              console.error(`[yandex-direct][${jobId}] insert error:`, insErr.message);
            } else {
              savedTotal += rows.length;
            }
          }
        } catch (e) {
          errorsCount += 1;
          console.error(
            `[yandex-direct][${jobId}] '${keyword}' / ${region.name}:`,
            (e as Error).message,
          );
        }

        // Прогресс — каждые 10 запросов, чтобы не дёргать БД на каждом.
        if (processed % 10 === 0 || processed === totalRequests) {
          await updateJob(db, jobId, {
            processed_requests: processed,
            found_advertisers: foundAdvertisers,
            saved_total: savedTotal,
            errors_count: errorsCount,
          });
        }

        await sleep(REQUEST_DELAY_MS);
      }
    }

    await updateJob(db, jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      processed_requests: processed,
      found_advertisers: foundAdvertisers,
      saved_total: savedTotal,
      errors_count: errorsCount,
    });
    console.log(
      `[yandex-direct][${jobId}] completed: saved ${savedTotal} уник. доменов (${errorsCount} ошибок)`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[yandex-direct][${jobId}] FAILED:`, message);
    await updateJob(db, jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: message.slice(0, 500),
    });
  }
}
