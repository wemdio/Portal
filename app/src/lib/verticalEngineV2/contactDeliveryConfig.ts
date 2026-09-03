import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import type { SupabaseClient } from '@supabase/supabase-js';

export function normalizeContactDeliveryScheduleDays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days = Array.from(new Set(value));
  if (days.length === 0 || days.some((day) => !Number.isSafeInteger(day) || day < 0 || day > 6)) {
    return null;
  }
  const weekdays = (days as number[]).filter((day) => day >= 1 && day <= 5);
  return weekdays.length > 0 ? weekdays.sort((left, right) => left - right) : null;
}

export function contactDeliveryDailyCapacity(
  preset: Pick<ClientCampaignPreset, 'daily_max_leads' | 'daily_limit'>,
): number | null {
  for (const candidate of [preset.daily_max_leads, preset.daily_limit]) {
    if (Number.isSafeInteger(candidate) && candidate > 0) return candidate;
  }
  return null;
}

/** The period plan is frozen; live preset edits must not change it implicitly. */
export async function loadContactDeliverySettings(
  db: SupabaseClient,
  veProjectId: string,
  input: { portalProjectId: string; portalPeriodId: string; targetContacts: number; presetId: string },
  preset: Pick<ClientCampaignPreset, 'daily_max_leads' | 'daily_limit' | 'schedule_days' | 'schedule_timezone'>,
) {
  const { data: binding, error } = await db.from('ve_projects')
    .select('portal_project_id, portal_period_id, target_contacts, launch_preset_id, sender_daily_capacity, delivery_schedule_days, delivery_timezone')
    .eq('id', veProjectId).maybeSingle();
  if (error || !binding) throw new Error('Не удалось прочитать закреплённый план проекта');
  if (binding.launch_preset_id && binding.launch_preset_id !== input.presetId) {
    throw new Error('Пресет не совпадает с закреплённым за проектом');
  }
  const bound = Boolean(binding.portal_project_id);
  if (bound && (binding.portal_project_id !== input.portalProjectId
    || binding.portal_period_id !== input.portalPeriodId || binding.target_contacts !== input.targetContacts)) {
    throw new Error('Проект, период или обязательство не совпадает с закреплённым планом');
  }
  const scheduleDays = normalizeContactDeliveryScheduleDays(bound ? binding.delivery_schedule_days : preset.schedule_days);
  const dailyCapacity = bound ? binding.sender_daily_capacity : contactDeliveryDailyCapacity(preset);
  const timezone = (bound ? binding.delivery_timezone : preset.schedule_timezone)?.trim();
  if (!scheduleDays || !Number.isSafeInteger(dailyCapacity) || dailyCapacity <= 0 || !timezone) {
    throw new Error('Для плана нужны будние дни, часовой пояс и положительный дневной лимит');
  }
  // Validate the IANA zone before persisting or forecasting.
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  return { scheduleDays, dailyCapacity: dailyCapacity as number, timezone: timezone as string };
}
