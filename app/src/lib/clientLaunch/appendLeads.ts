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
import { resolveClientInstantlyRequestOptions } from '@/lib/instantly/clientAccountOptions';
import { getBlockedEmailSet, filterBlockedLeads } from '@/lib/clientBlocklist/blockedContacts';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  completeAppendLedgerBatch,
  failAppendLedgerBatch,
  startAppendLedgerBatch,
} from '@/lib/clientReports/ledgerStore';
import { buildAcceptedIdentitySnapshot } from '@/lib/clientReports/ledger';
import type { ClientCampaignPreset } from './types';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import {
  countClientContacts,
  getBillingPeriodStart,
  getClientTariffRow,
  getClientStatus,
  resolveEffectiveLimits,
  isAwaitingFirstPayment,
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
   * Instantly-флаг skip_if_in_campaign. По умолчанию true для старых
   * auto-pipeline вызовов, которым нужна идемпотентность при ежедневном доборе.
   * Первичный клиентский запуск передаёт false явно, чтобы контакт из другой
   * кампании того же воркспейса мог попасть в новую кампанию.
   *
   * ВАЖНО: вопреки названию, у Instantly этот флаг работает НА ВЕСЬ ВОРКСПЕЙС —
   * лид отсеивается, если он есть в ЛЮБОЙ кампании, включая чужие клиентские
   * (проверено эмпирически). OutreachOS ставит false: наш пайплайн сам решает,
   * кого слать (свой seen-журнал + дедуп против СВОИХ кампаний), а Instantly
   * должен грузить всё подготовленное, не отсеивая по пересечению с клиентами.
   */
  skipIfInCampaign?: boolean;
  /**
   * `managed_contract` is reserved for trusted server orchestrators whose
   * fulfillment limit comes from an explicit Portal project period instead
   * of the client's self-serve tariff. Blocklist and durable reporting still
   * apply. Browser input must never choose this mode.
   */
  entitlementMode?: 'client_tariff' | 'managed_contract';
  /** Immutable workspace fence supplied by a trusted campaign owner. */
  expectedInstantlyAccountId?: string;
  /** Durable reporting provenance for this append operation. */
  ledgerSource?: {
    kind: string;
    runId?: string | null;
    jobId?: string | null;
    campaignName?: string | null;
  };
}

export interface AppendLeadsResult {
  accepted: number;
  skipped: number;
  /** Exact positions in input.leads whose provider transport was started. */
  attemptedIndexes: number[];
  /** Exact positions in input.leads, or null when the provider only returned an aggregate. */
  acceptedIndexes: number[] | null;
  /** Exact permanent skips (blocklist or identified provider rejection), never retryable omissions. */
  skippedIndexes?: number[];
  identityComplete: boolean;
}

export class AppendLeadsPartialError extends ClientLaunchError {
  readonly partialResult: AppendLeadsResult;

  constructor(message: string, partialResult: AppendLeadsResult) {
    super(message, 500);
    this.name = 'AppendLeadsPartialError';
    this.partialResult = partialResult;
  }
}

