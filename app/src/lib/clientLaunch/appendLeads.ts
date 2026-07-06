/**
 * Append leads to an already-existing client campaign.
 *
 * Используется ежедневным авто-пайплайном: кампании в Instantly создаются
 * один раз через bootstrap (по одной на каждый score-bucket), а затем cron
 * каждое утро подкладывает в них новых лидов. Создавать новую кампанию
 * каждый день — плохо: список в Instantly быстро раздуется, статистику
 * между днями нельзя будет агрегировать в одну воронку.
 *
 * Что эта функция делает (и НЕ делает):
 *   ✅ Проверяет статус клиента (active/setup/locked).
 *   ✅ Проверяет тарифный остаток по контактам.
 *   ✅ Вызывает Instantly createLeads на существующей кампании.
 *   ❌ НЕ создаёт кампанию, не активирует, не обновляет каталог.
 *   ❌ НЕ пишет запись в client_campaign_launches — для авто-режима журнал
 *      ведётся в client_auto_pipeline_runs + client_auto_pipeline_seen_employers.
 */

import { logAudit, logError } from '@/lib/loggerServer';
import { createLeads, listLeads } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { getBlockedEmailSet, filterBlockedLeads } from '@/lib/clientBlocklist/blockedContacts';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { ClientCampaignPreset } from './types';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import {
  countClientContacts,
  getBillingPeriodStart,
  getClientTariffRow,
  getClientStatus,
  resolveEffectiveLimits,
} from '@/lib/tariffs';
import { ClientLaunchError } from './runLaunch';

export interface AppendLeadsToClientCampaignInput {
  /** Client whose preset / Instantly account we use. */
  userId: string;
  /** Existing Instantly campaign id (created earlier via bootstrap). */
  campaignId: string;
  /** Pre-built and pre-validated leads. */
  leads: LeadCreatePayload[];
  /**
   * Optional label for logs / debugging — typically the bucket name, e.g.
   * "Auto HH — High score".
   */
  contextLabel?: string;
  /**
   * Instantly-флаг skip_if_in_campaign. По умолчанию true — как для клиентских
   * запусков (не дублировать лид в кампании при ежедневном доборе).
   *
   * ВАЖНО: вопреки названию, у Instantly этот флаг работает НА ВЕСЬ ВОРКСПЕЙС —
   * лид отсеивается, если он есть в ЛЮБОЙ кампании, включая чужие клиентские
   * (проверено эмпирически). OutreachOS ставит false: наш пайплайн сам решает,
   * кого слать (свой seen-журнал + дедуп против СВОИХ кампаний), а Instantly
   * должен грузить всё подготовленное, не отсеивая по пересечению с клиентами.
   */
  skipIfInCampaign?: boolean;
}

export interface AppendLeadsResult {
  accepted: number;
  skipped: number;
}

/**
 * Собирает email всех лидов, уже лежащих в указанных кампаниях клиента.
 * Нужно OutreachOS-пайплайну: он шлёт с skip_if_in_campaign=false (чтобы
 * Instantly не резал по пересечению с чужими клиентскими кампаниями), поэтому
 * дедуп против СВОИХ кампаний должен делать сам — ДО Instantly. Аккаунт берём
 * из пресета клиента (как в append). Пагинация по 100; кап страниц — предохранитель.
 */
export async function fetchExistingCampaignEmails(
  userId: string,
  campaignIds: readonly string[],
): Promise<Set<string>> {
  const emails = new Set<string>();
  if (!supabaseInstantly || campaignIds.length === 0) return emails;

  const { data: presetRow } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('instantly_account_id')
    .eq('client_user_id', userId)
    .maybeSingle();
  const accountId = resolveInstantlyAccountId(
    (presetRow as { instantly_account_id?: string } | null)?.instantly_account_id ?? null,
  );
  const opts = { accountId };

  const MAX_PAGES = 500; // 50k лидов на кампанию — с огромным запасом
  for (const campaignId of campaignIds) {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await listLeads({ campaign_id: campaignId, limit: 100, starting_after: after }, opts);
      for (const l of res.items ?? []) {
        const e = (l.email ?? '').trim().toLowerCase();
        if (e) emails.add(e);
      }
      after = res.next_starting_after || undefined;
      if (!after) break;
    }
  }
  return emails;
}

