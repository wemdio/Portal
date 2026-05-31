import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { cleanCompanyNames } from '@/lib/companyNameCleanupBatch';

/**
 * Backfill ОЧИЩЕННЫХ названий для уже собранных dry-run строк.
 *
 * Зачем: прогон до правки «чистка в чанке» собрал готовые контакты (валидная
 * почта + сайт), но company_name пуст — имя лежит сырым в hh_employer_name
 * (ООО "..." с кавычками). Этот backfill чистит их ТЕМ ЖЕ AI, что кнопка
 * «Очистить названия» (cleanCompanyNames → stepNameCleanup), и пишет результат
 * в company_name — без 3-4ч повторного прогона.
 *
 * Берём ТОЛЬКО готовые строки (валидная почта + имя + сайт) без company_name.
 *
 * Диагностика: возвращаемый `changed` = сколько имён РЕАЛЬНО изменилось. Если
 * changed≈0 при total>0 — prod-AI чистки не отвечает (ключ/модель/квота); если
 * changed≈total — чистка работает. Это честная проверка «название почищено».
 */

const READY_EMAIL_STATUSES = ['valid', 'role_address', 'free_provider', 'catch_all'];

interface SeenRow {
  hh_employer_id: string;
  hh_employer_name: string;
  domain: string | null;
}

export async function runNameBackfill(clientUserId: string): Promise<{
  total: number;
  updated: number;
  changed: number;
  errors: number;
}> {
  if (!supabaseAdmin) {
    throw new Error('supabaseAdmin not initialized');
  }

  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .select('hh_employer_id, hh_employer_name, domain')
    .eq('client_user_id', clientUserId)
    .eq('status', 'dry_run')
    .in('email_validation_status', READY_EMAIL_STATUSES)
    .not('hh_employer_name', 'is', null)
    .not('site_url', 'is', null)
    .is('company_name', null);

  if (error) throw error;

  const rows = (data ?? []) as SeenRow[];
  console.log(`[clean-names] ${rows.length} готовых строк к чистке имён`);

  let updated = 0;
  let changed = 0;
  let errors = 0;

  // Чанками по 500: чистим (cleanCompanyNames внутри батчит AI по 100) →
  // обновляем company_name. Пул по 10 на апдейты — это UPDATE по PK, дёшево.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const cleaned = await cleanCompanyNames(
      slice.map((r) => ({ name: r.hh_employer_name, domain: r.domain })),
    );

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const j = cursor++;
        if (j >= slice.length) return;
        const row = slice[j];
        const name = (cleaned[j] || row.hh_employer_name || '').trim();
        try {
          const { error: upErr } = await supabaseAdmin!
            .from('client_auto_pipeline_seen_employers')
            .update({ company_name: name })
            .eq('client_user_id', clientUserId)
            .eq('hh_employer_id', row.hh_employer_id);
          if (upErr) {
            errors++;
          } else {
            updated++;
            if (name !== (row.hh_employer_name || '').trim()) changed++;
          }
        } catch {
          errors++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(10, slice.length) }, worker));
    console.log(
      `[clean-names] прогресс: ${Math.min(i + CHUNK, rows.length)}/${rows.length} | изменено ${changed}, ошибок ${errors}`,
    );
  }

  console.log(
    `[clean-names] ГОТОВО: total=${rows.length} updated=${updated} changed=${changed} errors=${errors}`,
  );
  if (rows.length > 0 && changed === 0) {
    console.warn(
      '[clean-names] ⚠️ ни одно имя не изменилось — prod-AI чистки, похоже, не отвечает (ключ/модель/квота).',
    );
  }

  return { total: rows.length, updated, changed, errors };
}
