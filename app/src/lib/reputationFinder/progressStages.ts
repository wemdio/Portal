/**
 * Convert a reputation_jobs.progress_stage code to a human-readable Russian string.
 * Shared between server-side SSE and client-side fallback polling.
 */
export function humanProgressStage(stage: string): string | null {
  if (!stage || stage === 'pending') return null;
  if (stage.startsWith('ymaps_init:')) return `Создание задачи парсинга Яндекс.Карт (${stage.split(':')[1]} URL)...`;
  if (stage.startsWith('ymaps_collecting:')) return `Сбор ссылок: ${stage.split(':')[1]}`;
  if (stage.startsWith('ymaps_links_collected:')) return `Ссылки собраны (${stage.split(':')[1]}). Запуск парсинга организаций...`;
  if (stage.startsWith('ymaps_parsing:')) return `Парсинг организаций: ${stage.split(':')[1]} обработано`;
  if (stage === 'ymaps_completed') return 'Парсинг Яндекс.Карт завершён.';
  if (stage === 'filtering') return 'Фильтрация организаций по рейтингу...';
  if (stage.startsWith('scoring:')) return `Скоринг ${stage.split(':')[1]} кандидатов...`;
  if (stage.startsWith('serp_scanning:')) return `SERP-скан негатива: ${stage.split(':')[1]}`;
  if (stage === 'completed') return 'Pipeline завершён.';
  if (stage === 'failed') return null;
  return stage;
}