const PROVIDER_APPEND_BATCH_SIZE = 1_000;

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

  // Аккаунт — из пресета клиента (как в append), общий резолв.
  const opts = await resolveClientInstantlyRequestOptions(userId);

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
    return {
      accepted: 0,
      skipped: 0,
      attemptedIndexes: [],
      acceptedIndexes: [],
      skippedIndexes: [],
      identityComplete: true,
    };
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
  const instantlyAccountId = resolveInstantlyAccountId(preset.instantly_account_id);
  if (
    input.expectedInstantlyAccountId !== undefined
    && instantlyAccountId !== input.expectedInstantlyAccountId
  ) {
    throw new ClientLaunchError('Instantly workspace изменился после подготовки кампании; долив остановлен', 409);
  }
  const instantlyRequestOptions = { accountId: instantlyAccountId };

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
    return {
      accepted: 0,
      skipped: blockedCount,
      attemptedIndexes: [],
      acceptedIndexes: [],
      skippedIndexes: leads.map((_, index) => index),
      identityComplete: true,
    };
  }

  // 2. Entitlement. Self-serve callers retain the existing tariff gate. VE2
  // uses an explicit Portal-period obligation whose atomic daily quota was
  // reserved before this function; it must not be blocked by an unrelated
  // self-serve subscription row created for the client's login.
  let leadsToSend = allowedLeads;
  if (input.entitlementMode !== 'managed_contract') {
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
    // Эскалация: неоплаченный после прогрева навсегда 'active' — режем «оформил,
    // но не оплатил» и на этом (авто-пайплайновом) send-пути тоже.
    if (isAwaitingFirstPayment(tariffRow)) {
      throw new ClientLaunchError(
        'Оформлена подписка, но оплата ещё не поступила — пропускаем прогон',
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
    leadsToSend =
      allowedLeads.length <= remaining ? allowedLeads : allowedLeads.slice(0, remaining);
  }
  if (leadsToSend.length === 0) {
    throw new ClientLaunchError('Лимит контактов исчерпан', 400);
  }

  if (!supabaseAdmin) {
    throw new ClientLaunchError('Server misconfigured: reporting ledger is not available', 500);
  }

  const inputIndexQueues = new Map<LeadCreatePayload, number[]>();
  leads.forEach((lead, index) => {
    const queue = inputIndexQueues.get(lead) ?? [];
    queue.push(index);
    inputIndexQueues.set(lead, queue);
  });
  const allowedInputIndexes = allowedLeads.map((lead) => {
    const index = inputIndexQueues.get(lead)?.shift();
    if (index === undefined) throw new Error('Blocked-contact filter changed lead identity');
    return index;
  });
  const sentInputIndexes = allowedInputIndexes.slice(0, leadsToSend.length);
  const allowedInputSet = new Set(allowedInputIndexes);
  const skippedIndexes = new Set(
    leads.map((_, index) => index).filter((index) => !allowedInputSet.has(index)),
  );

  const source = input.ledgerSource ?? { kind: 'campaign_append' };
  let accepted = 0;
  let externalSkipped = 0;
  let identityComplete = true;
  const acceptedIndexes: number[] = [];
  const attemptedIndexes = new Set<number>();
  const batchIds: string[] = [];

  const currentResult = (): AppendLeadsResult => ({
    accepted,
    skipped: externalSkipped + blockedCount,
    attemptedIndexes: [...attemptedIndexes].sort((a, b) => a - b),
    acceptedIndexes: identityComplete ? [...acceptedIndexes].sort((a, b) => a - b) : null,
    skippedIndexes: [...skippedIndexes].sort((a, b) => a - b),
    identityComplete,
  });

  for (let offset = 0; offset < leadsToSend.length; offset += PROVIDER_APPEND_BATCH_SIZE) {
    const chunk = leadsToSend.slice(offset, offset + PROVIDER_APPEND_BATCH_SIZE);
    const ledgerContext = {
      clientUserId: userId,
      campaignId,
      campaignName: source.campaignName ?? contextLabel ?? null,
      sourceKind: source.kind,
      sourceRunId: source.runId ?? null,
      sourceJobId: source.jobId ?? null,
      leads: chunk,
    };

    let batchId: string;
    try {
      ({ batchId } = await startAppendLedgerBatch(supabaseAdmin, {
        ...ledgerContext,
        blockedCount: offset === 0 ? blockedCount : 0,
        tariffSkippedCount: offset === 0
          ? Math.max(0, allowedLeads.length - leadsToSend.length)
          : 0,
        startedAt: new Date().toISOString(),
      }));
      batchIds.push(batchId);
    } catch (ledgerError) {
      await logError('client.appendLeads.ledger_start_failed', ledgerError, { campaignId, offset }, logMeta);
      throw new AppendLeadsPartialError(
        ledgerError instanceof Error ? ledgerError.message : 'Reporting ledger write failed',
        currentResult(),
      );
    }

    let chunkAccepted: number;
    let createdLeads: Array<{ id: string; email: string; index: number }> = [];
    try {
      const leadResult = await createLeads(
        chunk,
        { campaign_id: campaignId, skip_if_in_campaign: skipIfInCampaign },
        {
          ...instantlyRequestOptions,
          onRequestAttempt: () => {
            for (const index of sentInputIndexes.slice(offset, offset + chunk.length)) {
              attemptedIndexes.add(index);
            }
          },
        },
      );
      chunkAccepted = leadResult.leads_uploaded;
      createdLeads = leadResult.created_leads ?? [];
    } catch (err) {
      try {
        await failAppendLedgerBatch(supabaseAdmin, {
          ...ledgerContext,
          batchId,
          error: err,
          finishedAt: new Date().toISOString(),
        });
      } catch (ledgerError) {
        await logError('client.appendLeads.ledger_failure_write_failed', ledgerError, { campaignId, batchId }, logMeta);
      }
      await logError('client.appendLeads.failed', err, { campaignId, batchId, offset }, logMeta);
      throw new AppendLeadsPartialError(
        err instanceof Error ? err.message : 'Не удалось загрузить лидов в кампанию',
        currentResult(),
      );
    }

    const chunkSkipped = Math.max(0, chunk.length - chunkAccepted);
    const identity = buildAcceptedIdentitySnapshot({
      requested: chunk,
      accepted: chunkAccepted,
      createdLeads,
    });
    // The provider side effect has already happened. Reflect it in any partial
    // result even if the terminal journal write below is temporarily unavailable,
    // so callers never mistake a delivered chunk for an untouched one.
    accepted += chunkAccepted;
    externalSkipped += chunkSkipped;
    if (identity.identityComplete) {
      const acceptedChunkIndexes = new Set(identity.acceptedIdentities.map((entry) => entry.index));
      for (const acceptedIdentity of identity.acceptedIdentities) {
        const inputIndex = sentInputIndexes[offset + acceptedIdentity.index];
        if (inputIndex !== undefined) acceptedIndexes.push(inputIndex);
      }
      for (let index = 0; index < chunk.length; index += 1) {
        if (!acceptedChunkIndexes.has(index)) skippedIndexes.add(sentInputIndexes[offset + index]);
      }
    } else {
      identityComplete = false;
    }
    try {
      await completeAppendLedgerBatch(supabaseAdmin, {
        ...ledgerContext,
        batchId,
        accepted: chunkAccepted,
        skipped: chunkSkipped,
        createdLeads,
        finishedAt: new Date().toISOString(),
      });
    } catch (ledgerError) {
      await logError('client.appendLeads.ledger_completion_failed', ledgerError, {
        campaignId, batchId, accepted: chunkAccepted, offset,
      }, logMeta);
      throw new AppendLeadsPartialError(
        'Contacts were delivered, but the reporting confirmation journal could not be finalized',
        currentResult(),
      );
    }

  }

  // `skipped` remains backward compatible for callers: provider skips plus blocklist cuts.
  const result = currentResult();
  await logAudit(
    'client.appendLeads.success',
    'Appended leads to existing campaign',
    {
      campaignId,
      contextLabel,
      batchIds,
      accepted,
      skipped: result.skipped,
      blocked: blockedCount,
      requested: leadsToSend.length,
    },
    logMeta,
  );

  return result;
}
