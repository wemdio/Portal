import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { activateCampaign, getCampaign } from '@/lib/instantly/client';
import { CampaignStatus } from '@/lib/instantly/types';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import {
  launchMailboxScopesEqual,
  launchMailboxScopesOverlap,
  normalizeLaunchMailboxIds,
} from '@/lib/verticalEngineV2/launchPortfolio';
import {
  refreshRuLaunchPortfolioTiming,
  VeLaunchTimingRefreshError,
  type VeLaunchTimingSourceRow,
} from '@/lib/verticalEngineV2/launchPortfolioTiming';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface ReserveCampaign {
  campaign_id: string;
  segment?: string | null;
}

interface ReserveItem {
  id: string;
  status?: string;
  instantly_account_id?: string;
}

interface ReserveResult {
  reserved?: boolean;
  replayed?: boolean;
  status?: string;
  code?: string;
  error?: string;
  activation_reservation_id?: string;
  item?: ReserveItem;
  campaigns?: ReserveCampaign[];
}

interface ReconciliationItem extends VeLaunchTimingSourceRow {
  id: string;
  instantly_account_id: string;
  mailbox_ids: string[];
  status: string;
}

interface ReconciliationScope {
  accountId: string;
  candidateCampaignIds: string[];
}

type ReconciliationResult =
  | { ok: true; scope: ReconciliationScope }
  | { ok: false; response: NextResponse };

const KNOWN_REMOTE_STATUSES = new Set<number>(Object.values(CampaignStatus));
const RECONCILIATION_PAGE_SIZE = 100;
const RECONCILIATION_ITEM_BATCH_SIZE = 50;
const RECONCILIATION_STATUSES = [
  'prepared',
  'queued',
  'activating',
  'active',
  'uncertain',
  'released',
] as const;

