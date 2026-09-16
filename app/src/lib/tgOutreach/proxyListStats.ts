import type { SupabaseClient } from '@supabase/supabase-js';
import type { OutreachProxyListStats } from './types';

/**
 * Подсчёт статистики списка прокси. Вынесено, чтобы и конкретный список, и
 * «Неопределённые» считали одинаково — две ручки API дёргают одну функцию.
 *
 * Семантика:
 *  - Берём все строки прокси одним запросом (140 строк — мелочь, без пагинации).
 *  - Возраст считаем в часах от created_at до now.
 *  - «Активен» = is_active && нет активного cooldown (см. `isProxyHealthy` в
 *    `proxyHealth.ts` — логика общая, чтобы экран и бэкенд не разошлись).
 *  - «Мёртв» = !is_active. Поле `cooldown_until` отдельно не разбираем:
 *    прокси в cooldown — активный, просто отдыхает.
 *  - `avg_age_hours_at_death` — null, если выключенных нет. В UI не рисуется.
 */
export async function computeListStats(args: {
  campaignId: string;
  listId: string | null;
  supabase: SupabaseClient;
}): Promise<OutreachProxyListStats> {
  const { campaignId, listId, supabase } = args;
  const now = Date.now();
  let q = supabase
    .from('tg_outreach_proxies')
    .select('created_at, is_active, cooldown_until')
    .eq('campaign_id', campaignId);
  if (listId === null) {
    q = q.is('proxy_list_id', null);
  } else {
    q = q.eq('proxy_list_id', listId);
  }
  const { data: rows, error } = await q;
  if (error) throw error;

  const list = rows ?? [];
  let active = 0;
  let dead = 0;
  let totalAgeHours = 0;
  let deadAgeHours = 0;
  let deadAgeCount = 0;

  for (const r of list) {
    const created = new Date((r as { created_at: string }).created_at).getTime();
    const ageHours = (now - created) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours < 0) continue;
    totalAgeHours += ageHours;
    const isActive = (r as { is_active: boolean }).is_active;
    const cooldown = (r as { cooldown_until: string | null }).cooldown_until;
    const inCooldown = cooldown ? new Date(cooldown).getTime() > now : false;
    if (isActive && !inCooldown) {
      active++;
    } else if (!isActive) {
      dead++;
      deadAgeHours += ageHours;
      deadAgeCount++;
    }
  }

  return {
    proxy_count: list.length,
    active_count: active,
    dead_count: dead,
    avg_age_hours: list.length ? Math.round((totalAgeHours / list.length) * 10) / 10 : null,
    avg_age_hours_at_death: deadAgeCount > 0 ? Math.round((deadAgeHours / deadAgeCount) * 10) / 10 : null,
  };
}
