import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ProviderBudgetWaitError } from '@/lib/providerUsage';
import { serperSearchDetailed } from './serperSearch';
import { saveSearchProgress, searchExecution, searchQueueDeadline, type SearchLease } from './searchExecution';
import { accountSearchSpend } from './searchSpend';

/** Discovery only: no LLM query expansion, directory expansion, browser, or
 * email crawl. Normal VE2 checks decide relevance later; a SERP hit is no lead. */
export function searchProbeRows(items: Array<{ title: string; link: string; snippet: string }>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const item of items.slice(0, 10)) {
    try {
      const url = new URL(item.link);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
        || isIP(host) || host.includes(':') || !host.includes('.') || host.endsWith('.local')
        || /(^|\.)(google\.[a-z.]+|yandex\.[a-z.]+|bing\.com|duckduckgo\.com|wikipedia\.org)$/.test(host)
        || /\.(pdf|zip|jpg|png|mp4)$/i.test(url.pathname) || seen.has(host)) continue;
      seen.add(host);
      rows.push({ company: item.title.slice(0, 160) || host, website: `https://${host}`,
        email: '', phone: '', inn: '', address: '', category: '',
        vacancy_title: '', employees: '', revenue: '', source_detail: 'Поисковая выдача: ' + item.link.slice(0, 500) + '\nОтрывок: ' + item.snippet.slice(0, 500) });
    } catch { /* Invalid source URL cannot become a candidate. */ }
  }
  return rows;
}

export async function runSearchProbe(db: SupabaseClient, lease: SearchLease): Promise<void> {
  const probe = lease.probe!;
  try {
    let rows = probe.results;
    if (rows === null) {
      if (probe.attempted_at) throw new Error('Результат поискового запроса неизвестен; повторная оплата заблокирована');
      if (!process.env.SERPER_API_KEY?.trim()) throw new Error('Поисковый провайдер не настроен');
      const attemptId = randomUUID();
      // Reserve generously: 10 cents per 10-result page, including ambiguous
      // attempts. The same ledger also guards the subsequent VE2 AI checks.
      await accountSearchSpend(db, probe.base_id, { attemptId, provider: 'serper', phase: 'started', reservedCostUsd: 0.1 });
      const { data, error } = await searchQueueDeadline(db.rpc('ve_begin_search_probe', { p_job_id: lease.job_id, p_token: lease.token }));
      if (error || data !== true) throw new Error('Search attempt ownership unavailable');
      searchExecution(lease.job_id);
      const result = await serperSearchDetailed(probe.query, { num: 10, page: probe.page,
        gl: probe.locale === 'ru' ? 'ru' : 'us', hl: probe.locale });
      rows = searchProbeRows(result.results);
      // Keep the conservative reservation: this API adapter doesn't return a
      // trustworthy billed USD amount. Never guess a refund.
    }
    const { data, error } = await searchQueueDeadline(db.rpc('ve_finish_search_probe', {
      p_job_id: lease.job_id, p_token: lease.token, p_results: rows,
    }));
    if (error || data !== true) throw new Error('Search result checkpoint unavailable');
  } catch (error) {
    if (error instanceof ProviderBudgetWaitError) {
      const result = await searchQueueDeadline(db.rpc('ve_delay_search_probe', { p_job_id: lease.job_id, p_token: lease.token }));
      if (result.error || result.data !== true) throw new Error('Search budget wait could not be saved');
      return;
    }
    await saveSearchProgress(db, lease.job_id, { status: 'failed', progress_stage: 'failed',
      completed_at: new Date().toISOString(), error_message: error instanceof Error ? error.message.slice(0, 300) : 'Поиск не завершён' });
  }
}
