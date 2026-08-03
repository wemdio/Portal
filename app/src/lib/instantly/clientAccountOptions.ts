import 'server-only';

/**
 * Резолв requestOptions (в какой Instantly-аккаунт ходить) для клиента портала.
 *
 * Единая точка (DRY): источник — client_campaign_presets.instantly_account_id,
 * та же строка, что читает appendLeadsToClientCampaign при заливке лидов. Всё,
 * что работает с Instantly от имени клиента (append, дедуп его кампаний,
 * аналитика дашбордов), обязано ходить в ЕГО аккаунт — иначе чтения/записи
 * молча уходят в дефолтный воркспейс ('main').
 *
 * Пресета нет или аккаунт в нём не задан → дефолтный аккаунт
 * (resolveInstantlyAccountId(null) → 'main'). В отличие от appendLeads здесь
 * отсутствие пресета НЕ ошибка: read-only аналитика деградирует в дефолт.
 */

import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { resolveInstantlyAccountId, type InstantlyRequestOptions } from './accounts';

export async function resolveClientInstantlyRequestOptions(
  clientUserId: string,
): Promise<InstantlyRequestOptions> {
  if (!supabaseInstantly) return { accountId: resolveInstantlyAccountId(null) };
  const { data: presetRow } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('instantly_account_id')
    .eq('client_user_id', clientUserId)
    .maybeSingle();
  return {
    accountId: resolveInstantlyAccountId(
      (presetRow as { instantly_account_id?: string } | null)?.instantly_account_id ?? null,
    ),
  };
}
