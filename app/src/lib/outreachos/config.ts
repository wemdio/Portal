/**
 * Загрузка singleton-конфига OutreachOS пайплайна (outreachos_pipeline_config, id=1).
 *
 * Изолирован от client_auto_pipeline_configs (Mailganer-стек). Скоринга нет.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/** Шаги конструктора баз, которые НИКОГДА не допускаем в OutreachOS-прогон. */
export const FORBIDDEN_STEPS = ['ta_scoring', 'personalization'] as const;

export interface OutreachOsConfig {
  id: number;
  enabled: boolean;
  /** profiles.id аккаунта OutreachOS — он же user_id для base_constructor_jobs. */
  client_user_id: string;
  /** Одна заранее созданная кампания Instantly для ежедневного добора. */
  campaign_id: string | null;
  /** HH top-level industry id'ы (см. lib/jobs/hhIndustries). Пусто = без industry-фильтра. */
  industries: string[];
  area: string;
  window_hours: number;
  max_employees: number | null;
  daily_limit: number;
  /** Шаги конструктора баз. ta_scoring/personalization вырезаются при загрузке. */
  selected_steps: string[];
  extra_exclude: string[];
  job_poll_timeout_minutes: number;
}

/**
 * Читает конфиг id=1. Возвращает null, если строки нет или БД недоступна.
 * Жёстко фильтрует selected_steps от ta_scoring/personalization — даже если
 * кто-то по ошибке вписал их в конфиг, OutreachOS их не выполнит.
 */
export async function loadOutreachOsConfig(): Promise<OutreachOsConfig | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('outreachos_pipeline_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as OutreachOsConfig;
  const cleanedSteps = (row.selected_steps ?? []).filter(
    (s) => !FORBIDDEN_STEPS.includes(s as (typeof FORBIDDEN_STEPS)[number]),
  );
  return { ...row, selected_steps: cleanedSteps };
}
