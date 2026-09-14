import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  fillYandexMapsCatalogJobInChunks,
  type YandexMapsCatalogFilters,
} from '@/lib/parsers/yandexMapsCatalog';

/**
 * Задачи Яндекс.Карт для инструментов («Парсер репутации», DFYB,
 * Telegram-агент): только поиск по локальному каталогу, без живого парсинга.
 * Живой обход Яндекса остался у фонового пополнения каталога и ручной формы
 * оператора — инструменты до него не дотягиваются.
 */

export interface CatalogJobHooks {
  /** Сразу после создания строки задачи — чтобы связать её с внешней сущностью даже при падении сбора. */
  onJobCreated?: (jobId: string) => Promise<void> | void;
  /** Прогресс сбора: сколько организаций уже записано в задачу. */
  onProgress?: (collected: number) => Promise<void> | void;
}

function catalogJobConfig(filters: YandexMapsCatalogFilters, maxResults: number | null) {
  return {
    search_urls: [] as string[],
    catalog_filters: filters,
    max_results: maxResults,
    headless: true,
  };
}

/**
 * Задача в очередь: заполнит воркер portal-worker-yandexmaps — каталожная
 * ветка сбора. Для вызовов, которые возвращаются сразу и следят за статусом
 * задачи сами (Telegram-агент).
 */
export async function queueYandexMapsCatalogJob(
  userId: string,
  filters: YandexMapsCatalogFilters,
  maxResults: number | null,
): Promise<string> {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  const { data, error } = await supabaseAdmin
    .from('yandex_maps_jobs')
    .insert({
      user_id: userId,
      status: 'pending',
      config: catalogJobConfig(filters, maxResults),
      progress_stage: 'pending',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Не удалось создать задачу Яндекс.Карт: ${error?.message ?? 'unknown'}`);
  return data.id as string;
}

/**
 * Задача исполняется здесь же, порциями каталога. Для фоновых процессов без
 * таймаута шлюза (запускаются через `void ...` и живут своей жизнью).
 * Задача остаётся в истории парсера как обычный поиск по каталогу.
 */
export async function runYandexMapsCatalogJobInline(
  userId: string,
  filters: YandexMapsCatalogFilters,
  maxResults: number | null,
  hooks: CatalogJobHooks = {},
): Promise<{ jobId: string; organizations: number }> {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');
  const { data: job, error } = await supabaseAdmin
    .from('yandex_maps_jobs')
    .insert({
      user_id: userId,
      status: 'running',
      config: catalogJobConfig(filters, maxResults),
      progress_stage: 'catalog_search',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !job) throw new Error(`Не удалось создать задачу Яндекс.Карт: ${error?.message ?? 'unknown'}`);

  const jobId = job.id as string;
  await hooks.onJobCreated?.(jobId);

  try {
    const filled = await fillYandexMapsCatalogJobInChunks(jobId, filters, maxResults, hooks.onProgress);
    await supabaseAdmin
      .from('yandex_maps_jobs')
      .update({
        status: 'completed',
        progress_stage: filled.organizations ? 'catalog_completed' : 'catalog_empty',
        completed_at: new Date().toISOString(),
        total_links: filled.organizations,
        processed_links: filled.organizations,
        total_organizations: filled.organizations,
        processed_organizations: filled.organizations,
        error_message: null,
      })
      .eq('id', jobId);
    return { jobId, organizations: filled.organizations };
  } catch (e) {
    // Задача остаётся в истории с причиной: молча удалять её хуже — человек
    // не поймёт, почему запуск исчез.
    await supabaseAdmin
      .from('yandex_maps_jobs')
      .update({
        status: 'failed',
        error_message: e instanceof Error ? e.message : 'Поиск по каталогу не удался',
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
    throw e;
  }
}
