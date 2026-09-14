import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { computePainScore, computeConfidenceScore, classifyCandidate, type ReputationCandidate, type Classification } from './scoring';
import { fetchLowRatedOrganizations, ymapsOrgToCandidate, type YmapsFilterConfig } from './ymapsAdapter';
import { scanBrandSerp, serpResultToCandidate } from './serpAdapter';
import { normalizeYandexMapsCatalogFilters } from '@/lib/parsers/yandexMapsCatalog';
import { runYandexMapsCatalogJobInline } from '@/lib/parsers/yandexMapsCatalogJob';

export interface AutoSearchConfig {
  cities: string[];
  rubrics: string[];
  maxRating: number;
  minReviews: number;
  enableSerpScan: boolean;
}

export interface JobConfig {
  mode: 'local_reviews' | 'brand_serp' | 'auto_search';
  localReviews?: YmapsFilterConfig;
  brandSerp?: {
    companies: { name: string; city: string | null }[];
  };
  autoSearch?: AutoSearchConfig;
}

export type ProgressCallback = (msg: string) => void;

// Тот же потолок, что был у живого парсера: фильтр «низкий рейтинг» всё равно
// оставит от выдачи малую часть, а копировать в задачу сотни тысяч строк
// каталога ради этого незачем.
const CATALOG_MAX_RESULTS = 5000;

async function updateJobProgress(jobId: string, stage: string, extra?: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('reputation_jobs')
    .update({ progress_stage: stage, ...extra })
    .eq('id', jobId);
}

/**
 * Выдача городов × рубрик из локального каталога Яндекс.Карт.
 *
 * Раньше здесь был живой парсинг: генерировались поисковые URL, воркер собирал
 * ссылки и открывал карточки. Живой обход остался только у фонового
 * пополнения каталога; поиск по городам и рубрикам каталог закрывает сам.
 */
async function collectFromYandexMapsCatalog(
  repJobId: string,
  userId: string,
  cities: string[],
  rubrics: string[],
  log: ProgressCallback,
): Promise<string> {
  const filters = normalizeYandexMapsCatalogFilters({ cities, categories: rubrics });
  if (!filters) throw new Error('Не из чего собирать выдачу — укажите хотя бы один город или рубрику');

  log('Поиск организаций в каталоге Яндекс.Карт...');
  await updateJobProgress(repJobId, 'ymaps_init');

  const { jobId, organizations } = await runYandexMapsCatalogJobInline(userId, filters, CATALOG_MAX_RESULTS, {
    onJobCreated: (createdJobId) => updateJobProgress(repJobId, 'ymaps_catalog:0', { ymaps_job_id: createdJobId }),
    onProgress: async (collected) => {
      log(`Каталог: собрано ${collected} организаций`);
      await updateJobProgress(repJobId, `ymaps_catalog:${collected}`);
    },
  });

  log(`Каталог отдал ${organizations} организаций.`);
  await updateJobProgress(repJobId, 'ymaps_completed');
  return jobId;
}

