import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { getCampaign } from '@/lib/instantly/client';
import { CampaignStatus } from '@/lib/instantly/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { VeBase, VeSegmentationAudit, VeTemplate } from '@/lib/verticalEngineV2/types';
import { launchMailboxScopesEqual } from '@/lib/verticalEngineV2/launchPortfolio';
import {
  VE_LAUNCH_MAX_LEADS,
  buildLaunchCampaignName,
  instantlyCampaignUrl,
  parseLaunchInfo,
  type VeTemplateLaunchInfo,
} from '@/lib/verticalEngineV2/launchHandoff';
import { reconcileExpiredLaunchReservation } from '@/lib/verticalEngineV2/launchReservation';
import {
  buildLaunchPortfolioMetadata,
  normalizedMailboxIds,
} from '@/lib/verticalEngineV2/launchTemplate';
import {
  prepareAuditSnapshot,
  validateStoredAuditSnapshot,
} from '@/lib/verticalEngineV2/stages/segmentationAudit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

type TemplateRow = Pick<
  VeTemplate,
  'id' | 'base_id' | 'vertical_id' | 'letters' | 'personalization_plan' | 'status'
> & { launch_info?: unknown };
type BaseRow = Pick<
  VeBase,
  | 'id'
  | 'project_id'
  | 'vertical_id'
  | 'hypothesis_id'
  | 'filename'
  | 'columns'
  | 'data'
  | 'source'
>;

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

async function loadTemplateAndBase(db: SupabaseClient, templateId: string): Promise<
  | { ok: true; template: TemplateRow; base: BaseRow }
  | { ok: false; response: NextResponse }
> {
  const { data: templateRow, error: templateError } = await db
    .from('ve_templates')
    .select('id, base_id, vertical_id, letters, personalization_plan, status, launch_info')
    .eq('id', templateId)
    .single();
  if (templateError || !templateRow) {
    return {
      ok: false,
      response: jsonError(
        templateError?.code === 'PGRST116' ? 'Шаблон не найден' : templateError?.message ?? 'Шаблон не найден',
        templateError?.code === 'PGRST116' ? 404 : 500,
      ),
    };
  }
  const template = templateRow as TemplateRow;

  const { data: baseRow, error: baseError } = await db
    .from('ve_bases')
    .select('id, project_id, vertical_id, hypothesis_id, filename, columns, data, source')
    .eq('id', template.base_id)
    .single();
  if (baseError || !baseRow) {
    return {
      ok: false,
      response: jsonError(
        baseError?.code === 'PGRST116' ? 'База шаблона не найдена' : baseError?.message ?? 'База шаблона не найдена',
        baseError?.code === 'PGRST116' ? 404 : 500,
      ),
    };
  }
  const base = baseRow as BaseRow;
  if (template.vertical_id && base.vertical_id && template.vertical_id !== base.vertical_id) {
    return { ok: false, response: jsonError('Шаблон больше не соответствует базе', 409) };
  }
  return { ok: true, template, base };
}

function launchForAudit(template: TemplateRow, audit: VeSegmentationAudit): VeTemplateLaunchInfo | null {
  const launch = parseLaunchInfo(template.launch_info);
  return launch?.segmentation_audit_id === audit.id ? launch : null;
}

function publicAudit(
  audit: VeSegmentationAudit,
  current: boolean,
  launch: VeTemplateLaunchInfo | null,
) {
  return {
    id: audit.id,
    project_id: audit.project_id,
    template_id: audit.template_id,
    base_id: audit.base_id,
    requested_by: audit.requested_by,
    status: audit.status,
    input_hash: audit.input_hash,
    segment_keys: audit.segment_keys,
    summary: audit.summary,
    error: audit.error,
    tokens_used: audit.tokens_used,
    cost_usd: audit.cost_usd,
    completed_at: audit.completed_at,
    launch_status: audit.launch_status ?? 'idle',
    launch_reservation_id: audit.launch_reservation_id ?? null,
    launch_started_at: audit.launch_started_at ?? null,
    launch_heartbeat_at: audit.launch_heartbeat_at ?? null,
    launch_completed_at: audit.launch_completed_at ?? null,
    launch_error: audit.launch_error ?? null,
    launch,
    created_at: audit.created_at,
    updated_at: audit.updated_at,
    current,
  };
}

