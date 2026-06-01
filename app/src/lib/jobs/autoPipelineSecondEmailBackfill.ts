import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { validateEmailForAutoPipeline } from '@/lib/jobs/autoPipelineEmailValidation';
import type { DomainInfo } from '@/lib/emailValidation/shared';

/**
 * Backfill ВТОРОЙ почты для уже собранных dry-run контактов.
 *
 * Зачем: прогон находил до 2 почт на домен, но dry-run хранил только первичную
 * (resolved_email) — вторая выбрасывалась. Этот backfill ПЕРЕСКРЕЙПИВАЕТ домены
 * готовых контактов, берёт первый адрес, отличный от первичного, валидирует его
 * (тем же validateEmailForAutoPipeline, что прогон) и пишет в email2 /
 * email2_validation_status. Так домены с валидной 2-й почтой дадут 2 контакта.
 *
 * Идемпотентность: берём только строки с email2 IS NULL. После обработки пишем
 * либо найденный адрес, либо '' (перескрейпили, 2-й нет) — повтор их пропустит.
 * При ошибке/таймауте оставляем NULL → следующий прогон попробует снова.
 *
 * Метрики: found2 — у скольки доменов есть отдельная 2-я почта; ready2 — у
 * скольки она ГОТОВА (valid/role/free/catch_all) = столько НОВЫХ контактов.
 */

const READY_EMAIL_STATUSES = ['valid', 'role_address', 'free_provider', 'catch_all'];
const SCRAPE_CONCURRENCY = 12;
const ITEM_TIMEOUT_MS = 60_000;

interface SeenRow {
  hh_employer_id: string;
  site_url: string;
  resolved_email: string | null;
}

export async function runSecondEmailBackfill(
  clientUserId: string,
  limit?: number,
): Promise<{ total: number; scraped: number; found2: number; ready2: number; errors: number }> {
  if (!supabaseAdmin) {
    throw new Error('supabaseAdmin not initialized');
  }

  let query = supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .select('hh_employer_id, site_url, resolved_email')
    .eq('client_user_id', clientUserId)
    .eq('status', 'dry_run')
    .in('email_validation_status', READY_EMAIL_STATUSES)
    .not('site_url', 'is', null)
    .not('resolved_email', 'is', null)
    .is('email2', null);
  if (limit && limit > 0) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as SeenRow[];
  console.log(`[2nd-email] ${rows.length} строк к перескрейпу`);

  const domainCache = new Map<string, DomainInfo>();
  let scraped = 0;
  let found2 = 0;
  let ready2 = 0;
  let errors = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];
      try {
        const result = await Promise.race<{ email2: string; status: string | null; hasSecond: boolean }>([
          (async () => {
            const scrape = await scrapeEmails(row.site_url, { timeout: 12_000, maxPages: 5 }).catch(
              () => ({ emails: [] as string[] }),
            );
            const primary = (row.resolved_email ?? '').toLowerCase();
            const second = scrape.emails.find((e) => e.toLowerCase() !== primary) ?? null;
            if (!second) return { email2: '', status: null, hasSecond: false };
            const v = await validateEmailForAutoPipeline(second, domainCache);
            return { email2: second, status: v.status, hasSecond: true };
          })(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`item timeout ${ITEM_TIMEOUT_MS}ms`)), ITEM_TIMEOUT_MS),
          ),
        ]);

        const { error: upErr } = await supabaseAdmin!
          .from('client_auto_pipeline_seen_employers')
          .update({ email2: result.email2, email2_validation_status: result.status })
          .eq('client_user_id', clientUserId)
          .eq('hh_employer_id', row.hh_employer_id);
        if (upErr) {
          errors++;
        } else {
          scraped++;
          if (result.hasSecond) found2++;
          if (result.status && READY_EMAIL_STATUSES.includes(result.status)) ready2++;
          if (scraped % 100 === 0) {
            console.log(
              `[2nd-email] прогресс: scraped=${scraped}/${rows.length} found2=${found2} ready2=${ready2} errors=${errors}`,
            );
          }
        }
      } catch {
        errors++;
        // NULL остаётся → повторный прогон попробует снова.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(SCRAPE_CONCURRENCY, rows.length) }, worker));

  console.log(
    `[2nd-email] ГОТОВО: total=${rows.length} scraped=${scraped} found2=${found2} ready2=${ready2} errors=${errors}`,
  );
  return { total: rows.length, scraped, found2, ready2, errors };
}