function jsonError(error: string, status: number, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function asReserveResult(value: unknown): ReserveResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ReserveResult;
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

function exactReservedCampaigns(
  value: unknown,
  expectedCampaignIds: readonly string[],
): ReserveCampaign[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const campaigns: ReserveCampaign[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const campaign = candidate as Partial<ReserveCampaign>;
    if (
      typeof campaign.campaign_id !== 'string' ||
      campaign.campaign_id.length === 0 ||
      campaign.campaign_id !== campaign.campaign_id.trim() ||
      ids.has(campaign.campaign_id)
    ) {
      return null;
    }
    ids.add(campaign.campaign_id);
    campaigns.push(campaign as ReserveCampaign);
  }
  const expected = [...new Set(expectedCampaignIds)].sort();
  const actual = [...ids].sort();
  if (
    expected.length === 0 ||
    actual.length !== expected.length ||
    actual.some((campaignId, index) => campaignId !== expected[index])
  ) {
    return null;
  }
  return campaigns;
}

async function readLaunchItem(itemId: string) {
  if (!supabaseAdmin) return { data: null, error: { message: 'Server misconfigured' } };
  return supabaseAdmin
    .from('ve_launch_queue_items')
    .select('id, status, instantly_account_id, mailbox_ids')
    .eq('id', itemId)
    .maybeSingle();
}

async function loadScopedItems(
  accountId: string,
  candidateMailboxes: string[],
): Promise<ReconciliationItem[]> {
  if (!supabaseAdmin) throw new Error('Server misconfigured');
  const rows: ReconciliationItem[] = [];
  let offset = 0;
  let exactCount: number | null = null;
  while (exactCount === null || offset < exactCount) {
    const result = await supabaseAdmin
      .from('ve_launch_queue_items')
      .select(
        'id, portfolio_id, hypothesis_id, instantly_account_id, mailbox_ids, status, seasonality_input_hash, seasonality_snapshot, estimated_run_days',
        { count: 'exact' },
      )
      .eq('instantly_account_id', accountId)
      .in('status', [...RECONCILIATION_STATUSES])
      .overlaps('mailbox_ids', candidateMailboxes)
      .order('id', { ascending: true })
      .range(offset, offset + RECONCILIATION_PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    if (typeof result.count !== 'number' || result.count < 0) {
      throw new Error('Scoped launch item count is unavailable');
    }
    if (exactCount === null) exactCount = result.count;
    if (result.count !== exactCount) throw new Error('Scoped launch items changed during pagination');
    const page = result.data ?? [];
    if (page.length === 0 && offset < exactCount) {
      throw new Error('Scoped launch item pagination ended early');
    }
    for (const row of page) {
      if (
        typeof row.id !== 'string' ||
        typeof row.instantly_account_id !== 'string' ||
        typeof row.status !== 'string' ||
        row.instantly_account_id !== accountId ||
        normalizeLaunchMailboxIds(row.mailbox_ids).length === 0 ||
        !launchMailboxScopesOverlap(candidateMailboxes, row.mailbox_ids)
      ) {
        throw new Error('Invalid scoped launch item');
      }
      rows.push(row as unknown as ReconciliationItem);
    }
    offset += page.length;
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error('Duplicate scoped launch item');
  }
  return rows;
}

async function loadCampaignsByItem(
  scopedItemIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (!supabaseAdmin) throw new Error('Server misconfigured');
  const campaignsByItem = new Map<string, string[]>();
  for (const itemIds of chunked(scopedItemIds, RECONCILIATION_ITEM_BATCH_SIZE)) {
    let offset = 0;
    let exactCount: number | null = null;
    while (exactCount === null || offset < exactCount) {
      const result = await supabaseAdmin
        .from('ve_launch_queue_campaigns')
        .select('id, item_id, campaign_id', { count: 'exact' })
        .in('item_id', itemIds)
        .order('id', { ascending: true })
        .range(offset, offset + RECONCILIATION_PAGE_SIZE - 1);
      if (result.error) throw new Error(result.error.message);
      if (typeof result.count !== 'number' || result.count < 0) {
        throw new Error('Scoped campaign count is unavailable');
      }
      if (exactCount === null) exactCount = result.count;
      if (result.count !== exactCount) throw new Error('Scoped campaigns changed during pagination');
      const page = result.data ?? [];
      if (page.length === 0 && offset < exactCount) {
        throw new Error('Scoped campaign pagination ended early');
      }
      for (const row of page) {
        if (
          typeof row.item_id !== 'string' ||
          !itemIds.includes(row.item_id) ||
          typeof row.campaign_id !== 'string' ||
          row.campaign_id.length === 0 ||
          row.campaign_id !== row.campaign_id.trim()
        ) {
          throw new Error('Invalid scoped campaign');
        }
        const group = campaignsByItem.get(row.item_id) ?? [];
        if (group.includes(row.campaign_id)) throw new Error('Duplicate scoped campaign');
        group.push(row.campaign_id);
        campaignsByItem.set(row.item_id, group);
      }
      offset += page.length;
    }
  }
  if (scopedItemIds.some((itemId) => (campaignsByItem.get(itemId)?.length ?? 0) === 0)) {
    throw new Error('A scoped launch item has no tracked campaigns');
  }
  return campaignsByItem;
}

/**
 * Refresh every campaign sharing the candidate's immutable mailbox scope.
 * This is the fence for a specialist who bypassed Portal and clicked Activate
 * directly in Instantly: the remote-active bundle is restored as a DB holder
 * before the reservation RPC evaluates capacity.
 */
async function reconcileActivationScope(itemId: string): Promise<ReconciliationResult> {
  if (!supabaseAdmin) {
    return {
      ok: false,
      response: jsonError('Server misconfigured', 500, 'SERVER_MISCONFIGURED'),
    };
  }

  const { data: candidate, error: candidateError } = await supabaseAdmin
    .from('ve_launch_queue_items')
    .select('id, instantly_account_id, mailbox_ids')
    .eq('id', itemId)
    .maybeSingle();
  if (candidateError) {
    return {
      ok: false,
      response: jsonError(candidateError.message, 500, 'VE_LAUNCH_RECONCILIATION_FAILED'),
    };
  }
  if (!candidate) {
    return {
      ok: false,
      response: jsonError('Launch item not found', 404, 'VE_LAUNCH_ITEM_NOT_FOUND'),
    };
  }

  const accountId = typeof candidate.instantly_account_id === 'string'
    ? candidate.instantly_account_id.trim()
    : '';
  const candidateMailboxes = normalizeLaunchMailboxIds(candidate.mailbox_ids);
  if (!accountId || candidateMailboxes.length === 0) {
    return {
      ok: false,
      response: jsonError(
        'Не задан неизменяемый scope отправителей.',
        409,
        'VE_LAUNCH_MAILBOX_SCOPE_REQUIRED',
      ),
    };
  }

  let scopedItems: ReconciliationItem[];
  let campaignsByItem: Map<string, string[]>;
  try {
    scopedItems = await loadScopedItems(accountId, candidateMailboxes);
    await refreshRuLaunchPortfolioTiming({
      db: supabaseAdmin,
      rows: scopedItems,
      now: new Date(),
    });
    campaignsByItem = await loadCampaignsByItem(scopedItems.map((item) => item.id));
  } catch (error) {
    const timingRefreshFailed = error instanceof VeLaunchTimingRefreshError;
    await logError(
      timingRefreshFailed
        ? 'tools.vertical-engine-v2.launch-portfolio.preflight_timing_refresh_failed'
        : 'tools.vertical-engine-v2.launch-portfolio.preflight_scope_failed',
      error,
      {
        itemId,
        accountId,
      },
    );
    return {
      ok: false,
      response: jsonError(
        timingRefreshFailed
          ? 'Не удалось обновить сезонный план запуска; активация остановлена.'
          : 'Не удалось полностью загрузить группы для живой сверки; активация остановлена.',
        502,
        timingRefreshFailed ? error.code : 'VE_LAUNCH_RECONCILIATION_FAILED',
      ),
    };
  }
  const scopedIds = scopedItems.map((item) => item.id);
  if (!scopedIds.includes(itemId)) {
    return {
      ok: false,
      response: jsonError(
        'Группа запуска отсутствует в reconciliation scope.',
        409,
        'VE_LAUNCH_RECONCILIATION_REQUIRED',
      ),
    };
  }

  const observedAt = new Date().toISOString();
  try {
    for (const item of scopedItems) {
      const observations = await Promise.all(
        (campaignsByItem.get(item.id) ?? []).map(async (campaignId) => {
          const live = await getCampaign(campaignId, { accountId });
          if (!live || live.id !== campaignId) {
            throw new Error(`Instantly campaign identity mismatch for ${campaignId}`);
          }
          if (typeof live.status !== 'number' || !KNOWN_REMOTE_STATUSES.has(live.status)) {
            throw new Error(`Unknown Instantly status for ${campaignId}`);
          }
          if (!launchMailboxScopesEqual(item.mailbox_ids, live.email_list)) {
            throw new Error(`Instantly sender scope mismatch for ${campaignId}`);
          }
          return {
            campaign_id: campaignId,
            status: live.status,
            status_observed_at: observedAt,
          };
        }),
      );
      const { data, error } = await supabaseAdmin.rpc('ve_reconcile_launch_campaign_statuses', {
        p_item_id: item.id,
        p_campaigns: observations,
        p_now: observedAt,
      });
      if (error) throw new Error(error.message);
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        (data as { reconciled?: unknown }).reconciled !== true
      ) {
        throw new Error(`Launch reconciliation was rejected for ${item.id}`);
      }
    }
  } catch (error) {
    await logError('tools.vertical-engine-v2.launch-portfolio.preflight_reconcile_failed', error, {
      itemId,
      accountId,
      scopedItemIds: scopedIds,
    });
    return {
      ok: false,
      response: jsonError(
        'Не удалось сверить живые состояния Instantly; активация остановлена.',
        502,
        'VE_LAUNCH_RECONCILIATION_FAILED',
      ),
    };
  }

  return {
    ok: true,
    scope: {
      accountId,
      candidateCampaignIds: campaignsByItem.get(itemId) ?? [],
    },
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.launch-portfolio.activate' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500, 'SERVER_MISCONFIGURED');

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400, 'VE_LAUNCH_ITEM_REQUIRED');

      let body: {
        confirm_campaign_review?: unknown;
        idempotency_key?: unknown;
        plan_version?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400, 'INVALID_BODY');
      }

      if (body.confirm_campaign_review !== true) {
        return jsonError(
          'Подтвердите, что проверили подготовленные кампании.',
          409,
          'VE_LAUNCH_REVIEW_REQUIRED',
        );
      }
      const idempotencyKey =
        typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
      if (!idempotencyKey) {
        return jsonError(
          'Для активации нужен idempotency key.',
          400,
          'VE_LAUNCH_IDEMPOTENCY_KEY_REQUIRED',
        );
      }
      const planVersion =
        typeof body.plan_version === 'number' &&
        Number.isInteger(body.plan_version) &&
        body.plan_version > 0
          ? body.plan_version
          : null;
      if (planVersion === null) {
        return jsonError(
          'План очереди изменился. Обновите список запусков.',
          409,
          'VE_LAUNCH_PLAN_STALE',
        );
      }

      const reconciliation = await reconcileActivationScope(id);
      if (!reconciliation.ok) return reconciliation.response;

      const activationReservationId = randomUUID();
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin.rpc('ve_reserve_launch_activation', {
        p_item_id: id,
        p_actor_id: authed.auth.userId,
        p_idempotency_key: idempotencyKey,
        p_expected_plan_version: planVersion,
        p_activation_reservation_id: activationReservationId,
        p_now: now,
      });
      if (error) {
        await logError('tools.vertical-engine-v2.launch-portfolio.reserve_failed', error, {
          userId: authed.auth.userId,
          itemId: id,
        });
        return jsonError(error.message, 500, 'VE_LAUNCH_RESERVATION_FAILED');
      }

      const reserved = asReserveResult(data);
      if (reserved.replayed === true && reserved.code) {
        return jsonError(
          reserved.error || 'Idempotency key уже относится к другому запуску.',
          409,
          reserved.code,
        );
      }
      if (reserved.replayed === true) {
        const replayStatus = reserved.item?.status ?? reserved.status ?? '';
        if (replayStatus === 'active') {
          return NextResponse.json({
            ok: true,
            replayed: true,
            status: 'active',
            item: reserved.item ?? null,
          });
        }
        if (replayStatus === 'activating' || replayStatus === 'uncertain') {
          const replayReconciliation = await reconcileActivationScope(id);
          if (!replayReconciliation.ok) return replayReconciliation.response;
          const refreshed = await readLaunchItem(id);
          if (refreshed.error) {
            return jsonError(
              'Не удалось подтвердить состояние повторного запуска.',
              502,
              'VE_LAUNCH_ACTIVATION_UNCERTAIN',
            );
          }
          if (refreshed.data?.status === 'active') {
            return NextResponse.json({
              ok: true,
              replayed: true,
              status: 'active',
              item: refreshed.data,
            });
          }
          return jsonError(
            'Состояние повторного запуска не подтверждено. Слот сохранён до следующей живой сверки.',
            502,
            'VE_LAUNCH_ACTIVATION_UNCERTAIN',
          );
        }
        return jsonError(
          'Повторный запрос не соответствует подтверждённому активному запуску.',
          409,
          'VE_LAUNCH_REPLAY_NOT_ACTIVE',
        );
      }
      if (reserved.reserved !== true) {
        return jsonError(
          reserved.error || 'Запуск сейчас недоступен.',
          409,
          reserved.code || 'VE_LAUNCH_RESERVATION_REJECTED',
        );
      }

      const exactReservationId = activationReservationId;
      const accountId = typeof reserved.item?.instantly_account_id === 'string'
        ? reserved.item.instantly_account_id.trim()
        : '';
      const campaigns = exactReservedCampaigns(
        reserved.campaigns,
        reconciliation.scope.candidateCampaignIds,
      );

      let activationError: unknown = null;
      if (
        reserved.activation_reservation_id !== activationReservationId ||
        reserved.item?.id !== id ||
        accountId !== reconciliation.scope.accountId ||
        campaigns === null
      ) {
        activationError = new Error(
          'Reservation payload does not match the immutable workspace and campaign scope',
        );
      } else {
        for (const campaign of campaigns) {
          try {
            await activateCampaign(campaign.campaign_id, { accountId });
          } catch (error_) {
            activationError = error_;
            break;
          }
        }
      }

      const terminalStatus = activationError ? 'uncertain' : 'active';
      const terminalError =
        activationError instanceof Error
          ? activationError.message
          : activationError
            ? String(activationError)
            : null;
      const finalizedAt = new Date().toISOString();
      const { data: finalized, error: finalizeError } = await supabaseAdmin.rpc(
        've_finalize_launch_activation',
        {
          p_item_id: id,
          p_activation_reservation_id: exactReservationId,
          p_status: terminalStatus,
          p_error: terminalError?.slice(0, 500) ?? null,
          p_now: finalizedAt,
        },
      );
      const finalizeAccepted = Boolean(
        finalized &&
        typeof finalized === 'object' &&
        !Array.isArray(finalized) &&
        (finalized as { finalized?: unknown }).finalized === true,
      );
      if (finalizeError || !finalizeAccepted) {
        await logError(
          'tools.vertical-engine-v2.launch-portfolio.finalize_failed',
          finalizeError ?? new Error('Activation finalization was rejected'),
          {
            userId: authed.auth.userId,
            itemId: id,
            activationReservationId: exactReservationId,
            terminalStatus,
          },
        );
        return jsonError(
          'Активация могла выполниться, но её состояние не удалось сохранить. Слот оставлен занятым до сверки.',
          502,
          'VE_LAUNCH_ACTIVATION_UNCERTAIN',
        );
      }

      if (activationError) {
        await logError('tools.vertical-engine-v2.launch-portfolio.activation_uncertain', activationError, {
          userId: authed.auth.userId,
          itemId: id,
          campaigns: campaigns?.map((campaign) => campaign.campaign_id) ?? [],
        });
        return jsonError(
          'Не все кампании подтвердили запуск. Слот оставлен занятым до сверки.',
          502,
          'VE_LAUNCH_ACTIVATION_UNCERTAIN',
        );
      }

      await logAudit(
        'tools.vertical-engine-v2.launch-portfolio.activated',
        'Vertical Engine v2 launch bundle activated',
        {
          userId: authed.auth.userId,
          itemId: id,
          activationReservationId: exactReservationId,
          instantlyAccountId: accountId,
          campaigns: campaigns?.map((campaign) => campaign.campaign_id) ?? [],
        },
      );

      return NextResponse.json({
        ok: true,
        replayed: false,
        status: 'active',
        item: reserved.item ?? null,
        result: finalized ?? null,
      });
    },
  );
}