async function currentLaunchBlocker(
  db: SupabaseClient,
  templateId: string,
): Promise<{ audit: VeSegmentationAudit | null; error: string | null }> {
  const { data: rows, error } = await db
    .from('ve_segmentation_audits')
    .select('*')
    .eq('template_id', templateId)
    .in('launch_status', ['running', 'uncertain'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return { audit: null, error: error.message };
  let audit = ((rows ?? [])[0] as VeSegmentationAudit | undefined) ?? null;
  if (!audit) return { audit: null, error: null };
  if (audit.launch_status === 'running') {
    const reconciled = await reconcileExpiredLaunchReservation(db, audit);
    if (reconciled.error) return { audit: null, error: reconciled.error };
    audit = reconciled.audit;
  }
  return audit.launch_status === 'running' || audit.launch_status === 'uncertain'
    ? { audit, error: null }
    : { audit: null, error: null };
}

function auditCurrent(audit: VeSegmentationAudit, template: TemplateRow, base: BaseRow): boolean {
  return validateStoredAuditSnapshot({ audit, template, base }).state === 'current';
}

function campaignIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 200),
    ),
  ].slice(0, 20);
}

interface RecoveryPortfolioSnapshot {
  instantly_account_id: string;
  mailbox_ids: string[];
  seasonality: NonNullable<VeTemplateLaunchInfo['seasonality']>;
  seasonality_input_hash: string;
  priority_snapshot: NonNullable<VeTemplateLaunchInfo['priority_snapshot']>;
  latest_activation_at: string | null;
  seasonality_confidence: 'low' | 'medium' | 'high';
  potential_pct: number;
  estimated_run_days: number;
}

interface RecoveredCampaignProof {
  campaign_id: string;
  remote_status: typeof CampaignStatus.Paused | typeof CampaignStatus.Completed;
  status_observed_at: string;
}

const RECOVERY_NON_SENDING_STATUSES = new Set<number>([
  CampaignStatus.Paused,
  CampaignStatus.Completed,
]);

async function proveRecoveredCampaignsLive(input: {
  campaignIds: readonly string[];
  instantlyAccountId: string;
  mailboxIds: readonly string[];
}): Promise<
  | { ok: true; proofs: RecoveredCampaignProof[] }
  | { ok: false; response: NextResponse }
> {
  const statusObservedAt = new Date().toISOString();
  const proofs: RecoveredCampaignProof[] = [];

  for (const campaignId of input.campaignIds) {
    let live: Awaited<ReturnType<typeof getCampaign>>;
    try {
      live = await getCampaign(campaignId, {
        accountId: input.instantlyAccountId,
        timeoutMs: 10_000,
        skipRateLimiter: true,
        retryRateLimits: false,
      });
    } catch (error) {
      await logError(
        'tools.vertical-engine-v2.segmentation-audit.recovery_live_proof_failed',
        error,
        { campaignId, instantlyAccountId: input.instantlyAccountId },
      );
      return {
        ok: false,
        response: jsonError(
          'Не удалось подтвердить кампанию в исходном workspace Instantly. Очередь не изменена.',
          502,
          'TEMPLATE_LAUNCH_LIVE_PROOF_FAILED',
        ),
      };
    }

    if (!live || live.id !== campaignId || !RECOVERY_NON_SENDING_STATUSES.has(live.status)) {
      return {
        ok: false,
        response: jsonError(
          'Кампания отсутствует, уже отправляет или имеет неподтверждённый статус. Очередь не изменена.',
          409,
          'TEMPLATE_LAUNCH_REMOTE_STATE_UNSAFE',
        ),
      };
    }

    if (!launchMailboxScopesEqual(live.email_list, input.mailboxIds)) {
      return {
        ok: false,
        response: jsonError(
          'Набор отправителей кампании отличается от неизменяемого снимка запуска.',
          409,
          'TEMPLATE_LAUNCH_MAILBOX_SCOPE_MISMATCH',
        ),
      };
    }

    proofs.push({
      campaign_id: campaignId,
      remote_status: live.status as RecoveredCampaignProof['remote_status'],
      status_observed_at: statusObservedAt,
    });
  }

  return { ok: true, proofs };
}

async function buildRecoveryPortfolioSnapshot(input: {
  portalDb: SupabaseClient;
  template: TemplateRow;
  base: BaseRow;
  presetId: string;
  knownLaunch: VeTemplateLaunchInfo | null;
}): Promise<
  | { ok: true; snapshot: RecoveryPortfolioSnapshot }
  | { ok: false; response: NextResponse }