export async function appendLeadsToClientCampaign(
  input: AppendLeadsToClientCampaignInput,
): Promise<AppendLeadsResult> {
  if (!supabaseInstantly) {
    throw new ClientLaunchError('Server misconfigured: supabaseInstantly is not available', 500);
  }
  if (input.leads.length === 0) {
    return { accepted: 0, skipped: 0 };
  }

  const { userId, campaignId, leads, contextLabel } = input;
  const skipIfInCampaign = input.skipIfInCampaign ?? true;
  const logMeta = { userId, campaignId, contextLabel };

  // 1. Load preset — нужен только чтобы понять, в какой Instantly-аккаунт
  //    обращаться. Сама кампания уже создана.
  const { data: presetRow, error: presetErr } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('id, instantly_account_id')
    .eq('client_user_id', userId)
    .maybeSingle();

  if (presetErr) {
    await logError('client.appendLeads.preset_load_failed', presetErr, {}, logMeta);
    throw new ClientLaunchError('Не удалось загрузить пресет', 500);
  }

  const preset = presetRow as Pick<ClientCampaignPreset, 'id' | 'instantly_account_id'> | null;
  if (!preset) {
    throw new ClientLaunchError('Пресет клиента не настроен', 400);
  }

  // 1b. Чёрный список клиента — как в runClientLaunch: заблокированные адреса
  //     не попадают в Instantly и не съедают тарифный лимит. Особенно важно
  //     здесь: авто-пайплайн каждый день подкладывает новых лидов без участия
  //     клиента, и без фильтра негативный контакт получал бы письма снова.
  const blockedSet = await getBlockedEmailSet(supabaseInstantly, userId);
  const { kept: allowedLeads, blockedCount } = filterBlockedLeads(leads, blockedSet);
  if (allowedLeads.length === 0) {
    await logAudit(
      'client.appendLeads.all_blocked',
      'All leads in batch are on the client blocklist',
      { campaignId, contextLabel, blocked: blockedCount },
      logMeta,
    );
    return { accepted: 0, skipped: blockedCount };
  }

  // 2. Tariff / status — те же проверки, что в полном runClientLaunch.
  const tariffRow = await getClientTariffRow(userId);
  const clientStatus = getClientStatus(tariffRow);
  if (clientStatus === 'setup') {
    throw new ClientLaunchError(
      'Идёт прогрев почт. Добавление лидов в кампании станет доступным после завершения прогрева (15 дней с момента оплаты).',
      403,
    );
  }
  if (clientStatus !== 'active') {
    throw new ClientLaunchError(
      'Подписка не активна — пропускаем прогон',
      403,
    );
  }

  const limits = resolveEffectiveLimits(tariffRow);
  const periodStart = getBillingPeriodStart(tariffRow);
  const usedContacts = await countClientContacts(userId, periodStart);
  const remaining = Math.max(0, limits.max_contacts - usedContacts);

  // Если остатка не хватает на ВСЕХ — режем пачку, а не падаем. Авто-пайплайн
  // должен прокинуть в Instantly столько лидов, сколько вмещается; остальное
  // помечается skipped в seen_employers с reason=tariff_exhausted (это знает
  // оркестратор, не мы).
  const leadsToSend =
    allowedLeads.length <= remaining ? allowedLeads : allowedLeads.slice(0, remaining);
  if (leadsToSend.length === 0) {
    throw new ClientLaunchError('Лимит контактов исчерпан', 400);
  }

  const instantlyAccountId = resolveInstantlyAccountId(preset.instantly_account_id);
  const instantlyRequestOptions = { accountId: instantlyAccountId };

  try {
    const leadResult = await createLeads(
      leadsToSend,
      { campaign_id: campaignId, skip_if_in_campaign: skipIfInCampaign },
      instantlyRequestOptions,
    );

    const accepted = Number(
      (leadResult as { uploaded?: number; created?: number; total_uploaded?: number }).uploaded ??
        (leadResult as { created?: number }).created ??
        (leadResult as { total_uploaded?: number }).total_uploaded ??
        leadsToSend.length,
    );
    // В skipped входят и отсев Instantly, и срез по чёрному списку.
    const skipped = Math.max(0, leadsToSend.length - accepted) + blockedCount;

    await logAudit(
      'client.appendLeads.success',
      'Appended leads to existing campaign',
      {
        campaignId,
        contextLabel,
        accepted,
        skipped,
        blocked: blockedCount,
        requested: leadsToSend.length,
      },
      logMeta,
    );

    return { accepted, skipped };
  } catch (err) {
    await logError('client.appendLeads.failed', err, { campaignId }, logMeta);
    if (err instanceof ClientLaunchError) throw err;
    throw new ClientLaunchError(
      err instanceof Error ? err.message : 'Не удалось загрузить лидов в кампанию',
      500,
    );
  }
}
