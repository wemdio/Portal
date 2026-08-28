import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCampaign } from '@/lib/instantly/client';
import { CampaignStatus } from '@/lib/instantly/types';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { launchMailboxScopesEqual } from '@/lib/verticalEngineV2/launchPortfolio';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

type Row = Record<string, unknown>;

const CHILD_CAMPAIGN_PAGE_SIZE = 200;

const KNOWN_CAMPAIGN_STATUSES = new Set<number>(Object.values(CampaignStatus));
const SENDING_CAMPAIGN_STATUSES = new Set<number>([
  CampaignStatus.Active,
  CampaignStatus.RunningSubsequences,
]);

function jsonError(error: string, status: number, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function nullableManualOrder(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return value as null | undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function nullableDateKey(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value as null | undefined;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? value.trim()
    : undefined;
}

function rpcRow(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

function rpcCode(value: Row | null, fallback: string): string {
  return typeof value?.code === 'string' && value.code ? value.code : fallback;
}

async function readExactChildCampaigns(
  db: NonNullable<typeof supabaseAdmin>,
  itemId: string,
): Promise<{ data: Row[]; error: { message: string } | null }> {
  const rows: Row[] = [];
  let exactCount: number | null = null;

  for (let offset = 0; ; offset += CHILD_CAMPAIGN_PAGE_SIZE) {
    const result = await db
      .from('ve_launch_queue_campaigns')
      .select('id, item_id, campaign_id', { count: 'exact' })
      .eq('item_id', itemId)
      .order('id', { ascending: true })
      .range(offset, offset + CHILD_CAMPAIGN_PAGE_SIZE - 1);
    if (result.error) return { data: [], error: result.error };
    if (
      typeof result.count !== 'number'
      || !Number.isSafeInteger(result.count)
      || result.count < 0
    ) {
      return { data: [], error: { message: 'Exact child campaign count is unavailable' } };
    }
    if (exactCount === null) exactCount = result.count;
    if (result.count !== exactCount) {
      return { data: [], error: { message: 'Child campaigns changed during pagination' } };
    }

    const page = (result.data ?? []) as Row[];
    const expectedPageRows = Math.min(
      CHILD_CAMPAIGN_PAGE_SIZE,
      Math.max(0, exactCount - offset),
    );
    if (page.length !== expectedPageRows) {
      return { data: [], error: { message: 'Child campaign pagination ended early' } };
    }
    rows.push(...page);
    if (rows.length === exactCount) return { data: rows, error: null };
    if (rows.length > exactCount) {
      return { data: [], error: { message: 'Child campaign pagination exceeded exact count' } };
    }
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.launch-portfolio.item.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500, 'SERVER_MISCONFIGURED');

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400, 'VE_LAUNCH_ITEM_REQUIRED');

      let body: {
        action?: unknown;
        decision?: unknown;
        reason?: unknown;
        manual_order?: unknown;
        not_before?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400, 'INVALID_BODY');
      }

      const action = typeof body.action === 'string' ? body.action.trim() : '';
      if (action !== 'override_seasonality' && action !== 'release') {
        return jsonError('Unknown action', 400, 'VE_LAUNCH_ACTION_INVALID');
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) {
        return jsonError('Укажите причину ручного решения.', 400, 'VE_LAUNCH_REASON_REQUIRED');
      }

      const now = new Date().toISOString();
      if (action === 'override_seasonality') {
        const requestedDecision = typeof body.decision === 'string' ? body.decision.trim() : '';
        if (requestedDecision !== 'activate_next' && requestedDecision !== 'wait') {
          return jsonError('Некорректное сезонное решение.', 400, 'VE_LAUNCH_DECISION_INVALID');
        }
        const decision = requestedDecision;
        const manualOrder = body.manual_order === undefined && decision === 'activate_next'
          ? 0
          : nullableManualOrder(body.manual_order);
        const notBefore = nullableDateKey(body.not_before);
        if (body.manual_order !== undefined && manualOrder === undefined) {
          return jsonError('Некорректный ручной приоритет.', 400, 'VE_LAUNCH_MANUAL_ORDER_INVALID');
        }
        if (body.not_before !== undefined && notBefore === undefined) {
          return jsonError('Некорректная дата запуска.', 400, 'VE_LAUNCH_NOT_BEFORE_INVALID');
        }

        const { data, error } = await supabaseAdmin.rpc('ve_override_launch_priority', {
          p_item_id: id,
          p_actor_id: authed.auth.userId,
          p_reason: reason,
          p_decision: decision,
          p_manual_order: manualOrder ?? null,
          p_not_before: notBefore ?? null,
          p_now: now,
        });
        if (error) {
          await logError('tools.vertical-engine-v2.launch-portfolio.override_failed', error, {
            userId: authed.auth.userId,
            itemId: id,
          });
          return jsonError(error.message, 500, 'VE_LAUNCH_OVERRIDE_FAILED');
        }
        const result = rpcRow(data);
        if (result?.overridden !== true) {
          return jsonError(
            'Ручное решение не было сохранено.',
            409,
            rpcCode(result, 'VE_LAUNCH_OVERRIDE_REJECTED'),
          );
        }
        await logAudit(
          'tools.vertical-engine-v2.launch-portfolio.overridden',
          'Vertical Engine v2 launch priority overridden',
          { userId: authed.auth.userId, itemId: id, reason, manualOrder, notBefore },
        );
        return NextResponse.json({
          ok: true,
          item: result?.item ?? null,
          result: data ?? null,
        });
      }

      const { data: item, error: itemError } = await supabaseAdmin
        .from('ve_launch_queue_items')
        .select('id, instantly_account_id, mailbox_ids, status')
        .eq('id', id)
        .maybeSingle();
      if (itemError) return jsonError(itemError.message, 500, 'VE_LAUNCH_ITEM_READ_FAILED');
      if (!item) return jsonError('Launch item not found', 404, 'VE_LAUNCH_ITEM_NOT_FOUND');
      if (item.status === 'activating') {
        return jsonError(
          'Активация ещё выполняется; слот нельзя освобождать до завершения или recovery-сверки.',
          409,
          'VE_LAUNCH_ACTIVATION_IN_PROGRESS',
        );
      }
      if (item.status !== 'active' && item.status !== 'uncertain') {
        return jsonError(
          'Эта группа сейчас не удерживает sending slot.',
          409,
          'VE_LAUNCH_BUNDLE_NOT_HOLDING_SLOT',
        );
      }

      const { data: campaignRows, error: campaignsError } = await readExactChildCampaigns(
        supabaseAdmin,
        id,
      );
      if (campaignsError) {
        return jsonError(campaignsError.message, 500, 'VE_LAUNCH_CAMPAIGNS_READ_FAILED');
      }
      if (campaignRows.length === 0) {
        return jsonError(
          'У группы запуска нет кампаний для живой сверки.',
          409,
          'VE_LAUNCH_LIVE_PROOF_REQUIRED',
        );
      }

      const accountId = typeof item.instantly_account_id === 'string'
        ? item.instantly_account_id.trim()
        : '';
      if (!accountId) {
        return jsonError('Не задан Instantly workspace.', 409, 'VE_LAUNCH_WORKSPACE_REQUIRED');
      }

      const observedAt = new Date().toISOString();
      const observations: Array<{
        campaign_id: string;
        status: number;
        status_observed_at: string;
      }> = [];
      try {
        for (const campaignRow of campaignRows) {
          const campaignId = typeof campaignRow.campaign_id === 'string'
            ? campaignRow.campaign_id
            : '';
          if (!campaignId) throw new Error('Campaign id is missing');
          const live = await getCampaign(campaignId, { accountId });
          if (!live || live.id !== campaignId) {
            return jsonError(
              'Instantly вернул другую кампанию; слот сохранён.',
              409,
              'VE_LAUNCH_CAMPAIGN_IDENTITY_MISMATCH',
            );
          }
          if (!launchMailboxScopesEqual(item.mailbox_ids, live.email_list)) {
            return jsonError(
              'Набор отправителей кампании отличается от снимка запуска; слот сохранён.',
              409,
              'VE_LAUNCH_MAILBOX_SCOPE_MISMATCH',
            );
          }
          if (typeof live.status !== 'number' || !KNOWN_CAMPAIGN_STATUSES.has(live.status)) {
            return jsonError(
              'Instantly вернул неизвестное состояние кампании; слот сохранён.',
              409,
              'VE_LAUNCH_LIVE_PROOF_REQUIRED',
            );
          }
          if (SENDING_CAMPAIGN_STATUSES.has(live.status)) {
            return jsonError(
              'Хотя бы одна кампания всё ещё отправляет письма.',
              409,
              'VE_LAUNCH_CAMPAIGN_STILL_ACTIVE',
            );
          }
          observations.push({
            campaign_id: campaignId,
            status: live.status,
            status_observed_at: observedAt,
          });
        }
      } catch (error) {
        await logError('tools.vertical-engine-v2.launch-portfolio.live_status_failed', error, {
          userId: authed.auth.userId,
          itemId: id,
        });
        return jsonError(
          'Не удалось получить свежие состояния всех кампаний; слот сохранён.',
          502,
          'VE_LAUNCH_LIVE_PROOF_FAILED',
        );
      }

      const { data: reconciled, error: reconcileError } = await supabaseAdmin.rpc(
        've_reconcile_launch_campaign_statuses',
        {
          p_item_id: id,
          p_campaigns: observations,
          p_now: observedAt,
        },
      );
      if (reconcileError) {
        return jsonError(reconcileError.message, 500, 'VE_LAUNCH_RECONCILE_FAILED');
      }
      const reconcileResult = rpcRow(reconciled);
      if (reconcileResult?.reconciled !== true) {
        return jsonError(
          'Живые статусы не удалось зафиксировать; слот сохранён.',
          409,
          rpcCode(reconcileResult, 'VE_LAUNCH_RECONCILE_REJECTED'),
        );
      }
      const { data: released, error: releaseError } = await supabaseAdmin.rpc(
        've_manual_release_launch_slot',
        {
          p_item_id: id,
          p_actor_id: authed.auth.userId,
          p_reason: reason,
          p_now: observedAt,
        },
      );
      if (releaseError) {
        return jsonError(releaseError.message, 500, 'VE_LAUNCH_RELEASE_FAILED');
      }
      const releaseResult = rpcRow(released);
      if (releaseResult?.released !== true) {
        return jsonError(
          'Слот не был освобождён; проверьте живые статусы.',
          409,
          rpcCode(releaseResult, 'VE_LAUNCH_RELEASE_REJECTED'),
        );
      }

      await logAudit(
        'tools.vertical-engine-v2.launch-portfolio.released',
        'Vertical Engine v2 launch slot released manually',
        {
          userId: authed.auth.userId,
          itemId: id,
          reason,
          campaigns: observations,
        },
      );
      return NextResponse.json({
        ok: true,
        item: releaseResult?.item ?? null,
        result: released ?? null,
      });
    },
  );
}