> {
  let instantlyAccountId = input.knownLaunch?.instantly_account_id?.trim() ?? '';
  let mailboxIds = normalizedMailboxIds(input.knownLaunch?.mailbox_ids);
  if (!instantlyAccountId || mailboxIds.length === 0) {
    if (!supabaseInstantly) {
      return { ok: false, response: jsonError('Instantly database is not configured', 500) };
    }
    const { data: presetRow, error: presetError } = await supabaseInstantly
      .from('client_campaign_presets')
      .select('id, instantly_account_id, email_account_ids')
      .eq('id', input.presetId)
      .maybeSingle();
    if (presetError) {
      return { ok: false, response: jsonError(presetError.message, 500) };
    }
    if (!presetRow) {
      return { ok: false, response: jsonError('Пресет исходного запуска не найден', 409) };
    }
    const preset = presetRow as {
      instantly_account_id?: unknown;
      email_account_ids?: unknown;
    };
    if (!instantlyAccountId) {
      instantlyAccountId = resolveInstantlyAccountId(
        typeof preset.instantly_account_id === 'string' ? preset.instantly_account_id : null,
      );
    }
    if (mailboxIds.length === 0) mailboxIds = normalizedMailboxIds(preset.email_account_ids);
  }
  if (!instantlyAccountId || mailboxIds.length === 0) {
    return {
      ok: false,
      response: jsonError('Не удалось восстановить почтовые аккаунты исходного запуска', 409),
    };
  }
  const estimatedRunDays = input.knownLaunch?.estimated_run_days;
  if (
    typeof estimatedRunDays !== 'number' ||
    !Number.isFinite(estimatedRunDays) ||
    estimatedRunDays <= 0
  ) {
    return {
      ok: false,
      response: jsonError(
        'Не удалось восстановить длительность исходного запуска. Очередь не изменена.',
        409,
        'VE_LAUNCH_TIMING_RUN_DAYS_INVALID',
      ),
    };
  }

  let hypothesisRow: Record<string, unknown> | null = null;
  if (input.base.hypothesis_id) {
    const { data, error } = await input.portalDb
      .from('ve_hypotheses')
      .select('id, seasonality, potential_pct')
      .eq('id', input.base.hypothesis_id)
      .maybeSingle();
    if (error) return { ok: false, response: jsonError(error.message, 500) };
    hypothesisRow = data as Record<string, unknown> | null;
  }
  const { data: verticalRow, error: verticalError } = await input.portalDb
    .from('ve_verticals')
    .select('id, potential_pct')
    .eq('id', input.template.vertical_id)
    .maybeSingle();
  if (verticalError) return { ok: false, response: jsonError(verticalError.message, 500) };

  const fallback = buildLaunchPortfolioMetadata({
    hypothesisId: input.base.hypothesis_id,
    seasonality: input.knownLaunch?.seasonality ?? hypothesisRow?.seasonality,
    hypothesisPotential: input.knownLaunch?.potential_pct ?? hypothesisRow?.potential_pct,
    verticalPotential: (verticalRow as Record<string, unknown> | null)?.potential_pct,
    estimatedRunDays,
  });

  return {
    ok: true,
    snapshot: {
      instantly_account_id: instantlyAccountId,
      mailbox_ids: mailboxIds,
      seasonality: fallback.seasonality,
      seasonality_input_hash:
        input.knownLaunch?.seasonality_input_hash ?? fallback.seasonalityInputHash,
      priority_snapshot: input.knownLaunch?.priority_snapshot ?? fallback.prioritySnapshot,
      latest_activation_at:
        input.knownLaunch?.latest_activation_at === undefined
          ? fallback.latestActivationAt
          : input.knownLaunch.latest_activation_at,
      seasonality_confidence:
        input.knownLaunch?.seasonality_confidence ?? fallback.seasonalityConfidence,
      potential_pct: fallback.potentialPct,
      estimated_run_days: estimatedRunDays,
    },
  };
}