export async function runReputationPipeline(
  jobId: string,
  config: JobConfig,
  onProgress?: ProgressCallback,
  userId?: string,
): Promise<{ total: number; autoExport: number; review: number; discard: number }> {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');

  const log = onProgress ?? (() => {});
  let candidates: ReputationCandidate[] = [];

  await supabaseAdmin
    .from('reputation_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', jobId);

  try {
    if (config.mode === 'auto_search') {
      const ac = config.autoSearch;
      if (!ac) throw new Error('autoSearch config is required for auto_search mode');
      if (!userId) throw new Error('userId is required for auto_search mode');

      const ymapsJobId = await collectFromYandexMapsCatalog(jobId, userId, ac.cities, ac.rubrics, log);

      log('Фильтрация организаций по рейтингу...');
      await updateJobProgress(jobId, 'filtering');
      const filter: YmapsFilterConfig = {
        maxRating: ac.maxRating,
        minReviews: ac.minReviews,
        ymapsJobIds: [ymapsJobId],
      };
      const orgs = await fetchLowRatedOrganizations(filter);
      log(`Найдено ${orgs.length} организаций с рейтингом ≤ ${ac.maxRating}`);

      candidates = orgs.map((o) => {
        const c = ymapsOrgToCandidate(jobId, o);
        c.sourceMode = 'auto_search';
        return c;
      });

      await supabaseAdmin
        .from('reputation_jobs')
        .update({ total_candidates: candidates.length })
        .eq('id', jobId);

      if (ac.enableSerpScan && candidates.length > 0) {
        log(`SERP-скан негатива для ${candidates.length} компаний (бесплатно)...`);
        await updateJobProgress(jobId, `serp_scanning:0/${candidates.length}`);
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          log(`[${i + 1}/${candidates.length}] SERP: ${c.company}...`);
          try {
            const scan = await scanBrandSerp(c.company, c.city);
            c.negativeSerpResultsTop10 = scan.negativeCount;
            c.secondSourceConfirmed = scan.negativeCount > 0;
            if (scan.negativeItems.length > 0) {
              c.proofUrls = [...c.proofUrls, ...scan.negativeItems.map((s) => s.link).slice(0, 3)];
              c.proofSnippets = [...c.proofSnippets, ...scan.negativeItems.map((s) => s.snippet).slice(0, 3)];
              c.issueThemes = extractSerpThemes(scan.negativeItems, c.issueThemes);
            }
          } catch (err) {
            log(`  ⚠ SERP ошибка для ${c.company}: ${err instanceof Error ? err.message : 'unknown'}`);
          }

          await supabaseAdmin
            .from('reputation_jobs')
            .update({ processed_candidates: i + 1, progress_stage: `serp_scanning:${i + 1}/${candidates.length}` })
            .eq('id', jobId);

          if (i < candidates.length - 1) {
            await new Promise((r) => setTimeout(r, 4_000));
          }
        }
      }

    } else if (config.mode === 'local_reviews') {
      log('Загрузка организаций из Яндекс.Карт...');
      const filter = config.localReviews ?? { maxRating: 4.0, minReviews: 10 };
      const orgs = await fetchLowRatedOrganizations(filter);
      log(`Найдено ${orgs.length} организаций с рейтингом ≤ ${filter.maxRating}`);

      candidates = orgs.map((o) => ymapsOrgToCandidate(jobId, o));

      await supabaseAdmin
        .from('reputation_jobs')
        .update({ total_candidates: candidates.length })
        .eq('id', jobId);

    } else if (config.mode === 'brand_serp') {
      const companies = config.brandSerp?.companies ?? [];
      log(`Сканирование SERP для ${companies.length} компаний...`);

      await supabaseAdmin
        .from('reputation_jobs')
        .update({ total_candidates: companies.length })
        .eq('id', jobId);

      for (let i = 0; i < companies.length; i++) {
        const { name, city } = companies[i];
        log(`[${i + 1}/${companies.length}] SERP: ${name}...`);
        try {
          const scan = await scanBrandSerp(name, city);
          if (scan.negativeCount > 0) {
            candidates.push(serpResultToCandidate(jobId, scan));
          }
        } catch (err) {
          log(`  ⚠ Ошибка SERP для ${name}: ${err instanceof Error ? err.message : 'unknown'}`);
        }

        await supabaseAdmin
          .from('reputation_jobs')
          .update({ processed_candidates: i + 1 })
          .eq('id', jobId);

        if (i < companies.length - 1) {
          await new Promise((r) => setTimeout(r, 4_000));
        }
      }
    }

    log(`Скоринг ${candidates.length} кандидатов...`);
    await updateJobProgress(jobId, `scoring:${candidates.length}`);

    const stats = { total: candidates.length, autoExport: 0, review: 0, discard: 0 };

    for (const c of candidates) {
      const result = classifyCandidate(c);
      const row = candidateToDbRow(c, result.painScore, result.confidenceScore, result.classification);

      const { error } = await supabaseAdmin
        .from('reputation_candidates')
        .insert(row);

      if (error) {
        log(`  ⚠ Ошибка сохранения ${c.company}: ${error.message}`);
        continue;
      }

      if (result.classification === 'auto_export') stats.autoExport++;
      else if (result.classification === 'review') stats.review++;
      else stats.discard++;

      if (c.proofUrls.length > 0) {
        const evidenceRows = c.proofUrls.map((url, idx) => ({
          candidate_id: row.id,
          source: c.primarySource,
          url,
          snippet: c.proofSnippets[idx] ?? null,
          sentiment: 'negative' as const,
        }));
        await supabaseAdmin.from('reputation_evidence').insert(evidenceRows);
      }
    }

    await supabaseAdmin
      .from('reputation_jobs')
      .update({
        status: 'completed',
        progress_stage: 'completed',
        completed_at: new Date().toISOString(),
        processed_candidates: stats.total,
        auto_export_count: stats.autoExport,
        review_count: stats.review,
        discard_count: stats.discard,
      })
      .eq('id', jobId);

    log(`Готово: ${stats.autoExport} auto-export, ${stats.review} на проверку, ${stats.discard} отклонено`);
    return stats;

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await supabaseAdmin
      .from('reputation_jobs')
      .update({ status: 'failed', progress_stage: 'failed', error_message: message, completed_at: new Date().toISOString() })
      .eq('id', jobId);
    throw err;
  }
}

function extractSerpThemes(items: { title: string; snippet: string }[], existing: string[]): string[] {
  const text = items.map((i) => `${i.title} ${i.snippet}`).join(' ').toLowerCase();
  const themes = [...existing];
  const THEME_PATTERNS: [RegExp, string][] = [
    [/обман|мошенн|развод|кидал/i, 'мошенничество'],
    [/сервис|обслужив|грубость|хамство/i, 'плохой сервис'],
    [/качеств|бра[кг]|дефект/i, 'качество'],
    [/доставк|опоздан|сроки/i, 'сроки/доставка'],
    [/возврат|деньги|не верн/i, 'возврат средств'],
    [/зарплат|не плат|задерж.*зарплат/i, 'зарплата'],
    [/условия труда|переработк|увольн/i, 'условия труда'],
  ];
  for (const [re, label] of THEME_PATTERNS) {
    if (re.test(text) && !themes.includes(label)) themes.push(label);
  }
  return themes;
}

function candidateToDbRow(
  c: ReputationCandidate,
  painScore: number,
  confidenceScore: number,
  classification: Classification,
) {
  return {
    id: c.id,
    job_id: c.jobId,
    company: c.company,
    city: c.city,
    category: c.category,
    source_mode: c.sourceMode,
    primary_source: c.primarySource,
    primary_source_url: c.primarySourceUrl,
    website: c.website,
    rating: c.rating || null,
    reviews_count: c.reviewsCount,
    negative_reviews_30d: c.negativeReviews30d,
    negative_reviews_90d: c.negativeReviews90d,
    unanswered_negative_reviews: c.unansweredNegativeReviews,
    negative_serp_results_top10: c.negativeSerpResultsTop10,
    issue_themes: c.issueThemes,
    proof_urls: c.proofUrls,
    proof_snippets: c.proofSnippets,
    pain_score: painScore,
    confidence_score: confidenceScore,
    classification,
    second_source_confirmed: c.secondSourceConfirmed,
  };
}
