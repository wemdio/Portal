import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { validateEmailForAutoPipeline } from './autoPipelineEmailValidation';
import type { DomainInfo } from '@/lib/emailValidation/shared';

interface SeenRow {
  hh_employer_id: string;
  email_found: string;
}

export async function runReValidate(clientUserId: string): Promise<{
  total: number;
  updated: number;
  errors: number;
}> {
  if (!supabaseAdmin) {
    throw new Error('supabaseAdmin not initialized');
  }

  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .select('hh_employer_id, email_found')
    .eq('client_user_id', clientUserId)
    .eq('status', 'dry_run')
    .not('email_found', 'is', null);

  if (error) throw error;

  const rows = (data ?? []) as SeenRow[];
  console.log(`[re-validate] ${rows.length} строк к ре-валидации`);

  const domainCache = new Map<string, DomainInfo>();
  let updated = 0;
  let errors = 0;

  // Pool по 10 параллельно — MX lookup это DNS-only, дешёвый.
  const CONCURRENCY = 10;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];
      try {
        const result = await validateEmailForAutoPipeline(row.email_found, domainCache);
        const { error: upErr } = await supabaseAdmin!
          .from('client_auto_pipeline_seen_employers')
          .update({
            email_validation_status: result.status,
            email_validation_details: result.details,
          })
          .eq('client_user_id', clientUserId)
          .eq('hh_employer_id', row.hh_employer_id);
        if (upErr) {
          errors++;
          console.warn(`[re-validate] update failed for ${row.hh_employer_id}:`, upErr.message);
        } else {
          updated++;
          if (updated % 50 === 0) {
            console.log(`[re-validate] прогресс: ${updated}/${rows.length}`);
          }
        }
      } catch (err) {
        errors++;
        console.warn(`[re-validate] error for ${row.email_found}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  // После re-validate обновим email_valid в журнале последнего прогона.
  const { data: latestRun } = await supabaseAdmin
    .from('client_auto_pipeline_runs')
    .select('id')
    .eq('client_user_id', clientUserId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestRun) {
    const { count: validCount } = await supabaseAdmin
      .from('client_auto_pipeline_seen_employers')
      .select('hh_employer_id', { count: 'exact', head: true })
      .eq('client_user_id', clientUserId)
      .eq('status', 'dry_run')
      .in('email_validation_status', ['valid', 'role_address', 'free_provider']);

    await supabaseAdmin
      .from('client_auto_pipeline_runs')
      .update({ email_valid: validCount ?? 0 })
      .eq('id', (latestRun as { id: string }).id);
  }

  return { total: rows.length, updated, errors };
}