/** POST — persist a pending audit and enqueue its dedicated worker stage. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.segmentation-audit.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      const loaded = await loadTemplateAndBase(supabaseAdmin, id);
      if (!loaded.ok) return loaded.response;
      const { template, base } = loaded;
      if (template.status !== 'ready') {
        return jsonError('Шаблон ещё не готов к аудиту сегментации', 409);
      }
      const blocker = await currentLaunchBlocker(supabaseAdmin, template.id);
      if (blocker.error) return jsonError(blocker.error, 500);
      if (blocker.audit) {
        return NextResponse.json({
          ok: true,
          existing: true,
          blocked_launch: true,
          audit: publicAudit(
            blocker.audit,
            auditCurrent(blocker.audit, template, base),
            launchForAudit(template, blocker.audit),
          ),
          job: null,
        });
      }
      const snapshot = prepareAuditSnapshot(template, base);
      if (snapshot.audience.leads.length > VE_LAUNCH_MAX_LEADS) {
        return jsonError(
          `После фильтров к запуску готов ${snapshot.audience.leads.length.toLocaleString('ru-RU')} получатель. Лимит одного запуска — ${VE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')}.`,
          413,
        );
      }

      const { data: enqueueData, error: enqueueError } = await supabaseAdmin.rpc(
        've_enqueue_segmentation_audit',
        {
          p_project_id: base.project_id,
          p_template_id: template.id,
          p_base_id: base.id,
          p_requested_by: userId,
        },
      );
      if (enqueueError) {
        await logError('tools.vertical-engine-v2.segmentation-audit.create_failed', enqueueError, {
          userId,
          templateId: id,
        });
        return jsonError(enqueueError.message, 500);
      }
      const rawResult = Array.isArray(enqueueData) ? enqueueData[0] : enqueueData;
      const result = rawResult && typeof rawResult === 'object'
        ? (rawResult as Record<string, unknown>)
        : null;
      const audit = result?.audit_row as VeSegmentationAudit | undefined;
      const job = result?.job_row;
      const created = result?.created === true;
      if (!audit || !job || typeof job !== 'object') {
        return jsonError('Очередь аудита вернула неполный результат', 500);
      }
      if (audit.status === 'failed' || audit.status === 'cancelled') {
        return jsonError(
          audit.error ?? 'Предыдущая задача аудита завершилась. Повторите проверку.',
          409,
        );
      }

      if (created) {
        void logAudit(
          'tools.vertical-engine-v2.segmentation-audit.enqueued',
          'Vertical Engine v2 segmentation audit enqueued',
          {
            userId,
            templateId: id,
            baseId: base.id,
            auditId: audit.id,
            jobId: (job as { id?: unknown }).id,
          },
        );
      }
      return NextResponse.json(
        {
          ok: true,
          existing: !created,
          audit: publicAudit(
            audit,
            auditCurrent(audit, template, base),
            launchForAudit(template, audit),
          ),
          job,
        },
        { status: created ? 201 : 200 },
      );
    },
  );
}

/** GET — latest audit summary.  Row assignments never cross the API boundary. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.segmentation-audit.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      const loaded = await loadTemplateAndBase(supabaseAdmin, id);
      if (!loaded.ok) return loaded.response;

      const blocker = await currentLaunchBlocker(supabaseAdmin, id);
      if (blocker.error) return jsonError(blocker.error, 500);
      let audit = blocker.audit;
      if (!audit) {
        const { data: rows, error } = await supabaseAdmin
          .from('ve_segmentation_audits')
          .select('*')
          .eq('template_id', id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (error) return jsonError(error.message, 500);
        audit = ((rows ?? [])[0] as VeSegmentationAudit | undefined) ?? null;
      }
      if (!audit) return jsonError('Аудит сегментации ещё не запускался', 404);

      const validation = validateStoredAuditSnapshot({
        audit,
        template: loaded.template,
        base: loaded.base,
      });
      return NextResponse.json({
        audit: publicAudit(
          audit,
          validation.state === 'current',
          launchForAudit(loaded.template, audit),
        ),
      });
    },
  );
}

/**
 * PATCH — explicit specialist reconciliation for an uncertain external launch.
 * The reservation is claimed with CAS first; a crash keeps/recreates the
 * fail-closed blocker instead of silently allowing a duplicate campaign.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.segmentation-audit.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const auditId = typeof body?.audit_id === 'string' ? body.audit_id.trim() : '';
      const launchReservationId =
        typeof body?.launch_reservation_id === 'string'
          ? body.launch_reservation_id.trim()
          : '';
      const resolution = typeof body?.resolution === 'string' ? body.resolution : '';
      if (!auditId) return jsonError('Укажите audit_id', 400);
      if (!launchReservationId) return jsonError('Укажите launch_reservation_id', 400);
      if (body?.confirm !== true) return jsonError('Подтвердите результат сверки', 400);
      if (resolution !== 'no_campaign' && resolution !== 'campaign_created') {
        return jsonError('Неизвестный способ разрешения запуска', 400);
      }

      const loaded = await loadTemplateAndBase(supabaseAdmin, id);
      if (!loaded.ok) return loaded.response;
      const { template, base } = loaded;
      const { data: auditRow, error: auditError } = await supabaseAdmin
        .from('ve_segmentation_audits')
        .select('*')
        .eq('id', auditId)
        .eq('template_id', id)
        .maybeSingle();
      if (auditError) return jsonError(auditError.message, 500);
      if (!auditRow) return jsonError('Аудит сегментации не найден', 404);

      let audit = auditRow as VeSegmentationAudit;
      if (audit.launch_status === 'running') {
        const reconciled = await reconcileExpiredLaunchReservation(supabaseAdmin, audit);
        if (reconciled.error) return jsonError(reconciled.error, 500);
        audit = reconciled.audit;
      }
      if (audit.launch_status === 'running') {
        return NextResponse.json(
          {
            error: 'Запуск ещё выполняется. Дождитесь результата перед сверкой.',
            code: 'TEMPLATE_LAUNCH_IN_PROGRESS',
          },
          { status: 409 },
        );
      }
      if (audit.launch_status !== 'uncertain') {
        return NextResponse.json(
          {
            error: 'Этот запуск уже разрешён или не требует сверки.',
            code: 'TEMPLATE_LAUNCH_ALREADY_RESOLVED',
          },
          { status: 409 },
        );
      }
      if (audit.launch_reservation_id !== launchReservationId) {
        return NextResponse.json(
          {
            error: 'Эта вкладка относится к другой попытке запуска. Обновите проверку.',
            code: 'TEMPLATE_LAUNCH_ALREADY_RESOLVED',
          },
          { status: 409 },
        );
      }
      const knownLaunch = launchForAudit(template, audit);
      if (resolution === 'no_campaign' && knownLaunch) {
        return NextResponse.json(
          {
            error:
              'Portal уже сохранил созданную кампанию. Подтвердите найденные ID, а не повторный запуск.',
            code: 'TEMPLATE_LAUNCH_KNOWN_CAMPAIGN',
          },
          { status: 409 },
        );
      }

      const knownCampaigns = knownLaunch?.campaigns?.length
        ? knownLaunch.campaigns
        : knownLaunch
          ? [
              {
                campaign_id: knownLaunch.campaign_id,
                campaign_name: knownLaunch.campaign_name,
                campaign_url: knownLaunch.campaign_url,
                segment: null,
                leads_count: knownLaunch.leads_count,
              },
            ]
          : [];
      const requestedIds = campaignIds(body?.campaign_ids);
      const resolvedIds = [
        ...new Set([
          ...knownCampaigns.map((campaign) => campaign.campaign_id),
          ...requestedIds,
        ]),
      ];
      if (resolution === 'campaign_created' && resolvedIds.length === 0) {
        return jsonError('Укажите хотя бы один ID кампании из Instantly', 400);
      }
      const presetId = audit.launch_preset_id || knownLaunch?.preset_id || '';
      if (resolution === 'campaign_created' && !presetId) {
        return jsonError('Не удалось определить пресет исходного запуска', 409);
      }
      let portfolioSnapshot: RecoveryPortfolioSnapshot | null = null;
      if (resolution === 'campaign_created') {
        const recoveredSnapshot = await buildRecoveryPortfolioSnapshot({
          portalDb: supabaseAdmin,
          template,
          base,
          presetId,
          knownLaunch,
        });
        if (!recoveredSnapshot.ok) return recoveredSnapshot.response;
        portfolioSnapshot = recoveredSnapshot.snapshot;
      }

      let campaignProofs: RecoveredCampaignProof[] = [];
      if (resolution === 'campaign_created') {
        const liveProof = await proveRecoveredCampaignsLive({
          campaignIds: resolvedIds,
          instantlyAccountId: portfolioSnapshot!.instantly_account_id,
          mailboxIds: portfolioSnapshot!.mailbox_ids,
        });
        if (!liveProof.ok) return liveProof.response;
        campaignProofs = liveProof.proofs;
      }

      const knownById = new Map(knownCampaigns.map((campaign) => [campaign.campaign_id, campaign]));
      const proofById = new Map(campaignProofs.map((proof) => [proof.campaign_id, proof]));
      const recoveredCampaigns = resolvedIds.map((campaignId, index) => {
        const known = knownById.get(campaignId);
        const proof = proofById.get(campaignId);
        return {
          campaign_id: campaignId,
          campaign_name:
            known?.campaign_name ||
            `${buildLaunchCampaignName(base.filename, new Date())} · восстановлено ${index + 1}`,
          campaign_url: known?.campaign_url || instantlyCampaignUrl(campaignId),
          segment: known?.segment ?? null,
          leads_count: known?.leads_count ?? 0,
          ...(proof
            ? {
                remote_status: proof.remote_status,
                status_observed_at: proof.status_observed_at,
              }
            : {}),
        };
      });
      const primary = recoveredCampaigns[0];
      const resolvedAt = new Date().toISOString();
      const launchInfo: VeTemplateLaunchInfo | null =
        resolution === 'campaign_created' && primary
          ? {
              campaign_id: primary.campaign_id,
              campaign_name: primary.campaign_name,
              campaign_url: primary.campaign_url,
              leads_count: recoveredCampaigns.reduce(
                (sum, campaign) => sum + campaign.leads_count,
                0,
              ),
              preset_id: presetId,
              created_at: knownLaunch?.created_at || audit.launch_started_at || resolvedAt,
              ...portfolioSnapshot!,
              segmentation_audit_id: audit.id,
              ...(audit.input_hash ? { segmentation_audit_input_hash: audit.input_hash } : {}),
              campaigns: recoveredCampaigns,
            }
          : null;
      const { data: resolveData, error: resolveError } = await supabaseAdmin.rpc(
        've_resolve_template_launch',
        {
          p_audit_id: audit.id,
          p_template_id: template.id,
          p_launch_reservation_id: launchReservationId,
          p_resolution: resolution,
          p_launch_info: launchInfo,
          p_resolved_by: userId,
          p_resolution_id: randomUUID(),
          p_now: resolvedAt,
        },
      );
      if (resolveError) {
        const knownCampaignRace = /known campaign exists/i.test(resolveError.message);
        await logError(
          'tools.vertical-engine-v2.segmentation-audit.launch_resolution_failed',
          resolveError,
          { userId, templateId: id, auditId: audit.id },
        );
        return NextResponse.json(
          {
            error: knownCampaignRace
              ? 'Portal уже сохранил созданную кампанию. Обновите проверку.'
              : resolveError.message,
            ...(knownCampaignRace ? { code: 'TEMPLATE_LAUNCH_KNOWN_CAMPAIGN' } : {}),
          },
          { status: knownCampaignRace ? 409 : 500 },
        );
      }
      const rawResolve = Array.isArray(resolveData) ? resolveData[0] : resolveData;
      const result = rawResolve && typeof rawResolve === 'object'
        ? (rawResolve as Record<string, unknown>)
        : null;
      if (result?.resolved !== true || !result.audit_row) {
        return NextResponse.json(
          {
            error: 'Состояние запуска уже изменилось. Обновите проверку.',
            code: 'TEMPLATE_LAUNCH_ALREADY_RESOLVED',
          },
          { status: 409 },
        );
      }
      const resolved = result.audit_row as VeSegmentationAudit;
      if (launchInfo) template.launch_info = launchInfo;
      void logAudit(
        resolution === 'campaign_created'
          ? 'tools.vertical-engine-v2.segmentation-audit.launch_resolved_created'
          : 'tools.vertical-engine-v2.segmentation-audit.launch_resolved_absent',
        resolution === 'campaign_created'
          ? 'Vertical Engine v2 uncertain launch resolved with campaign ids'
          : 'Vertical Engine v2 uncertain launch resolved as absent',
        { userId, templateId: id, auditId: audit.id, campaignIds: resolvedIds },
      );
      return NextResponse.json({
        ok: true,
        audit: publicAudit(
          resolved,
          auditCurrent(resolved, template, base),
          launchInfo,
        ),
      });
    },
  );
}
