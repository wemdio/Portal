import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeContactUploadStatus {
  blocked: null | { run_id: string; blocked_at: string; run_date: string; accepted: number; pending: number; uncertain: number };
}

/** Resolve the project from stored template identity, never from browser input. */
export async function loadContactUploadProject(db: SupabaseClient, templateId: string): Promise<string> {
  const { data: template, error: templateError } = await db.from('ve_templates')
    .select('base_id, supply_batch_id').eq('id', templateId).maybeSingle();
  if (templateError || !template || template.supply_batch_id) throw new Error('Шаблон недоступен');
  const { data: base, error } = await db.from('ve_bases').select('project_id').eq('id', template.base_id).maybeSingle();
  if (error || !base?.project_id) throw new Error('Проект загрузки недоступен');
  return base.project_id;
}

/** A project pause is shared by its campaign cards, including imported bases. */
export async function loadContactUploadStatus(db: SupabaseClient, projectId: string): Promise<VeContactUploadStatus> {
  const { data, error } = await db.from('ve_contact_delivery_daily_runs')
    .select('id, run_date, upload_blocked_at, accepted_count, skipped_count, uncertain_count, reserved_count')
    .eq('ve_project_id', projectId).not('upload_blocked_at', 'is', null)
    .order('run_date', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('Не удалось проверить загрузку контактов');
  return { blocked: data ? {
    run_id: data.id, blocked_at: data.upload_blocked_at, run_date: data.run_date,
    accepted: data.accepted_count, uncertain: data.uncertain_count,
    pending: Math.max(0, data.reserved_count - data.accepted_count - data.skipped_count - data.uncertain_count),
  } : null };
}
