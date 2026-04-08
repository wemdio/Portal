import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { computePainScore, computeConfidenceScore, classifyCandidate, type ReputationCandidate, type Classification } from './scoring';
import { fetchLowRatedOrganizations, ymapsOrgToCandidate, type YmapsFilterConfig } from './ymapsAdapter';
import { scanBrandSerp, serpResultToCandidate } from './serpAdapter';
import { generateSearchUrls } from '@/lib/parsers/yandexMapsData';

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

const YMAPS_POLL_INTERVAL_MS = 8_000;
const YMAPS_POLL_TIMEOUT_MS = 20 * 60_000;

async function createAndAwaitYmapsJob(
  userId: string,
  cities: string[],
  rubrics: string[],
  log: ProgressCallback,
): Promise<string> {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');

  const searchUrls = generateSearchUrls(cities, rubrics);
  if (searchUrls.length === 0) throw new Error('No search URLs generated — check cities/rubrics');

  log(`Создание задачи парсинга Яндекс.Карт (${searchUrls.length} URL)...`);

  const { data: job, error } = await supabaseAdmin
    .from('yandex_maps_jobs')
    .insert({
      user_id: userId,
      status: 'pending',
      config: { search_urls: searchUrls, max_results: 5000, headless: true },
      progress_stage: 'pending',
      proxy_enabled: false,
    })
    .select('id')
    .single();

  if (error || !job) throw new Error(`Failed to create ymaps job: ${error?.message ?? 'unknown'}`);

  const ymapsJobId = job.id as string;
  log(`Задача парсинга создана: ${ymapsJobId}. Ожидание сбора ссылок...`);

  const deadline = Date.now() + YMAPS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, YMAPS_POLL_INTERVAL_MS));

    const { data: row } = await supabaseAdmin
      .from('yandex_maps_jobs')
      .select('status, progress_stage, total_links, processed_links, error_message')
      .eq('id', ymapsJobId)
      .single();

    if (!row) throw new Error('ymaps job disappeared');

    const stage = String(row.progress_stage ?? '');
    const status = String(row.status ?? '');

    if (status === 'failed') throw new Error(`Парсинг Я.Карт не удался: ${row.error_message ?? 'unknown'}`);

    if (stage === 'links_collected') {
      log(`Ссылки собраны (${row.total_links ?? 0}). Запуск парсинга организаций...`);

      await supabaseAdmin
        .from('yandex_maps_jobs')
        .update({ status: 'pending', progress_stage: 'ready_to_parse', error_message: null })
        .eq('id', ymapsJobId);

      break;
    }

    if (status === 'completed' && stage === 'completed') {
      log('Парсинг уже завершён.');
      return ymapsJobId;
    }

    if (stage.startsWith('collecting_links')) {
      log(`Сбор ссылок: ${stage.split(':')[1] ?? '...'}`);
    }
  }

  const parseDeadline = Date.now() + YMAPS_POLL_TIMEOUT_MS;
  while (Date.now() < parseDeadline) {
    await new Promise((r) => setTimeout(r, YMAPS_POLL_INTERVAL_MS));

    const { data: row } = await supabaseAdmin
      .from('yandex_maps_jobs')
      .select('status, progress_stage, processed_organizations, error_message')
      .eq('id', ymapsJobId)
      .single();

    if (!row) throw new Error('ymaps job disappeared');

    const stage = String(row.progress_stage ?? '');
    const status = String(row.status ?? '');

    if (status === 'failed') throw new Error(`Парсинг организаций не удался: ${row.error_message ?? 'unknown'}`);

    if (status === 'completed' && stage === 'completed') {
      log(`Парсинг завершён (${row.processed_organizations ?? 0} организаций).`);
      return ymapsJobId;
    }

    if (stage.startsWith('parsing_organizations')) {
      log(`Парсинг организаций: ${row.processed_organizations ?? 0} обработано`);
    }
  }

  throw new Error('Таймаут ожидания парсинга Яндекс.Карт');
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

      const ymapsJobId = await createAndAwaitYmapsJob(userId, ac.cities, ac.rubrics, log);

      log('Фильтрация организаций по рейтингу...');
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
            .update({ processed_candidates: i + 1 })
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
      .update({ status: 'failed', error_message: message, completed_at: new Date().toISOString() })
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
